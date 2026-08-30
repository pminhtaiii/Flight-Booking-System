# Research: Bookings Management & Confirmation

**Feature**: 011-booking-management | **Date**: 2026-07-19

## Research Tasks

### R1: Booking Record Lifecycle — When to Create

**Decision**: Create at the start of `POST /payments/confirm`, NOT at `/payments/create`.

**Rationale**: Cart abandonment in travel is 60–80%. Creating records at `/payments/create` pollutes the bookings table with orphaned `PROCESSING` records for users who never complete payment — the exact problem `BookingIntent` with TTL cleanup solved.

**Alternatives considered**:

- Create at `/payments/create` → rejected (abandonment pollution)
- Create after pipeline completes → rejected (client needs bookingId for escape hatch before response arrives)

### R2: Client-Generated UUID Pattern

**Decision**: Client generates UUID v4 and sends it as `bookingId` in the confirm request. Server uses it as PK.

**Rationale**: In Approach A (synchronous pipeline), the HTTP response doesn't arrive until pipeline completes (3–30s). The checkout loading escalation's escape hatch needs a concrete `/bookings/[bookingId]` URL before the response. Client-generated UUID gives the client the ID before the request fires.

**Security validation required**:

1. Format validation (must be valid UUID v4)
2. Uniqueness check (SELECT before INSERT)
3. Ownership check (if exists, must belong to same user → 403 if not)
4. Same-user duplicate → idempotency replay
5. Concurrency control: Catch DB-level unique primary key constraint violations (e.g., Prisma error P2002) to handle double-submit race conditions gracefully by running the same ownership/idempotency checks rather than failing with 500.

**Alternatives considered**:

- Two-phase confirm (init + execute) → rejected (two requests, complex idempotency)
- Use BookingIntentId for escape hatch → rejected (indirect lookup, messy URL)

### R3: Synchronous vs Async Pipeline UX

**Decision**: Approach A — synchronous pipeline with 4-phase loading escalation. No SSE, no background jobs.

**Key finding**: Approach C (synchronous + parallel SSE via EventEmitter2) was initially attractive but has a critical flaw: EventEmitter2 is in-memory, so POST and SSE connections must hit the same process. On multi-replica deployments, they silently degrade with no error signal. Swapping to Redis Pub/Sub fixes this but erodes the simplicity advantage.

**Design for upgrade**: Named steps in the loading component (`AUTHORIZING → RESERVING → FINALIZING → CONFIRMED`) allow future SSE upgrade to swap triggers from timed transitions to real events without UI rework.

### R4: Failure Category Design

**Decision**: `failureReason` determines retry routing. `Payment.status` determines charge messaging. Two independent data sources, never conflated.

**Key finding**: `PAYMENT_DECLINED` cannot exist as a booking failure category. Card declines happen during Stripe Elements confirmation (client-side), BEFORE `/payments/confirm` is called, BEFORE the Booking record exists. Removed from the failure enum.

**Key finding**: "No charge was made" must be verified against `Payment.status`, not assumed from `failureReason`. Authorization voids can fail, leaving a live hold. The message must reflect reality.

### R5: Flight Data Storage Strategy

**Decision**: Snapshot at booking time. Store complete flight details as structured JSON on the Booking record during PNR creation.

**Rationale**: A confirmed booking is a historical record. Flight details at purchase time are contractual facts. The detail page must load from local DB with zero external API calls — Duffel availability, rate limits, and latency must not affect a page showing data the user already paid for.

**Alternatives considered**:

- Fetch from Duffel on demand → rejected (external dependency at render time)
- Snapshot + optional refresh → rejected (complexity, deferred to future feature)

### R6: Existing Codebase Patterns

**Findings from existing modules**:

- **NestJS module pattern**: Follow `PaymentModule` structure (module, controller, service, DTOs)
- **Prisma schema**: Extend existing schema with new Booking model, enums, relations
- **Frontend pattern**: Next.js App Router pages in `apps/web/app/`, components in `apps/web/components/`
- **Shared types**: Export DTOs and enums from `packages/shared/src/`
- **E2E testing**: Jest for API (apps/api/test/), Playwright for UI (apps/web/tests/)
