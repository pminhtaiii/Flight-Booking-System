# Feature 017 Phase 9A: Safe Booking Projection Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Phase 9A safe `BookingAgentProjection` persistence foundation: dedicated privacy-minimized table, cryptographically secure opaque reference generation (`bkref_<uuid>`), transactional projection creation on booking confirmation, projection updates on status change and supplier sync/reconciliation/cancellation, and restart-safe backfill, verified by unit/integration tests with zero PII/financial/PNR/database-id leakage.

**Architecture:** A dedicated 1-to-1 table `booking_agent_projections` holds pre-computed, safe, allowlist-only flight logistics. `BookingAgentProjectionService` encapsulates reference generation, field extraction from canonical models/snapshots, and transactional upsert operations. Hook points in `BookingService`, `PaymentService`, `SupplierSyncService`, `ReconciliationService`, and `DuffelEventProcessor` maintain projection state atomically during confirmation, cancellation, completion, and supplier synchronization. A restart-safe cursor-paginated script and service method backfill legacy bookings.

**Tech Stack:** NestJS, Prisma ORM, PostgreSQL, Jest, TypeScript, Crypto (Node.js built-in).

**Spec:** `specs/017-chatbot-backend-infrastructure/spec.md` (FR-022, FR-023, FR-024), `specs/017-chatbot-backend-infrastructure/data-model.md` (lines 52-76), `specs/017-chatbot-backend-infrastructure/plan.md` (Phase 9A).

## Global Constraints

- **Privacy Invariant**: Strictly forbidden from projection: `Booking.id` / raw DB IDs, `pnrReference`, `totalAmount`, `currency`, `fareClass`, `passengerCount`, passenger PII (`firstName`, `lastName`, `passportNumber`, `dob`, `email`, `phone`), `contactEmail`, `contactPhone`, `Payment` records, Stripe tokens, `flightSnapshot`, `passengerSnapshot`, raw Duffel orders/payloads.
- **Reference Invariant**: References must use `bkref_<uuid>` (v4 UUID or 32-hex crypto random), non-guessable, never derived from internal database keys or booking identifiers.
- **Transaction Invariant**: Projection create/update must accept `Prisma.TransactionClient` to participate atomically in booking confirmation, cancellation, and sync transactions. Failure rolls back the entire transaction.
- **Scope Invariant**: Do NOT implement Phase 9B gateway read endpoints, Phase 9C LLM agent tools, or Phase 9D search attestation in this slice.
- **Architecture Invariant**: Python AI agent never touches PostgreSQL or Prisma directly. NestJS is the sole owner of projection persistence.

---

### Task 1: BookingAgentProjection Schema & DDL Verification

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (verify and ensure `BookingAgentProjection` model matches specification)
- Test: `apps/api/test/booking-projection-migration.e2e-spec.ts`

**Interfaces:**
- Produces: `BookingAgentProjection` model in Prisma Client with fields:
  - `bookingId`: String `@id` (1:1 relation to `Booking`, `onDelete: Cascade`)
  - `agentReference`: String `@unique`
  - `status`: String
  - `airline`: String
  - `origin`: String
  - `destination`: String
  - `departureAt`: DateTime
  - `arrivalAt`: DateTime
  - `durationMinutes`: Int
  - `stopCount`: Int
  - `flightNumber`: String?
  - `baggageSummary`: String?
  - `refundable`: Boolean?
  - `changeable`: Boolean?
  - `createdAt`: DateTime `@default(now())`
  - `updatedAt`: DateTime `@updatedAt`

- [ ] **Step 1: Write the failing E2E migration & privacy contract test**

Create `apps/api/test/booking-projection-migration.e2e-spec.ts` asserting:
- Table `booking_agent_projections` exists in DB with exact allowed column types.
- No forbidden columns exist (`pnr`, `passenger_count`, `total_amount`, `currency`, `contact_email`, `contact_phone`, `flight_snapshot`, `passenger_snapshot`, etc.) in `information_schema.columns`.
- Foreign key constraint to `bookings.id` with `ON DELETE CASCADE`.
- Unique index on `agent_reference`.

- [ ] **Step 2: Run test to verify it fails or runs as expected**

Run: `npx jest --config ./test/jest-e2e.json test/booking-projection-migration.e2e-spec.ts --runInBand`

- [ ] **Step 3: Verify schema.prisma and generate Prisma client**

Run: `pnpm --filter @api/backend exec prisma generate`

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --config ./test/jest-e2e.json test/booking-projection-migration.e2e-spec.ts --runInBand`

---

### Task 2: Implement `BookingAgentProjectionService` with TDD

**Files:**
- Create: `apps/api/src/agent-gateway/booking-agent-projection.service.ts`
- Create: `apps/api/src/agent-gateway/booking-agent-projection.service.spec.ts`
- Modify: `apps/api/src/agent-gateway/agent-gateway.module.ts`

**Interfaces:**
- Produces: `BookingAgentProjectionService` with methods:
  - `generateAgentReference(): string` -> returns `bkref_<uuid>`
  - `extractProjectionData(booking: BookingWithDetails): SafeProjectionData`
  - `createOrUpdateProjection(bookingId: string, client?: PrismaClient | Prisma.TransactionClient): Promise<BookingAgentProjection>`
  - `updateProjectionStatus(bookingId: string, status: string, client?: PrismaClient | Prisma.TransactionClient): Promise<BookingAgentProjection | null>`
  - `getProjectionByBookingId(bookingId: string, client?: PrismaClient | Prisma.TransactionClient): Promise<BookingAgentProjection | null>`
  - `getProjectionByReference(agentReference: string, userId: string): Promise<BookingAgentProjection | null>`
  - `backfill(batchSize?: number): Promise<{ processed: number; success: number; failed: number }>`

- [ ] **Step 1: Write failing unit tests for `BookingAgentProjectionService`**

In `apps/api/src/agent-gateway/booking-agent-projection.service.spec.ts`:
- Reference generation produces `bkref_<uuid>` with valid UUID format and high entropy.
- Extract projection data correctly parses `ItineraryRevision` (primary) and `flightSnapshot` (fallback).
- Extract projection data extracts only allowlisted fields: `airline`, `origin`, `destination`, `departureAt`, `arrivalAt`, `durationMinutes`, `stopCount`, `flightNumber`, `baggageSummary`, `refundable`, `changeable`.
- Privacy test: Asserts that forbidden properties (`pnr`, `passengerCount`, `contactEmail`, `contactPhone`, `totalAmount`, `currency`, `passengers`, `payments`, `flightSnapshot`, `passengerSnapshot`) are NOT included in the projection record.
- Upsert logic handles new creation (generates reference) and updates (preserves reference).
- Retry logic on `P2002` reference collision.
- Transaction client support: executes queries using provided `tx` when passed.
- Owner validation in `getProjectionByReference`: returns projection only if booking belongs to `userId`, returns null if mismatched.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/agent-gateway/booking-agent-projection.service.spec.ts`
Expected: FAIL with module/class not found.

- [ ] **Step 3: Write `BookingAgentProjectionService` implementation**

Implement `BookingAgentProjectionService` in `apps/api/src/agent-gateway/booking-agent-projection.service.ts` with full type safety and error handling.
Export and register in `AgentGatewayModule`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/agent-gateway/booking-agent-projection.service.spec.ts`
Expected: PASS.

---

### Task 3: Transactional Projection Population on Booking Confirmation, Failure, Completion, and Cancellation

**Files:**
- Modify: `apps/api/src/booking/booking.service.ts`
- Modify: `apps/api/src/booking/booking.service.spec.ts`
- Modify: `apps/api/src/booking/booking.module.ts`
- Modify: `apps/api/src/payment/payment.service.ts`
- Modify: `apps/api/src/payment/payment.service.spec.ts`
- Modify: `apps/api/src/payment/payment.module.ts`

**Interfaces:**
- Consumes: `BookingAgentProjectionService.createOrUpdateProjection()`, `updateProjectionStatus()`
- Produces: Atomically created/updated `BookingAgentProjection` upon confirmation (`CONFIRMED`), cancellation (`CANCELLED`), completion (`COMPLETED`), and failure (`FAILED`).

- [ ] **Step 1: Write failing tests for confirmation & lifecycle projection maintenance**

In `apps/api/src/booking/booking.service.spec.ts` and `apps/api/src/payment/payment.service.spec.ts`:
- `updateToConfirmed()` calls `projectionService.createOrUpdateProjection(bookingId, tx)` inside transaction.
- `cancelBooking()` calls `projectionService.updateProjectionStatus(bookingId, 'CANCELLED', tx)` inside transaction.
- `checkAndCompleteBooking()` calls `projectionService.updateProjectionStatus(bookingId, 'COMPLETED', tx)` inside transaction.
- `updateToFailed()` calls `projectionService.updateProjectionStatus(bookingId, 'FAILED', tx)` inside transaction.
- `reconcileBookingIfStale()` calls `projectionService.createOrUpdateProjection(bookingId, tx)` when confirmed.

- [ ] **Step 2: Run tests to verify failures**

Run: `npx jest src/booking/booking.service.spec.ts src/payment/payment.service.spec.ts`
Expected: FAIL (projectionService not called or injected).

- [ ] **Step 3: Implement projection hooks in `BookingService` and `PaymentService`**

- Inject `BookingAgentProjectionService` into `BookingService` (and export/import via modules).
- Call `projectionService.createOrUpdateProjection` in `updateToConfirmed` and `reconcileBookingIfStale`.
- Call `projectionService.updateProjectionStatus` in `cancelBooking`, `checkAndCompleteBooking`, `updateToFailed`.
- In `payment.service.ts`: ensure `updateToConfirmed` automatically updates projection inside `tx`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/booking/booking.service.spec.ts src/payment/payment.service.spec.ts`
Expected: PASS.

---

### Task 4: Projection Refresh on Supplier Sync, Disruption Reconciliation, and Duffel Webhook Events

**Files:**
- Modify: `apps/api/src/disruption/sync/supplier-sync.service.ts`
- Modify: `apps/api/src/disruption/sync/supplier-sync.service.spec.ts`
- Modify: `apps/api/src/disruption/sync/reconciliation.service.ts`
- Modify: `apps/api/src/disruption/sync/reconciliation.service.spec.ts`
- Modify: `apps/api/src/disruption/webhook/duffel-event.processor.ts`
- Modify: `apps/api/src/disruption/webhook/duffel-event.processor.spec.ts`
- Modify: `apps/api/src/disruption/disruption.module.ts`

**Interfaces:**
- Consumes: `BookingAgentProjectionService.createOrUpdateProjection(bookingId, tx)`

- [ ] **Step 1: Write failing tests for sync & disruption projection refresh**

In `supplier-sync.service.spec.ts`, `reconciliation.service.spec.ts`, `duffel-event.processor.spec.ts`:
- When `SupplierSyncService.syncBooking()` persists new itinerary revisions or status changes in `$transaction`, it calls `projectionService.createOrUpdateProjection(bookingId, tx)`.
- When `ReconciliationService.reconcileBooking()` resolves changes, projection is refreshed.
- When `DuffelEventProcessor` handles cancellation / flight change events, projection is refreshed.

- [ ] **Step 2: Run tests to verify failures**

Run: `npx jest src/disruption/sync/supplier-sync.service.spec.ts src/disruption/sync/reconciliation.service.spec.ts src/disruption/webhook/duffel-event.processor.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Wire `BookingAgentProjectionService` into Disruption services**

- Add `BookingAgentProjectionService` (or import `AgentGatewayModule`) to `DisruptionModule`.
- Invoke `createOrUpdateProjection(bookingId, tx)` in `SupplierSyncService`, `ReconciliationService`, and `DuffelEventProcessor` inside their respective database transactions.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/disruption/sync/supplier-sync.service.spec.ts src/disruption/sync/reconciliation.service.spec.ts src/disruption/webhook/duffel-event.processor.spec.ts`
Expected: PASS.

---

### Task 5: Existing-Booking Backfill Script & Service Integration

**Files:**
- Modify: `apps/api/prisma/scripts/backfill-booking-agent-projections.ts`
- Modify: `apps/api/test/chat-persistence-migration.e2e-spec.ts`
- Test: `apps/api/test/booking-projection-backfill.e2e-spec.ts`

**Interfaces:**
- Produces: Restart-safe, cursor-paginated CLI backfill script `backfillBookingAgentProjections()` and `BookingAgentProjectionService.backfill()` method.

- [ ] **Step 1: Write failing integration test for backfill**

Create `apps/api/test/booking-projection-backfill.e2e-spec.ts`:
- Seeds multiple existing bookings without projections (with itinerary revisions and legacy flightSnapshots).
- Runs backfill script / service method.
- Verifies every booking has exactly one `BookingAgentProjection`.
- Verifies `agentReference` uniqueness (`bkref_<uuid>`).
- Verifies re-running the backfill is idempotent (does NOT overwrite existing `agentReference` or create duplicates).
- Verifies missing flight data logs a warning and does not crash the batch.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --config ./test/jest-e2e.json test/booking-projection-backfill.e2e-spec.ts --runInBand`

- [ ] **Step 3: Enhance `backfill-booking-agent-projections.ts` and delegate to shared extraction logic**

- Ensure `apps/api/prisma/scripts/backfill-booking-agent-projections.ts` uses the robust extraction & reference generation rules.
- Support batch cursor pagination, graceful error recovery, retry on reference collision.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --config ./test/jest-e2e.json test/booking-projection-backfill.e2e-spec.ts --runInBand`
Expected: PASS.

---

### Task 6: Privacy Contract Verification & Comprehensive Integration Tests

**Files:**
- Create: `apps/api/test/booking-agent-projection-privacy.e2e-spec.ts`

**Interfaces:**
- Validates: FR-022, FR-023, FR-024 privacy invariants across the database layer.

- [ ] **Step 1: Write comprehensive privacy assertion tests**

In `apps/api/test/booking-agent-projection-privacy.e2e-spec.ts`:
- Confirm a complete booking through the booking/payment flow.
- Direct database query on `booking_agent_projections`:
  - Verify stored row contains ONLY allowlisted fields (`bookingId`, `agentReference`, `status`, `airline`, `origin`, `destination`, `departureAt`, `arrivalAt`, `durationMinutes`, `stopCount`, `flightNumber`, `baggageSummary`, `refundable`, `changeable`, `createdAt`, `updatedAt`).
  - Verify ABSENCE of: `pnr`, `pnrReference`, `totalAmount`, `currency`, `passengerCount`, `contactEmail`, `contactPhone`, passenger names/PII, passport data, payment card/intent IDs, raw Duffel payloads, snapshots.
- Verify `agentReference` is formatted as `bkref_<uuid>` and is NOT equal to `bookingId` or any substring of it.
- Verify ownership scoping: querying projection joined through booking validates owner `userId`.

- [ ] **Step 2: Run the privacy e2e test**

Run: `npx jest --config ./test/jest-e2e.json test/booking-agent-projection-privacy.e2e-spec.ts --runInBand`
Expected: PASS.

---

### Task 7: Full Test Suite Verification, Documentation, & Handoff

**Files:**
- Modify: `context/architecture.md`
- Modify: `context/progress-checker.md`
- Modify: `specs/017-chatbot-backend-infrastructure/tasks.md`

- [ ] **Step 1: Run full NestJS API unit and E2E test suites**

Run:
```powershell
Push-Location apps/api
npx jest --runInBand
Pop-Location
```

- [ ] **Step 2: Run code-review subagents (Standards & Spec Compliance)**

- Standards subagent: Check against `context/code-standards.md`.
- Spec compliance subagent: Check against `specs/017-chatbot-backend-infrastructure/spec.md` (FR-022–FR-024, Phase 9A requirements).
- Resolve any findings.

- [ ] **Step 3: Update documentation and Spec Kit tasks**

- Update `context/architecture.md` to document `BookingAgentProjection` persistence and lifecycle.
- Update `context/progress-checker.md` with Phase 9A completion status.
- Update `specs/017-chatbot-backend-infrastructure/tasks.md` to mark Phase 9A tasks complete.
