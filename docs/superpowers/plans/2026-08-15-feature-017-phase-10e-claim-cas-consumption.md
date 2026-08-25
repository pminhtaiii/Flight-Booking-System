# Feature 017 Phase 10E: Pre-Supplier Claim Verification & Consumption CAS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Phase 10E of Feature 017 (Work Packages 6H & 6I / Tasks T070, T071, T083, T084): Token-only booking readiness source resolution, pre-supplier CAS claim lease protocol, watchdog refresh with supplier timeout buffer, and atomic BookingIntent consumption transaction with 100-way concurrency verification.

**Architecture:** Connect the resolved chat handoff credential to the canonical `BookingReadinessService` and `BookingIntentService`. Before calling Duffel, acquire a pre-supplier Compare-And-Swap (CAS) claim lease on `ChatHandoff`. Under high concurrency (100 simultaneous requests), exactly ONE request succeeds and creates an intent, while all 99 losing requests fail fast (409 Conflict) with zero Duffel, payment, or supplier API calls. On Duffel failure, automatically release the claim back to ACTIVE. Inside the final atomic transaction, revalidate active non-deleted ChatSession and unexpired claim ownership before creating `BookingIntent` and setting `ChatHandoff.consumedAt = NOW()` and `consumedByBookingIntentId = bookingIntent.id`.

**Tech Stack:** NestJS 10, Prisma ORM (PostgreSQL), Duffel API client, Jest E2E / Supertest, TypeScript.

**Spec:** `specs/017-chatbot-backend-infrastructure/spec.md` (FR-032, FR-033, FR-034, FR-035, FR-036), `specs/017-chatbot-backend-infrastructure/plan.md` (Phase 6 / Work Packages 6H & 6I), `specs/017-chatbot-backend-infrastructure/data-model.md`, `specs/017-chatbot-backend-infrastructure/contracts/api.md`, `specs/017-chatbot-backend-infrastructure/tasks.md` (T070, T071, T083, T084).

---

## Global Invariants & Rules

1. **Token-Only Resolution**: Readiness and intent creation DTOs MUST resolve `flightOfferId` and `chatSessionId` internally from the verified `ChatHandoff` record; client-supplied `chatSessionId` MUST be rejected.
2. **Pre-Supplier Claim CAS**: CAS claim acquisition MUST execute before any Duffel or payment API call.
3. **Zero Supplier Losers**: Any losing concurrent attempt MUST abort immediately with zero supplier network calls.
4. **Hard Timeout Margin**: Supplier call deadline (25s) plus finalization margin MUST be strictly less than remaining claim lease TTL (30s-45s).
5. **Watchdog Refresh & Loss Cancellation**: A background heartbeat refreshes the claim while work is in-flight; if refresh fails or claim expires, execution aborts with 409 Conflict.
6. **Automatic Claim Recovery**: On recoverable Duffel errors or validation failures, release the claim back to ACTIVE (nullify `claimedAt`, `claimTokenHash`, `claimExpiresAt`, `claimRecoverAfter`) so the user can retry.
7. **Atomic Consumption**: In a single Prisma `$transaction`, verify unexpired claim ownership and active non-deleted `ChatSession`, create `BookingIntent` and passenger snapshots, and mark `ChatHandoff` as `CONSUMED` with `consumedByBookingIntentId`.
8. **Subagent Delegation**: Always use subagents for implementation and code review to avoid context rot.

---

### Task 1: Feature 016a Gate Verification (T070)

**Files:**
- Test: `apps/api/test/booking-readiness.e2e-spec.ts`
- Test: `apps/api/test/booking-intent.e2e-spec.ts`

- [ ] **Step 1: Run Feature 016a Preflight Suites**
Run both plural readiness and canonical `BookingIntent` creation test suites to verify that prerequisite foundations are 100% green before proceeding.
Command: `pnpm --filter @api/backend exec jest test/booking-readiness.e2e-spec.ts test/booking-intent.e2e-spec.ts --config ./test/jest-e2e.json`

---

### Task 2: Token-Only Readiness & Claim DTO Validation (T083)

**Files:**
- Modify: `apps/api/src/booking-intent/dto/booking-readiness.dto.ts`
- Modify: `apps/api/src/booking-intent/dto/create-intent.dto.ts`
- Modify: `apps/api/src/booking-intent/booking-readiness.service.ts`
- Test: `apps/api/src/booking-intent/booking-readiness.service.spec.ts`
- Test: `apps/api/test/booking-readiness.e2e-spec.ts`

- [ ] **Step 1: Verify Mutually Exclusive Handoff Source Resolution**
Verify `CheckBookingReadinessDto` / `BookingReadinessRequestDto` accepts `handoffToken` (mutually exclusive with `flightOfferId`).
Ensure `BookingReadinessService.getAdvisoryReadiness` resolves `flightOfferId` directly from `ChatHandoffService.resolve(dto.handoffToken, userId)` without requiring or accepting client `chatSessionId`.
Ensure extra properties (including `chatSessionId`) are strictly rejected.

- [ ] **Step 2: Run Unit & E2E Tests for Token-Only Readiness**
Run: `pnpm --filter @api/backend test src/booking-intent/booking-readiness.service.spec.ts`
Run: `pnpm --filter @api/backend exec jest test/booking-readiness.e2e-spec.ts --config ./test/jest-e2e.json`

---

### Task 3: Pre-Supplier Claim CAS Lease, Watchdog & Recovery (T084)

**Files:**
- Modify: `apps/api/src/chat-handoff/chat-handoff.service.ts`
- Modify: `apps/api/src/booking-intent/booking-intent.service.ts`
- Test: `apps/api/src/booking-intent/booking-intent.service.spec.ts`
- Test: `apps/api/src/chat-handoff/chat-handoff.service.spec.ts`

- [ ] **Step 1: Verify Pre-Supplier CAS Update**
In `ChatHandoffService.resolveAndAcquireClaim`, execute atomic CAS:
`UPDATE chat_handoffs SET claimedAt = now, claimTokenHash = hash, claimExpiresAt = now + ttlMs, claimRecoverAfter = now + ttlMs + 5000 WHERE tokenHash = tokenHash AND userId = userId AND consumedAt IS NULL AND expiresAt > now AND (claimRecoverAfter IS NULL OR claimRecoverAfter <= now) AND EXISTS (SELECT 1 FROM chat_sessions WHERE id = chat_handoffs.chatSessionId AND userId = userId AND deletedAt IS NULL)`
If 0 rows match, throw 409 Conflict immediately.

- [ ] **Step 2: Verify Watchdog Heartbeat & Supplier Hard Deadline**
Verify `claimWatchdog` refreshes claim TTL periodically.
Verify `fetchLiveOffer` enforces 25s timeout safely below 30s-45s claim lease TTL.
Verify cancellation on refresh loss (`claimLost = true`).

- [ ] **Step 3: Verify Claim Release / Recovery on Error**
In `finally` block of `createIntent`, if creation does not complete successfully, release the claim back to ACTIVE via `releaseClaim(handoff.id, claimToken)`.

- [ ] **Step 4: Run Service Unit Tests**
Run: `pnpm --filter @api/backend test src/booking-intent/booking-intent.service.spec.ts src/chat-handoff/chat-handoff.service.spec.ts`

---

### Task 4: Atomic Intent Creation & Consumption CAS (T084)

**Files:**
- Modify: `apps/api/src/booking-intent/booking-intent.service.ts`
- Test: `apps/api/test/booking-intent.e2e-spec.ts`

- [ ] **Step 1: Revalidate unexpired claim ownership & non-deleted ChatSession in Prisma Transaction**
In `BookingIntentService.createIntent`, inside `prisma.$transaction`:
1. Check `claimLost === false`.
2. Update `chat_handoffs` matching `id = handoff.id`, `userId = userId`, `chatSessionId = handoff.chatSessionId`, `claimTokenHash = claimTokenHash`, `consumedAt = null`, `claimExpiresAt > now`, `expiresAt > now`, and `chatSession.deletedAt = null`.
3. Set `consumedAt: new Date()`, `consumedByBookingIntentId: intent.id`.
4. If 0 rows updated, throw 409 Conflict (`Claim lost or expired before completion`).

- [ ] **Step 2: Run E2E Test Suite**
Run: `pnpm --filter @api/backend exec jest test/booking-intent.e2e-spec.ts --config ./test/jest-e2e.json`

---

### Task 5: 100-Way Concurrency Verification Suite (T071)

**Files:**
- Modify: `apps/api/test/chat-handoff-concurrency.e2e-spec.ts`

- [ ] **Step 1: Ensure Valid Token Prefix and Routes in `chat-handoff-concurrency.e2e-spec.ts`**
Verify that `token` starts with `chk_handoff_v1_` so hashing and fast-fail guards succeed.
Assert: Exactly 1 request receives 201 Created, 99 requests receive 409 Conflict, and Duffel API is called exactly once (0 calls for losers).
Assert: `ChatHandoff` record is updated with `consumedAt` and `consumedByBookingIntentId`.

- [ ] **Step 2: Run Concurrency E2E Test**
Run: `pnpm --filter @api/backend exec jest test/chat-handoff-concurrency.e2e-spec.ts --config ./test/jest-e2e.json`
Expected: 100% Reliable PASS.

---

### Task 6: Code Review, Spec Convergence & Context Synchronization

**Files:**
- Modify: `specs/017-chatbot-backend-infrastructure/tasks.md`
- Modify: `context/progress-checker.md`
- Modify: `context/architecture.md`

- [ ] **Step 1: Run Code Review Subagents**
Verify standards (no hardcoded hex/colors, error sanitization, strict types) and spec compliance (FR-032 through FR-036).

- [ ] **Step 2: Update Context & Tasks Documentation**
Update `specs/017-chatbot-backend-infrastructure/tasks.md`, `context/progress-checker.md`, and `context/architecture.md`.

- [ ] **Step 3: Commit Phase 10E Implementation**
`git add apps/api/ context/ specs/017-chatbot-backend-infrastructure/ docs/`
`git commit -m "feat(booking-intent): implement phase 10e pre-supplier claim verification and consumption cas"`
