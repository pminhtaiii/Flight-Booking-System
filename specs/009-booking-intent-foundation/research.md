# Research: Booking Intent Foundation
**Feature**: 009-booking-intent-foundation
**Date**: 2026-07-10
**Source**: Grilling session + codebase analysis

---

## R1: Intent Storage Strategy

**Decision**: Dedicated `BookingIntent` + `BookingIntentPassenger` PostgreSQL tables, separate from the existing `Booking` table.

**Rationale**:
- The `Booking` table stays clean — every row = a real paid booking.
- No `EXPIRED`/`ABANDONED` noise in queries, analytics, or agent gateway `list_user_bookings`.
- Follows existing pattern: `FlightOffer` (temporary/cached) vs. `Booking` (permanent).

**Alternatives considered**:
- Reusing `Booking` table with extra statuses → pollutes analytics, complicates queries.
- Redis-only storage → no ACID, PII in volatile memory, no audit trail.
- Stateless (client-side only) → PII on client, no server control, more API calls.

---

## R2: PII Security for Passenger Data

**Decision**: Encrypt passport number and expiry with AES-256-GCM at application layer, same pattern as `TravelerProfile`.

**Rationale**:
- Reuses proven encryption pattern already in the codebase.
- Per-field encryption enables selective decryption (only decrypt for the owning user).
- Meets GDPR and data protection requirements.

**Implementation reference**: The `TravelerProfile` model already marks `passportNumber` and `passportExpiry` with `@encrypted` doc comments. Same approach applies to `BookingIntentPassenger`.

---

## R3: Abandoned Intent Cleanup

**Decision**: Two-phase lifecycle — PENDING → EXPIRED (soft, after TTL) → deleted (hard, after grace period).

**Rationale**:
- Direct deletion creates a race condition: cron deletes intent while Stripe webhook arrives → money lost, no ticket.
- Soft expiry keeps the row available for conflict resolution.
- Grace period (24h) ensures all in-flight payments resolve before hard delete.
- Follows existing cron pattern from `FlightOffer` daily retention cleanup.

**Concurrency guard (atomic claim)**: The race between the Phase 1 cron and Feature B's payment webhook is closed with a compare-and-swap on `status`, not with locking:
- Phase 1 cron expiry runs as a single conditional update: `UPDATE booking_intents SET status = 'EXPIRED', updatedAt = now() WHERE status = 'PENDING' AND createdAt < (now() - TTL)`. It can only ever move a row *out of* `PENDING`; it never matches rows already in `COMPLETED` or `EXPIRED`.
- Feature B's payment webhook must claim the intent the same way: `UPDATE booking_intents SET status = 'COMPLETED', ... WHERE id = ? AND status = 'PENDING'`.
- Whichever writer's `WHERE status = 'PENDING'` predicate matches first wins the row; the other writer's update affects zero rows.
  - If the cron wins: the webhook's update affects 0 rows, and Feature B's conflict-resolution path (re-validate against the now-`EXPIRED` intent — typically re-create a fresh intent or fail the payment) takes over.
  - If the webhook wins: the cron's `WHERE status = 'PENDING'` predicate no longer matches that row on its next (or a concurrent) run — a silent no-op for that intent, not an error, and it needs no retry.
- No explicit row lock or distributed lock is required; correctness follows entirely from both writers sharing the same `WHERE status = 'PENDING'` guard.

**Alternatives considered**:
- Direct hard-delete → race condition risk with in-flight payments.
- Soft-delete only (never hard-delete) → unbounded table growth.

**Configuration (recommended)**:
- PENDING → EXPIRED TTL: 30 minutes (configurable via env var)
- EXPIRED → hard delete grace period: 24 hours
- Phase 1 cron: every 5 minutes
- Phase 2 cron: daily

---

## R4: Duffel Re-Pricing Strategy

**Decision**: Re-price at intent creation, not at payment time.

**Rationale**:
- User should never be surprised by a price change after committing to the flow.
- The `getFlightDetail` method already calls `duffel.offers.get()` — same API for re-pricing.
- Store `pricedAt` timestamp so Feature B can calculate staleness and re-price if needed.
- The `duffelOfferId` passed to `offers.get()` always comes from the `FlightOffer` row looked up by `flightOfferId`, never from client input — see [api.md](./contracts/api.md) → `POST /bookings/intent`.

**Duffel API reference**: `this.duffelService['duffel'].offers.get(duffelOfferId)` returns live offer with current pricing, conditions, and availability.

**Constraint for Feature B**: Must re-validate pricing before payment if `pricedAt` is older than a staleness threshold (e.g., 15 minutes).

---

## R5: Pre-Fill from TravelerProfile

**Decision**: Snapshot copy at intent creation for the primary passenger only.

**Rationale**:
- Profile changes after intent creation don't silently alter booking data.
- Data is locked in at submission time — no reference resolution at payment time.
- Optional `travelerProfileId` FK on passenger row provides audit trail.

**Scope limitation**: Only the primary passenger (logged-in user) gets pre-filled. Companion profiles (SavedTraveler refactor) deferred to separate feature.

**Implementation note**: "Primary passenger" is the `BookingIntentPassenger` with `position = 0` — identified structurally, not by re-inspecting array order at read time (see [data-model.md](./data-model.md) → `BookingIntentPassenger.position`).

---

## R6: Validation Strategy

**Decision**: All business rules enforced in NestJS service/DTO layer, not DB constraints.

**Rationale**:
- DB constraints are binary (`NOT NULL`); cannot express conditional rules.
- Examples of conditional rules:
  - Passport required only for international routes (future consideration).
  - Infants ≤ adults.
  - Total passengers ≤ 9.
  - Each adult passenger must have given name + family name.
- Database keeps fields nullable; application enforces context-aware rules.

---

## R7: GDPR Considerations

**Decision**: Flag as compliance question; design supports cascading deletion. `COMPLETED` intents get a concrete default retention period pending legal confirmation.

**Key points**:
- Snapshot creates a second PII copy in `BookingIntentPassenger` — subject to its own erasure obligations, independent of `TravelerProfile`.
- Whether completed bookings are exempt as transaction records is a legal call.
- System design: `BookingIntentPassenger` cascades on `BookingIntent` delete. `BookingIntent` can be deleted independently of `TravelerProfile` (the `travelerProfileId` link is `onDelete: SetNull`).
- Retention policy for intent rows is separate from `TravelerProfile` retention: `TravelerProfile` is governed by the user's account lifecycle (deleted on account deletion or an explicit erasure request), while a `BookingIntentPassenger` snapshot is an independent copy unaffected by that deletion (no cascade from `TravelerProfile`).

**Recommended retention for `COMPLETED` intents** (default, not yet legally confirmed):
- Retain `COMPLETED` `BookingIntent` + `BookingIntentPassenger` rows for 7 years from the completion date, in line with common financial/tax record-keeping windows for transaction records. This must be confirmed against the applicable jurisdiction(s) before Feature B ships to production.
- A dedicated retention cron (separate from the Phase 1/Phase 2 cleanup in R3 above, which only ever touches `PENDING`/`EXPIRED` rows) hard-deletes `COMPLETED` rows once the retention window elapses.
- As an earlier, optional step within that window, passport fields (`passportNumber`, `passportExpiry`) may be nulled out once they're no longer operationally needed (e.g., shortly after travel completes) without deleting the rest of the record. The exact anonymization threshold is a follow-up decision for Feature C.
- This is a starting recommendation to unblock design, not a legal determination.