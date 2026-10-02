# Feature 029 Order Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** Complete GOAL.md tasks T038 and T039 without changing fulfillment or order-consumer behavior.

**Architecture:** SupplierOrderModule owns the real order adapter, normalizer, cancellation, recovery, and fulfillment providers. A temporary legacy-module re-export keeps T038 independently runnable; T039 imports the supplier module directly.

**Tech Stack:** Installed NestJS 10, TypeScript, Jest, Duffel SDK, CacheService; no dependencies added.

**Spec:** specs/029-duffel-provider-narrowing/spec.md; contracts/supplier-boundaries.md; GOAL.md.

## Global Constraints

- FULFILLMENT_GATEWAY_PORT signatures and behavior remain unchanged.
- Preserve semaphore active/queue/timeout settings, permit release, ownership preflight, idempotency, PII redaction, snapshot enrichment, cancellation evidence, and public errors.
- No new remote call or retry introduced by extraction. Existing offer lookup before order POST must remain, with each actual attempt reserved by the existing budget owner.
- Concrete cancellation and recovery capabilities remain flat; consumers never import SDK/core implementations.
- No type assertions or any in new implementation/tests. Constructor injection for services. Preserve all existing assertions; wiring-only fixture migrations are required by GOAL.md, while corrections to failing expectations require human approval.
- One implementer and one independent task reviewer per task, sequential execution, focused tests/typecheck/package lint before completion, commit each task separately.
- Stop if the same problem persists after one corrective attempt. T040–T057 remain outside this slice.

## Task 1: T038 — Fulfillment adapter and supplier order module

**Files:** Move apps/api/src/duffel/duffel-fulfillment.adapter.ts and its spec to apps/api/src/supplier/order/. Create supplier-order.module.ts and supplier-order.module.spec.ts there. Modify duffel.module.ts for temporary module re-export, duffel-order.adapter.ts and order-snapshot.normalizer.ts for existing creation preparation, payment/payment-ancillary-final-fixes.spec.ts and test/module-deepening.e2e-spec.ts for relocated imports/DI. Add a separate supplier-order-module E2E file for real capability graph coverage.

**Interfaces:** Consume DuffelOrderAdapter.createOrder(DuffelCreateOrderParams): Promise<unknown>, DuffelCancellationService.cancelOrder(string): Promise<unknown>, DuffelRecoveryService.retrieveCompleteOrder(string): Promise<unknown>, OrderSnapshotNormalizer.mapDuffelOrderToSnapshots(unknown). Produce unchanged FulfillmentGatewayPort, SupplierOrderModule, and existing concrete cancellation/recovery exports. Add metered order-adapter offer lookup and normalizer passenger preparation only to preserve legacy DuffelService.createOrder behavior.

- [ ] Read legacy createOrder/getOfferById and fulfillment specs. Capture passenger type matching, field precedence, required fields, errors, request metadata, and offer-fetch timeout. Preserve these exactly; narrow unknown input using guards.
- [ ] RED: add a module graph test using real services and adapter, external SDK/cache/fetch boundary doubles. Resolve the port and call createOrder with a valid traveler, then assert offer lookup precedes POST and the POST contains matched passenger ID, normalized fields, services, and idempotency header. Run the new test before implementation; record failure.

```typescript
const gateway = moduleRef.get<FulfillmentGatewayPort>(FULFILLMENT_GATEWAY_PORT);
expect(gateway).toBe(moduleRef.get(DuffelFulfillmentAdapter));
expect(moduleRef.get(DuffelCancellationService)).toBeDefined();
expect(moduleRef.get(DuffelRecoveryService)).toBeDefined();
```

- [ ] GREEN: move the adapter; inject order adapter, cancellation, recovery and normalizer. Preserve admission and beforeInvoke ordering. Route the existing offer lookup and traveler mapping through capability-local code before raw createOrder. Match adult/child/infant_without_seat by type and occurrence; preserve given/family aliases, DOB precedence/date conversion, gender/title normalization, phone/email requirements and identity documents. Redact returned unknown evidence with guards. Delegate cancellation and recovery to existing services; normalize fallback enrichment locally.
- [ ] GREEN: register the following module and temporarily import/re-export it from DuffelModule, removing the old fulfillment provider/token registration so there is one instance.

```typescript
@Module({
  imports: [ConfigModule, DuffelCoreModule, CacheModule],
  providers: [DuffelOrderAdapter, OrderSnapshotNormalizer,
    DuffelCancellationService, DuffelRecoveryService, DuffelFulfillmentAdapter,
    { provide: FULFILLMENT_GATEWAY_PORT, useExisting: DuffelFulfillmentAdapter }],
  exports: [DuffelCancellationService, DuffelRecoveryService, FULFILLMENT_GATEWAY_PORT],
})
export class SupplierOrderModule {}
```

- [ ] Migrate moved test setup through Nest DI with external boundary doubles, keeping assertions. Update additional relocated adapter imports and construction fixtures. Run one behavioral RED/GREEN cycle at a time for invalid travelers/no POST, fencing/no provider call, unconfirmed cancellation, redaction and fallback. Existing parity tests must remain green.
- [ ] Run `pnpm --filter @api/backend exec jest --runInBand src/supplier/order src/payment/payment-ancillary-final-fixes.spec.ts src/payment-fulfillment/payment-fulfillment.saga.spec.ts`; run new graph E2E with `pnpm --filter @api/backend exec jest --config test/jest-e2e.json --runInBand supplier-order-module`; run `pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit` and `pnpm --filter @api/backend lint`.
- [ ] Write report with exact RED/GREEN evidence and checks; independent task review. Mark T038 only after passing gates. Commit scoped files with `refactor(api): bind supplier order fulfillment (T038)`.

## Task 2: T039 — Rewire order consumers

**Files:** cancellation/cancellation.service.ts and module; booking-lifecycle/booking-recovery.service.ts and module; disruption/sync/supplier-sync.service.ts and disruption.module.ts; payment-fulfillment/payment-fulfillment.module.ts; app.module.ts; adjacent consumer specs; test/module-deepening.e2e-spec.ts and other test boundary overrides found by a focused DuffelService consumer census. Update relevant context documents after validation.

**Interfaces:** Consume SupplierOrderModule exports from Task 1. Cancellation injects DuffelCancellationService for quote/confirm and DuffelRecoveryService for status lookup. Booking recovery injects recovery plus cancellation. Supplier sync injects recovery. Fulfillment consumes only existing FULFILLMENT_GATEWAY_PORT.

- [ ] RED: add a boundary/module-wiring test asserting each target module imports SupplierOrderModule and consumers resolve through its exports without DuffelService. Run it against old wiring and record failure.

```typescript
const imports: unknown = Reflect.getMetadata('imports', CancellationModule);
expect(imports).toContain(SupplierOrderModule);
expect(imports).not.toContain(DuffelModule);
```

- [ ] GREEN: replace constructor types and module imports using this mapping, preserving method arguments, branching and public outcomes.

| Consumer | Existing call | New capability |
| --- | --- | --- |
| cancellation | createCancellationQuote / confirmCancellationQuote | cancellation |
| cancellation | retrieveOrder | recovery |
| booking recovery | cancelOrder | cancellation |
| booking recovery | retrieveOrder / retrieveCompleteOrder / recoverOrderSnapshots | recovery |
| supplier sync | retrieveCompleteOrder / recoverOrderSnapshots | recovery |
| payment fulfillment / AppModule | legacy fulfillment module | SupplierOrderModule |

- [ ] Update test DI tokens/mocks without changing expected behavior. For module integration, exercise real capability providers with only external boundaries replaced. Add a cross-module graph E2E behavior proving consumer resolution and safe order/cancellation flow. Do not change saga or recovery business state logic.
- [ ] Run `pnpm --filter @api/backend exec jest --runInBand src/supplier/order src/payment-fulfillment src/cancellation src/booking-lifecycle src/disruption`; run relevant supplier graph, module-deepening, cancellation and booking/compensation E2Es against the dedicated test database. Run API typecheck and package lint.
- [ ] Verify `rg -n 'DuffelService|DuffelModule' apps/api/src/cancellation apps/api/src/booking-lifecycle apps/api/src/disruption/sync apps/api/src/payment-fulfillment` has no production consumer hits. Preserve intentional later-task references elsewhere.
- [ ] Write report, independent review, mark T039 only after checks, update active-feature/architecture/progress-checker/library-docs as affected. Commit with `refactor(api): rewire supplier order consumers (T039)`.

## Final gates

- [ ] Scoped speckit-converge assessment of T038/T039 against spec/plan/tasks/constitution; leave later tasks pending.
- [ ] Parallel code-review Standards and Spec axes over `git diff 6ad4704e...HEAD`; resolve blockers.
- [ ] Full network-guard API tests, API/shared ESLint, shared contracts, static CI contracts, API typecheck. Record evidence in specs/029-duffel-provider-narrowing/slice-3-verification.md.
- [ ] Publish draft PR and verify remote CI per workflow step 9; no merge.

Self-review: task interfaces agree; exports are fixed; offer mapping omission addressed; T038 precedes T039 with one provider owner; no unrelated deletion/renaming; exact commands and test snippets supplied.
