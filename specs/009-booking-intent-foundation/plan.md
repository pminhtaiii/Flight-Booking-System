# Implementation Plan: Booking Intent Foundation
**Branch**: `009-booking-intent-foundation` | **Date**: 2026-07-10 | **Spec**: [spec.md](./spec.md)
**Input**: Grilling session decisions from [research](./research.md)

> **Context**: This feature creates the transactional foundation for the booking workflow. The flight search pipeline (Duffel integration, caching, passenger types, cabin classes) is complete. This plan adds the "booking intent" — a server-side, encrypted, time-limited record that bridges flight selection and payment. Payment processing (Feature B) and bookings management (Feature C) are deferred.

## Summary

Create a dedicated `BookingIntent` + `BookingIntentPassenger` data model with a `BookingIntentModule` in NestJS. The module pre-fills primary passenger data from `TravelerProfile` before validation, validates passenger details, calls Duffel to re-confirm pricing, creates encrypted intent records, and manages a two-phase cleanup lifecycle (PENDING → EXPIRED → deleted) via scheduled cron jobs.

## Technical Context

**Language/Version**: TypeScript / Node.js
**Primary Dependencies**: NestJS, Prisma, Redis (caching only), Duffel API (`@duffel/api` SDK)
**Storage**: PostgreSQL (2 new tables + 2 new enums), AES-256-GCM encryption for PII
**Testing**: Jest (backend E2E)
**Target Platform**: Web application (API only — no frontend in this feature)
**Performance Goals**: Intent creation (including Duffel re-pricing) < 5 seconds
**Constraints**: Duffel rate limit (120 req/60s), PII encryption mandatory, GDPR-aware retention lifecycle

## Constitution Check

*GATE: Passed.*

- **I. Flight-First Architecture**: ✅ This IS the core flight booking pipeline. Intent creation is the direct bridge between search and payment.
- **II. Deterministic Transaction Boundary**: ✅ Entire flow is deterministic. No AI involvement. Duffel re-pricing is a deterministic API call. All state transitions are auditable.
- **III. API Budget Discipline**: ✅ One Duffel `offers.get()` call per intent creation (re-pricing). This is a justified user-facing action — the user explicitly clicked "Book." No speculative API calls.
- **IV. Observability & Operational Visibility**: ✅ Audit logs for every lifecycle event (created, expired, deleted). Structured logging for cron runs. Cron metrics (intents expired/deleted per run).
- **V. Incremental Delivery**: ✅ Feature A is independently deployable. The API endpoints work without Feature B. Intent creation → retrieval → cleanup is a self-contained slice.

## Project Structure

### Documentation (this feature)

```text
specs/009-booking-intent-foundation/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Architectural decisions from grilling
├── data-model.md        # Schema definitions
├── quickstart.md        # Validation scenarios
├── contracts/
│   └── api.md           # API endpoint contracts
└── tasks.md             # Phase 2 output (created by /speckit-tasks)
```

### Source Code Changes

```text
apps/api/
├── prisma/
│   └── schema.prisma                    # MODIFIED: +BookingIntent, +BookingIntentPassenger, +enums
├── src/
│   ├── booking-intent/                  # NEW: entire module
│   │   ├── booking-intent.module.ts     # NEW: NestJS module definition
│   │   ├── booking-intent.controller.ts # NEW: REST endpoints
│   │   ├── booking-intent.service.ts    # NEW: business logic + Duffel re-pricing
│   │   ├── booking-intent.cron.ts       # NEW: two-phase cleanup cron jobs
│   │   └── dto/
│   │       ├── create-intent.dto.ts     # NEW: request DTO with validation
│   │       └── intent-response.dto.ts   # NEW: response DTOs
│   ├── common/
│   │   └── encryption.service.ts        # NEW: shared AES-256-GCM encryption utility
│   └── app.module.ts                    # MODIFIED: register BookingIntentModule
└── test/
    └── booking-intent.e2e-spec.ts       # NEW: E2E tests
packages/shared/
└── src/
    └── types/
        └── booking-intent.types.ts      # NEW: shared types (BookingIntentStatus, PassengerType)
```

**Structure Decision**: New `booking-intent/` module under `apps/api/src/`, following the same pattern as `flights/`, `auth/`, `chat/`, etc. Encryption utility extracted into `common/` since both `BookingIntentService` and the future `TravelerProfile` management will need it.

---

## Implementation Phases

### Phase 1: Database Schema & Encryption Foundation

> **Foundation** — schema and encryption must be in place before any service code.
> **Estimated scope**: ~3 files modified/created + 1 migration

| Task | Status | Notes |
|------|--------|-------|
| Add `BookingIntentStatus` and `PassengerType` enums to `schema.prisma` | ☐ | `PENDING/EXPIRED/COMPLETED` and `ADULT/CHILD/INFANT` |
| Add `BookingIntent` model to `schema.prisma` | ☐ | See [data-model.md](./data-model.md) for full field list |
| Add `BookingIntentPassenger` model to `schema.prisma` | ☐ | Cascade delete from `BookingIntent`; includes required `position` field for stable ordering |
| Add `bookingIntents BookingIntent[]` relation to `User` model | ☐ | One-to-many |
| Add `bookingIntentPassengers BookingIntentPassenger[]` relation to `TravelerProfile` model | ☐ | Required back-relation for the new `BookingIntentPassenger.travelerProfile` FK (see [data-model.md](./data-model.md) → Relationship to Existing Models) |
| Run `npx prisma migrate dev` and verify client types | ☐ | Generate migration |
| Create `common/encryption.service.ts` — AES-256-GCM encrypt/decrypt utility | ☐ | Injectable NestJS service; reads `ENCRYPTION_KEY` env var, decodes as hex, and throws at startup if the decoded length is not exactly 32 bytes |
| Add shared types to `packages/shared/src/types/booking-intent.types.ts` | ☐ | `BookingIntentStatus`, `PassengerType` enums |

**Exit criteria**: Migration applied, both tables exist, the `User` and `TravelerProfile` back-relations resolve, Prisma client types generated, encryption service works with AES-256-GCM and rejects invalid key lengths at startup.

---

### Phase 2: BookingIntentModule — Core Service & DTOs

> **Core business logic** — validation, Duffel re-pricing, intent creation with encrypted PII.
> **Estimated scope**: ~6 files created

| Task | Status | Notes |
|------|--------|-------|
| Create `create-intent.dto.ts` with class-validator decorators | ☐ | Passenger array, cross-field validation (infants ≤ adults, total ≤ 9) |
| Create `intent-response.dto.ts` for creation and retrieval responses | ☐ | Separate creation vs. detail shapes (passport excluded from creation response) |
| Create `booking-intent.service.ts` | ☐ | Core logic: look up `FlightOffer` by `flightOfferId` (source of truth for `duffelOfferId`, route, dates) → apply TravelerProfile pre-fill to the primary adult when requested → validate merged passenger data → re-price via Duffel → encrypt PII → create intent + passengers (with `position`) and audit row in a single transaction |
| Implement TravelerProfile pre-fill logic | ☐ | If `useProfile: true` on primary adult, merge profile data into passenger fields before validation so the validator sees the effective request shape |
| Implement Duffel re-pricing (reuse `duffel.offers.get()` pattern) | ☐ | Use the looked-up `FlightOffer`'s stored `duffelOfferId` — never a client-supplied value. Same approach as `getFlightDetail()`: call Duffel, snapshot the response |
| Create `booking-intent.controller.ts` with `POST /bookings/intent`, `GET /bookings/intent/:id`, `GET /bookings/intent/prefill` | ☐ | JWT-guarded, ownership enforcement |
| Create `booking-intent.module.ts` and register in `app.module.ts` | ☐ | Import PrismaModule, DuffelModule, AuditModule |
| Add audit logging for `booking_intent_created` | ☐ | Structured metadata: intentId, userId, offerId, passengerCount, priceChanged; write the audit row inside the same Prisma transaction as intent creation |

**Exit criteria**: All 3 endpoints work. Intent creation validates passengers, re-prices via Duffel using the `FlightOffer`'s own `duffelOfferId`, encrypts PII, creates DB records in a transaction, and returns confirmed pricing. Retrieval decrypts passport data for the owning user. Pre-fill returns TravelerProfile data.

---

### Phase 3: Two-Phase Cron Cleanup

> **Data hygiene** — prevents abandoned intents from polluting the database.
> **Estimated scope**: ~2 files created/modified

| Task | Status | Notes |
|------|--------|-------|
| Create `booking-intent.cron.ts` with `@nestjs/schedule` | ☐ | Two cron methods: Phase 1 (soft expire) and Phase 2 (hard delete) |
| Phase 1 cron: `PENDING` → `EXPIRED` when `intentExpiresAt` < now | ☐ | Atomic conditional update (`WHERE status = 'PENDING'`); expiration deadline is stored at creation from `BOOKING_INTENT_TTL_MINUTES`; see [research.md](./research.md) → R3 |
| Phase 2 cron: hard-delete `EXPIRED` rows when `updatedAt` + grace < now | ☐ | Grace period configurable via `BOOKING_INTENT_GRACE_HOURS` env var |
| Cascade delete verification: `BookingIntentPassenger` rows deleted with intent | ☐ | Prisma `onDelete: Cascade` handles this |
| Structured logging for each cron run | ☐ | Count of intents expired, count deleted, duration |
| Audit log entries for `booking_intent_expired` and `booking_intent_deleted` | ☐ | Batch audit log with intent IDs |
| Register `ScheduleModule` in `BookingIntentModule` if not already registered | ☐ | `@nestjs/schedule` may already be in `AppModule` from FlightOffer cron |

**Exit criteria**: Both cron phases run on schedule. PENDING intents expire after TTL via the atomic conditional update (never touching `COMPLETED` rows). EXPIRED intents are hard-deleted after grace period. Cascading delete removes passenger rows. All operations logged and audited.

---

### Phase 4: E2E Testing & Verification

> **Quality gate** — comprehensive tests for the entire feature.
> **Estimated scope**: ~1 test file created

| Task | Status | Notes |
|------|--------|-------|
| E2E: Create intent with valid passengers (201) | ☐ | Verify response shape, DB records, encrypted passport data |
| E2E: Create intent with pre-fill from TravelerProfile | ☐ | Verify profile data merged into passenger |
| E2E: Validation — infants > adults (400) | ☐ | Cross-field validation |
| E2E: Validation — total passengers > 9 (400) | ☐ | Cross-field validation |
| E2E: Validation — passenger count mismatch (400) | ☐ | Array length ≠ declared breakdown |
| E2E: Retrieve own intent (200) | ☐ | Verify decrypted passport data in response |
| E2E: Retrieve other user's intent (403) | ☐ | Ownership enforcement |
| E2E: Retrieve expired intent (410) | ☐ | Status = EXPIRED → 410 Gone |
| E2E: Pre-fill endpoint with profile (200) | ☐ | Verify `hasProfile: true`, profile data, and missing fields |
| E2E: Pre-fill endpoint without profile (200) | ☐ | Verify `hasProfile: false` and missing fields |
| E2E: Audit write failure rolls back intent creation | ☐ | Force `booking_intent_created` insert to fail, verify both the intent and audit row are rolled back |
| E2E: Cron Phase 1 — PENDING → EXPIRED | ☐ | Artificially age intent, trigger cron, verify status change |
| E2E: Cron Phase 2 — EXPIRED → deleted | ☐ | Artificially age expired intent, trigger cron, verify deletion + cascade |
| E2E: Duffel offer expired during re-pricing (410) | ☐ | Mock Duffel 404/410, verify error response |
| E2E: client-supplied `duffelOfferId` is ignored | ☐ | Send a mismatched `duffelOfferId` in the request body and confirm the server still re-prices the `FlightOffer`'s own Duffel offer, not the client's |
| Regression: existing flight search E2E tests still pass | ☐ | No breakage from schema changes |

**Exit criteria**: All E2E tests pass, including the `duffelOfferId` override attempt being ignored. No regression on existing functionality. Encryption verified in DB. Cron lifecycle validated end-to-end.

---

## Environment Variables

| Variable | Default | Required | Notes |
|----------|---------|----------|-------|
| `ENCRYPTION_KEY` | — | Yes | 64-character hexadecimal string that decodes to exactly 32 bytes (256 bits) for AES-256-GCM. The encryption service must decode and validate this at startup and refuse to start if the decoded length is not exactly 32 bytes |
| `BOOKING_INTENT_TTL_MINUTES` | `30` | No | Minutes before a `PENDING` intent's stored `intentExpiresAt` deadline is reached and Phase 1 cleanup can mark it `EXPIRED` |
| `BOOKING_INTENT_GRACE_HOURS` | `24` | No | Hours before an `EXPIRED` intent is hard-deleted |

**Existing variables** (unchanged):
- `DUFFEL_ACCESS_TOKEN` — used for re-pricing via `offers.get()`
- `DATABASE_URL` — PostgreSQL connection string

---

## Verification Plan

### Automated Tests

```bash
# Backend E2E — booking intent tests
npm run test:e2e --workspace=apps/api -- --testPathPattern=booking-intent

# Regression — full E2E suite
npm run test:e2e --workspace=apps/api

# Prisma schema validation
npx prisma validate --schema=apps/api/prisma/schema.prisma
```

### Manual Verification

- Create a booking intent via curl with 2 passengers → verify 201 + DB records
- Check `booking_intent_passengers` table → verify passport fields are encrypted (not plaintext) and `position` is set per row
- Retrieve the intent → verify passport data is decrypted in response
- Try accessing another user's intent → verify 403
- Attempt to create an intent with a mismatched `duffelOfferId` in the request body → verify the server ignores it and re-prices the `FlightOffer`'s actual Duffel offer
- Wait 30+ minutes (or adjust TTL) → verify cron marks intent as EXPIRED
- Wait 24+ hours (or adjust grace period) → verify cron hard-deletes the intent + passengers
- Run flight search E2E tests → verify no regression

---

## Complexity Tracking

No constitution violations. All design decisions align with existing patterns:
- Schema follows Prisma conventions used throughout the project
- Encryption follows the TravelerProfile AES-256-GCM pattern
- Cron follows the FlightOffer retention cleanup pattern
- Module structure follows the NestJS module pattern used by flights, auth, chat, etc.