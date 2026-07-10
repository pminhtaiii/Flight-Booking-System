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
**Decision**: Flag as compliance question; design supports cascading deletion.
**Key points**:
- Snapshot creates a second PII copy in `BookingIntentPassenger` — subject to its own erasure obligations.
- Whether completed bookings are exempt as transaction records is a legal call.
- System design: `BookingIntentPassenger` cascades on `BookingIntent` delete. `BookingIntent` can be deleted independently of `TravelerProfile`.
- Retention policy for intent rows is separate from profile retention.