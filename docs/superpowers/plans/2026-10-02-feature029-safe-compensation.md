# Feature 029 Slice 4: Safe Compensation and Recovery Deferral Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep authorized payments and PROCESSING bookings recoverable whenever cancellation of a created Duffel order is unconfirmed, and defer stale recovery until its next safe retry.

**Architecture:** Keep `PaymentFulfillmentSaga`, `BookingRecoveryService`, the current supplier ports, and `CacheService` interfaces. Add small runtime guards at the existing compensation and recovery branches: read order IDs from either `metadata.id` or `metadata.data.id`, stop destructive compensation when an order exists but its ID or cancellation proof is missing, and use the existing TTL defer key for recovery.

**Tech Stack:** TypeScript, NestJS, Prisma, Redis through `CacheService`, Jest.

**Spec:** `GOAL.md`; `specs/029-duffel-provider-narrowing/spec.md`; `specs/029-duffel-provider-narrowing/plan.md`; `specs/029-duffel-provider-narrowing/contracts/supplier-boundaries.md`; `specs/029-duffel-provider-narrowing/tasks.md` (T040–T041).

## Global Constraints

- Preserve `FULFILLMENT_GATEWAY_PORT`, `PaymentGatewayPort`, `SagaOwnership`, `DuffelCancellationService.cancelOrder`, and the current `CacheService` method signatures.
- When `duffel_order_created` evidence exists, never void the payment hold, fail the booking, or complete the idempotency key until supplier cancellation is confirmed.
- Preserve `booking:recovery:defer:{bookingId}` and the positive-TTL sweeper skip; an absent/expired key permits a safe recheck.
- Add no dependencies, ports, services, or abstractions. Add no `any` or type assertions in changed code or new test statements; narrow persisted metadata from `unknown`.
- Keep existing test assertions unchanged. Human approval on 2026-10-02 permits replacing the two already-cancelled replay error fixtures with explicit CANCELLED evidence and documenting that approval; all other existing cases remain unchanged.
- Use PowerShell commands from the repository root. Commit T040 and T041 separately, after each task’s focused checks pass.

## File Map

- `apps/api/src/payment-fulfillment/payment-fulfillment.saga.ts`: T040 inline capture-failure compensation and 25-second background error handler; no public signature changes.
- `apps/api/src/payment-fulfillment/payment-fulfillment.saga.spec.ts`: additive regression cases using the existing saga/mocks; retain all current cases.
- `apps/api/src/booking-lifecycle/booking-recovery.service.ts`: T041 persisted-order lookup, cancellation deferral, and existing stale-sweeper TTL gate; no constructor or service-interface changes.
- `apps/api/src/booking-lifecycle/booking-recovery.service.spec.ts`: additive cases using the existing recovery fixture; retain all current cases.
- `apps/api/test/payment-fulfillment-safety.e2e-spec.ts`: existing service-graph money-path coverage already exercises capture failure → rate deferral → TTL skip → retry → confirmed cancellation → hold release → booking failure. Re-run it unchanged; it needs no additional scenario for these guard fixes.
- `specs/029-duffel-provider-narrowing/tasks.md`: mark only the completed T040/T041 item in its corresponding task commit. Do not mark T042/T043 complete.
- `context/active-feature.md` and `context/progress-checker.md`: after T041, update the checkpoint to T040–T041 complete locally and T042–T043 pending. `context/architecture.md` already documents these safety invariants and needs no change.

---

### Task 1: T040 — Safe inline and background saga compensation

**Files:** Modify `apps/api/src/payment-fulfillment/payment-fulfillment.saga.ts`, add cases to its existing `.spec.ts`, and check only T040 in `specs/029-duffel-provider-narrowing/tasks.md` after validation.

**Interfaces:** Consume the existing `FulfillmentGatewayPort.cancelOrder(orderId, control)`, `PaymentGatewayPort.voidHold(intentId, control)`, Prisma payment-event metadata and idempotency checkpoint. Preserve public signatures, ownership fencing, and `isCancellationConfirmed`.

- [ ] Step 1: Add ONE inline capture-failure case using existing fixtures with `metadata: { data: { id: 'ord-nested' } }` and cancellation `PENDING`. Assert cancellation receives the nested ID and all destructive calls are absent:

```typescript
expect(mockFulfillmentGateway.cancelOrder).toHaveBeenCalledWith(
  'ord-nested', expect.objectContaining({ beforeInvoke: expect.any(Function) }),
);
expect(mockPaymentGateway.voidHold).not.toHaveBeenCalled();
expect(mockBookingLifecycle.updateToFailed).not.toHaveBeenCalled();
expect(mockIdempotency.completeSagaKeyAtomic).not.toHaveBeenCalled();
```

- [ ] Step 2: Run `pnpm --filter @api/backend exec jest --runInBand src/payment-fulfillment/payment-fulfillment.saga.spec.ts`; retain failing output proving nested evidence does not currently reach cancellation.
- [ ] Step 3: Resolve nested IDs with runtime narrowing; use the existing narrowing utility if available, otherwise one small typed function inside the existing saga file may serve both compensation call sites. It is not a new service or abstraction. This exact shape handles both ID locations without assertions:

```typescript
function readOrderId(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  if ('id' in value && typeof value.id === 'string' && value.id.trim().length > 0) {
    return value.id;
  }
  if (!('data' in value) || typeof value.data !== 'object' || value.data === null) {
    return undefined;
  }
  return 'id' in value.data && typeof value.data.id === 'string' &&
    value.data.id.trim().length > 0 ? value.data.id : undefined;
}
```

- [ ] Step 4: Run the covering case to GREEN before adding the next case.
- [ ] Step 5: Repeat ONE case → RED command → minimal GREEN code → passing command for the background nested-ID path, then each inline/background missing, empty or malformed ID case. If order-created evidence exists without a usable ID, inline compensation throws the existing recoverable 502 response with `bookingStatus: 'PROCESSING'`; background logs and returns. Neither branch voids, fails, or finalizes. Preserve the AUTHORIZED payment, PROCESSING booking, event evidence and order-created checkpoint. Prove all with assertions against existing state fixtures and absent mutation calls; do not weaken existing tests.
- [ ] Step 6: Verify background unconfirmed-cancellation cases for `RATE_LIMIT_EXCEEDED`, `BUDGET_UNAVAILABLE`, network error and `PENDING`. Reuse adequate existing cases; add uncovered cases individually using RED/GREEN. Each must assert cancellation attempted and no hold release, failure transition or key completion. Preserve existing successful and no-order compensation behavior. If a case already passes, record the existing coverage honestly instead of inventing RED.
- [ ] Step 7: Run the full saga spec, `pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit`, and `pnpm --filter @api/backend lint`. Self-review diff; all commands must exit 0 before marking T040 complete. Existing assertions are immutable without human approval.
- [ ] Step 8: Check only T040 and commit its three files with `git commit -m "fix(api): retain saga state on unconfirmed cancellation (T040)"`. Stage exact files, never unrelated edits. Write task report with RED/GREEN commands/output, changed files, commit and concerns.

### Task 2: T041 — Safe recovery deferral and retry timing

**Files:** Modify `apps/api/src/booking-lifecycle/booking-recovery.service.ts`, add cases to its existing `.spec.ts`, and check only T041 in `specs/029-duffel-provider-narrowing/tasks.md`. Update `context/active-feature.md` and `context/progress-checker.md` after validation to T040–T041 complete locally, T042–T043 pending. Update architecture only where the new behavior makes its current statements inaccurate.

**Interfaces:** Consume existing `DuffelCancellationService.cancelOrder(orderId)`, `CacheService.getTtl(key)` and `CacheService.set(key, value, ttlSeconds)`. Return the same booking from `reconcileBookingIfStale`; preserve constructor injection and module boundaries. Concrete cancellation/recovery exports are permitted by the approved supplier contract; never import vendor SDK implementations.

- [ ] Step 1: Add ONE nested-ID/PENDING cancellation case using existing stale-booking fixtures. Run `pnpm --filter @api/backend exec jest --runInBand src/booking-lifecycle/booking-recovery.service.spec.ts` and retain expected RED. Resolve top-level then nested nonempty IDs with runtime narrowing, using the same shape shown in Task 1 locally within recovery. Do not create a cross-module utility for this slice. Verify GREEN before the next case.
- [ ] Step 2: Add ONE missing-ID case, then RED, then minimal GREEN. A created-order event with missing, empty or malformed ID must never call Stripe cancel or failBooking. Set `booking:recovery:defer:{bookingId}` to the ISO retry time with TTL 300 and return the current booking. The cache write uses existing logged failure handling; cache unavailability must never permit destructive compensation. Repeat individually for remaining ID boundary cases.

```typescript
expect(mockStripeService.cancelPaymentIntent).not.toHaveBeenCalled();
expect(mockBookingLifecycleService.failBooking).not.toHaveBeenCalled();
expect(mockCacheService.set).toHaveBeenCalledWith(
  'booking:recovery:defer:b-missing-id', expect.any(String), 300,
);
```

- [ ] Step 3: Add ONE payment-event lookup rejection case. Confirm RED, add `return booking` in the existing lookup-error catch before release/failure, and verify GREEN. Optional bounded deferral is allowed by GOAL.md; do not add extra calls if returning safely is sufficient.

```typescript
mockPrisma.paymentEvent.findFirst.mockRejectedValueOnce(new Error('event store unavailable'));
// Invoke the existing public reconciliation entry with a stale PROCESSING booking fixture.
expect(mockStripeService.cancelPaymentIntent).not.toHaveBeenCalled();
expect(mockBookingLifecycleService.failBooking).not.toHaveBeenCalled();
```

- [ ] Step 4: Add ONE 429 `BUDGET_UNAVAILABLE` case with valid `retryAfterSeconds` and `resetAt`. Freeze time at `2026-10-02T01:00:00.000Z`, use retry 60 and reset `2026-10-02T01:01:00.000Z`. Confirm RED, extend the existing response-code guard, verify GREEN:

```typescript
(response.code === 'RATE_LIMIT_EXCEEDED' || response.code === 'BUDGET_UNAVAILABLE')
```

```typescript
expect(mockCacheService.set).toHaveBeenCalledWith(
  'booking:recovery:defer:b-budget-unavailable', '2026-10-02T01:01:00.000Z', 60,
);
```

- [ ] Step 5: Verify both typed 429 codes with upstream `resetAt` and positive integer retry seconds; missing reset computes `Date.now() + retryAfterSeconds * 1000`. Add uncovered cases one at a time using RED/GREEN. Retain the generic-error and invalid retry-metadata 300-second fallback. Confirm pending cancellation, cache-write failure and lookup errors never void/fail, and confirmed cancellation records `duffel_order_cancelled` before release. Preserve already-cancelled replay and duplicate-effect guards.
- [ ] Step 6: Preserve and verify positive-TTL skip and expired/missing-key safe recheck through public recovery entry points. Reuse adequate existing tests. Run `apps/api/test/payment-fulfillment-safety.e2e-spec.ts` with the approved replay-fixture correction for service-graph coverage of capture failure, rate deferral, TTL skip, retry and confirmed cancellation before release/failure. If that suite lacks an in-scope required behavior, add a new test rather than modify its existing assertions.
- [ ] Step 7: Run focused recovery spec, `pnpm --filter @api/backend test:e2e -- test/payment-fulfillment-safety.e2e-spec.ts`, `pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit`, and `pnpm --filter @api/backend lint`. Keep database E2Es on the existing disposable `feature029_slice2_test` database when needed; do not reset unrelated data. All commands must exit 0; record test evidence.
- [ ] Step 8: Update task and checkpoint docs accurately; do not claim full-feature convergence. Commit exact task files with `git commit -m "fix(api): defer unconfirmed stale recovery (T041)"`. Report RED/GREEN evidence, commit and concerns.

## Final validation and review

After both task reviews approve, run scoped speckit-converge for T040/T041, full change-aware API/shared lint/typecheck/shared contracts/static contracts and network-guard API unit suite. Execute relevant transactional E2Es once. Run parallel Standards and Spec code-review workers against baseline `06756d2ef8952ba8caf534cd9a60378bf9e56b52`; retain separate reports, resolve blockers through workers, update verification/context documentation, and commit documentation. Complete requested draft-PR/CI workflow after local gates pass. T042–T057 remain unfinished and are not gaps in this approved slice.

## Self-review

Coverage maps T040 to inline/background recoverable compensation and T041 to typed retry timing, stale recovery safety, TTL gates and safe replay. Interfaces remain unchanged. No new dependency, any, assertion or service. Each new behavioral test is followed immediately by RED/GREEN before another test is introduced. Focused test, typecheck and lint precede each task commit. Existing tests remain intact. No unspecified implementation steps.


## Human-approved amendment (2026-10-02)

The human approved both replay-fixture corrections: replace rejected `Error('The order has already_cancelled')` in the unit replay case with resolved `{ id: 'ord_123', status: 'CANCELLED' }`; replace the queued Error in the safety E2E replay with `{ id: 'order-safety-1', status: 'CANCELLED' }`. Keep every existing assertion intact; rename the misleading unit title and document approval in comments. Remove recovery's error-text-only confirmation path. Add one RED/GREEN regression that a thrown already_cancelled error remains unconfirmed, produces bounded deferral, and never releases the hold, fails the booking or writes cancellation proof. The real supplier cancellation capability returns CANCELLED only after confirming provider state; a thrown error means it could not confirm. Include the approved E2E correction in the T041 commit. This amendment overrides earlier instructions to run that test unchanged.
