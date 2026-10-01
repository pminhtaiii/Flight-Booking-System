# Feature 029 Order Slice 1 Implementation Plan

> **For agentic workers:** Execute these tasks with the approved subagent-driven workflow. Keep each task in its own commit; leave a task unchecked until its focused tests are green.

**Goal:** Lock order-operation parity and extract the raw Duffel order adapter for Feature 029 T032–T034, while making the approved unconfirmed-cancellation safety cases executable.

**Architecture:** `DuffelOrderAdapter` owns metered raw SDK operations and the manual `/air/orders` POST. It receives mapped order parameters; passenger lookup/mapping remains outside the adapter. Existing `FULFILLMENT_GATEWAY_PORT`, fulfillment fencing, redaction, and consumer wiring remain as-is in this slice. T033 adds the narrow safe-retry branches exercised by its approved scenarios; later order services and broader rewiring remain pending.

**Tech Stack:** Existing TypeScript, NestJS, Jest, installed `@duffel/api`, `DuffelRateBudgetService`, `CacheService`; no new dependency.

**Spec:** `GOAL.md`, `specs/029-duffel-provider-narrowing/spec.md` (US3, FR-006, FR-007a, FR-012), `specs/029-duffel-provider-narrowing/plan.md`, and `specs/029-duffel-provider-narrowing/contracts/supplier-boundaries.md`.

## Global Constraints

- Preserve the exact `FULFILLMENT_GATEWAY_PORT` signatures, `PortInvocationControl.beforeInvoke`, order idempotency, redaction, fallback snapshots, and current public error behavior.
- One shared Duffel budget owner MUST enforce 1,500 attempted API calls per day; search MUST enforce daily allocations of 1,000 user and 500 agent calls. Reserve once before each actual Duffel attempt.
- No second supplier, new public endpoint, new dependency, generic cancellation/ancillary port, or new payment authority.
- Any unconfirmed supplier cancellation after order creation MUST leave the booking recoverable and retain the authorized hold, order evidence, and retryable `duffel_order_created` checkpoint.
- The recovery defer key is `booking:recovery:defer:{bookingId}`; it contains only the next allowed UTC time, expires by TTL, and the 10-minute sweeper skips it until due. A missing key permits a safe recheck.
- No new `any` or type assertions. Accept supplier payloads as `unknown` and narrow at the boundary. Do not weaken existing expectations.
- Keep scope to T032–T034. Do not rewire consumers, move the fulfillment adapter, add cancellation/recovery services or normalizers, delete `DuffelService`/`DuffelModule`, or mark T035–T043 complete.
- Dispatch two Luna6Max workers: worker A owns T032 and T034, in that order, with a separate commit for each; worker B owns T033 in one commit. T033 may proceed independently. Do not start T034 until T032 baseline tests pass.
- One existing recovery assertion conflicts with the approved safe-cancellation behavior. Workflow step 2.2 requires human approval to change it. **Approval gate:** do not edit its assertions until the user explicitly approves; add the new safety test alongside it and keep the dependent T033 implementation incomplete if the old assertion still blocks a green suite.

## Files and boundaries

| File | Responsibility in this slice |
|---|---|
| `apps/api/src/supplier/order/duffel-order.adapter.ts` | Metered SDK calls and manual order POST from already mapped input |
| `apps/api/src/supplier/order/duffel-order.adapter.spec.ts` | Public operation and request parity checks; first lock the legacy baseline, then test the extracted adapter |
| `apps/api/src/duffel/duffel.service.spec.ts` | Existing order methods provide the T032 legacy behavior baseline |
| `apps/api/src/duffel/duffel-fulfillment.adapter.spec.ts` | Existing PII redaction, fallback, semaphore, and port tests; retain them |
| `apps/api/src/payment-fulfillment/payment-fulfillment.saga.ts` and `.spec.ts` | Inline and 25-second background compensation safety under cancellation denial |
| `apps/api/src/booking-lifecycle/booking-recovery.service.ts` and `.spec.ts` | Unconfirmed cancellation retention and TTL deferral/retry |
| `apps/api/test/payment-fulfillment-safety.e2e-spec.ts` | Mocked-boundary Nest integration of saga checkpoint, denied cancellation, and recovery retry |
| `specs/029-duffel-provider-narrowing/tasks.md` | Check only T032, T033, and T034 after their own green gates |

## Task 1 — T032: Lock order-operation parity

**Files:** Create `apps/api/src/supplier/order/duffel-order.adapter.spec.ts`; extend only if needed `apps/api/src/duffel/duffel-fulfillment.adapter.spec.ts`; update T032 in `specs/029-duffel-provider-narrowing/tasks.md` after GREEN.

**Baseline/interface:** The target adapter does not exist yet. First exercise the existing public `DuffelService.createOrder` behavior in the new suite and keep the tests passing on the legacy implementation. Existing `duffel.service.spec.ts` already covers quote, confirm, cancel, active/cancelled retrieval, complete retrieval, and budget denials; the fulfillment suite already covers email, phone, identity-document redaction and fallback snapshots. Extend only a gap found by the new parity review. Do not copy or weaken those assertions.

- [ ] Add one RED/GREEN baseline test for manual order POST using a Duffel offer fixture with one adult passenger, a service, metadata, and an idempotency key. Assert the URL, method, `Authorization`, `Duffel-Version`, `Idempotency-Key: <key>-duffel-order`, selected offer, mapped passenger, optional services, metadata, response, and two reservations for the existing offer lookup plus POST.
- [ ] Run `pnpm --filter @api/backend exec jest --runInBand src/supplier/order/duffel-order.adapter.spec.ts src/duffel/duffel.service.spec.ts src/duffel/duffel-fulfillment.adapter.spec.ts`; expected GREEN before T034.
- [ ] Review coverage against the existing quote/retrieval/cancellation and PII assertions above. Add only a missing public behavior regression. Run the same command and commit only T032 test/task files as `test(supplier): lock order operation parity`.

Representative request assertion:

```typescript
expect(requestOptions).toEqual(expect.objectContaining({
  method: 'POST',
  headers: expect.objectContaining({
    'Duffel-Version': 'v2',
    'Idempotency-Key': 'attempt-1-duffel-order',
  }),
}));
expect(requestBody.data).toMatchObject({
  type: 'instant',
  selected_offers: ['off_1'],
  services: [{ id: 'seat_1', quantity: 1 }],
  metadata: { paymentId: 'pay_1' },
});
```

## Task 2 — T033: Make denied cancellation safe and retryable

**Files:** Modify `apps/api/src/payment-fulfillment/payment-fulfillment.saga.ts` and `.spec.ts`; `apps/api/src/booking-lifecycle/booking-recovery.service.ts` and `.spec.ts`; create `apps/api/test/payment-fulfillment-safety.e2e-spec.ts`; update only T033 in `tasks.md` after GREEN.

**Interfaces:** Keep constructor ports and database/event contracts. Reuse `FulfillmentGatewayPort.cancelOrder`, `PaymentGatewayPort.voidHold`, `CacheService.getTtl/set`, and the existing payment events. The recovery key stores the retry timestamp as ISO text with a TTL equal to the retry delay.

- [ ] Add a RED inline last-slot test: create-order checkpoint and event exist; capture fails and resolves to `authorized`; cancel throws a 429 `RATE_LIMIT_EXCEEDED` with `retryAfterSeconds` and `resetAt`. Require a `PROCESSING` result/error, no `voidHold`, no payment/booking terminal update, no `completeSagaKeyAtomic`, and the retained order event/checkpoint.
- [ ] Add a RED background test by calling the existing `handleBackgroundError` path with the same order/capture state after handoff. Require the same retained hold, checkpoint, event, and no terminal key completion. Run `pnpm --filter @api/backend exec jest --runInBand src/payment-fulfillment/payment-fulfillment.saga.spec.ts`; implement only the early safe return for unconfirmed cancellation in the inline and background branches, then rerun GREEN.
- [ ] Add RED recovery tests for: a typed budget denial writes `booking:recovery:defer:b-1` with ISO retry time and `retryAfterSeconds`; the lock/sweeper path skips while `getTtl(key) > 0`; expiry allows a recheck that confirms cancellation before Stripe hold release/failure; an already-cancelled response remains idempotent.
- [ ] On an unconfirmed cancellation, return the booking still `PROCESSING`, do not create `duffel_order_cancelled`, do not cancel Stripe, and do not fail the booking. Use the budget retry delay when present; use a fixed 300-second backoff for an untyped cancellation failure. The safe path remains safe if cache write fails; the next sweep can recheck after its normal 10-minute interval.
- [ ] Run `pnpm --filter @api/backend exec jest --runInBand src/booking-lifecycle/booking-recovery.service.spec.ts`; after any approval to update the conflicting legacy expectation, run both focused saga/recovery specs again.
- [ ] Add one Nest Test-module integration using the real saga and recovery services, in-memory `CacheService` behavior, and fakes only at Prisma/Stripe/fulfillment boundaries. Exercise order-created → capture failure → denied cancellation → retry after defer expiry; assert one order creation, no hold release while denial stands, and one cancellation before terminal recovery. No database or live supplier call. Run `pnpm --filter @api/backend exec jest --runInBand --config test/jest-e2e.json test/payment-fulfillment-safety.e2e-spec.ts`.
- [ ] Run API typecheck: `pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit`. After focused suites, E2E, and typecheck pass, commit only T033 files as `fix(payment): retain bookings after unconfirmed cancellation`.

**Approval-dependent existing case:** `apps/api/src/booking-lifecycle/booking-recovery.service.spec.ts`, test `does not create duffel_order_cancelled marker when Duffel cancellation fails with unexpected error`, currently expects `cancelPaymentIntent` and `BookingStatus.FAILED`. Those expectations conflict with the approved FR-007a invariant. Do not edit them without the pending explicit approval; the new behavior test is still required and T033 stays unchecked until the suite is green.

T033 overlaps the narrow behavior later named by T040/T041 because GOAL.md requires these safety tests to pass now. Record the exact overlap in the task report. Leave T040/T041 unchecked; their broader order-phase review and any uncovered cases remain open.

Representative deferral assertions:

```typescript
expect(cacheService.set).toHaveBeenCalledWith(
  'booking:recovery:defer:b-1',
  expect.any(String),
  retryAfterSeconds,
);
expect(cacheService.getTtl).toHaveBeenCalledWith('booking:recovery:defer:b-1');
expect(booking.status).toBe(BookingStatus.PROCESSING);
expect(stripeService.cancelPaymentIntent).not.toHaveBeenCalled();
```

## Task 3 — T034: Extract the raw order adapter

**Files:** Create `apps/api/src/supplier/order/duffel-order.adapter.ts`; extend `apps/api/src/supplier/order/duffel-order.adapter.spec.ts`; update only T034 in `tasks.md` after GREEN.

**Interfaces:** `DuffelOrderAdapter` injects the configured Duffel SDK and `DuffelRateBudgetService`. Its `createOrder(input: DuffelCreateOrderParams): Promise<unknown>` accepts already mapped request values; it does not fetch/normalize offers or map passengers. It also exposes the existing quote-create, quote-confirm, cancel, active-order retrieval, and complete-order retrieval operations. Do not inject `DuffelService`, `FLIGHT_SEARCH_PORT`, or feature services.

- [ ] Add RED tests for each adapter operation, asserting one reservation immediately before each actual call. Cancellation is two actual calls and two reservations; a denial before either call prevents that call. Returned quote/retrieval payloads retain existing shapes and safe 429 errors retain their status/code.
- [ ] Add a RED manual POST test using already mapped `DuffelCreateOrderParams`; assert the same `/air/orders` headers/body/idempotency suffix and one reservation for the POST. Use the existing shared core configuration; keep token/base-path construction owned by the core provider. No offer lookup belongs in this adapter.
- [ ] Implement the adapter with explicit input/output types, `unknown` response parsing, and narrow shape guards. Preserve the 30,000 ms timeout, abort signal, request shape, 429 mapping, and best-effort rejection handling for the raced fetch promise. Keep every reservation immediately before its actual SDK/fetch attempt.
- [ ] Run `pnpm --filter @api/backend exec jest --runInBand src/supplier/order/duffel-order.adapter.spec.ts src/duffel/duffel.service.spec.ts src/duffel/duffel-fulfillment.adapter.spec.ts`; expected GREEN. Do not rewire consumers in T034.
- [ ] Run API typecheck with `pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit`, mark T034 only after GREEN, and commit adapter/spec/task files as `feat(supplier): extract metered Duffel order adapter`.

## Completion checks

- T032 has a green legacy baseline commit before extraction; T034 adapter tests pass with the same public operation expectations where behavior is shared.
- T033 remains unchecked if the recovery approval gate is unresolved or any focused test remains red.
- T035–T043 remain unchecked. No context status files are updated by this planning slice.
