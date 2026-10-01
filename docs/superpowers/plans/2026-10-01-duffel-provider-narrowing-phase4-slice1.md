# Feature 029 Phase 4 Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Each worker owns one task; each task has one independent reviewer. Steps use checkbox syntax.

**Goal:** Complete T025–T027: characterize ancillary catalog and payment/selection parity, and extract a standalone metered SDK adapter.

**Architecture:** Existing ancillary consumers continue using DuffelService in this slice. Catalog contract tests exercise its public methods until T029 creates DuffelAncillaryService. The new adapter owns only raw supplier calls; normalization, caching, module wiring and consumer migration remain T028–T030.

**Tech Stack:** Installed TypeScript, NestJS, Jest, Supertest, Prisma and @duffel/api. No dependency additions.

**Spec:** GOAL.md; specs/029-duffel-provider-narrowing/spec.md; specs/029-duffel-provider-narrowing/plan.md; specs/029-duffel-provider-narrowing/contracts/supplier-boundaries.md.

## Global Constraints

- Every actual upstream SDK call reserves one attempt; cache hits reserve zero and make zero upstream calls.
- Redis key `seatmap:${offerId}`; cache HIT only when TTL > 3 seconds; force refresh and TTL <= 3 bypass cache; existing cache write TTL is 60 seconds.
- Missing seat maps (404/empty) produce `seatMapAvailable: false`, `seatMap: null` while preserving baggage services. Other supplier failures must propagate.
- Budget exhaustion returns HTTP 429 `RATE_LIMIT_EXCEEDED`; unavailable budget returns HTTP 429 `BUDGET_UNAVAILABLE`. A denied operation makes zero SDK calls.
- Authoritative supplier amounts, quantities, currency, selected-service identity and passenger scope remain unchanged. No client amount becomes trusted evidence.
- Strictly zero `any` in added code/tests. Document necessary assertions; use actual `DUFFEL_SDK` injection token, not GOAL's obsolete `DUFFEL_SDK_PROVIDER` spelling.
- Keep mock/test behavior: outside Jest, NODE_ENV=test or token=mock yields deterministic raw supplier payloads without SDK calls/budget cost. Jest exercises injected SDK boundaries.
- Tests are immutable after written. Never skip, weaken, delete or change expected values without human approval. Characterization tests may already pass: report that honestly, rather than inventing RED evidence.
- Implementation follows one behavior at a time: test, run, minimal fix, run, refactor. One task commit after checks; independent review follows each commit.
- No graphify updates; no production Next.js changes; no changes to T028–T030.
- Trace touched public methods and every production caller before editing. Mock only external SDK, database and cache boundaries; exercise real internal collaborators in new integration fixtures.

## File Responsibilities

| File | Responsibility |
| --- | --- |
| supplier/ancillary/duffel-ancillary.service.spec.ts | Existing public catalog contract, free cache hits, refresh, budgeting and missing maps |
| duffel/duffel.service.ts | Minimal seat-map-only 404 fallback required by T025 |
| test/ancillary-catalog.e2e-spec.ts | Real ancillary HTTP controller/service/catalog path with external boundaries stubbed |
| payment/ancillary-payment-validation.service.spec.ts | Payment-bound authoritative pricing/error parity |
| ancillaries/ancillaries.service.spec.ts | Public selection service identity/currency/passenger validation |
| supplier/ancillary/duffel-ancillary.adapter.ts and .spec.ts | Raw metered supplier methods and deterministic mock compatibility |

Paths above are relative to apps/api/src except test/. All workers read context/code-standards.md and relevant library-docs.md sections. No installed Duffel/Nest/Jest-specific skill was found; installed SDK typings are authoritative.

### Task 1: T025 Catalog Contract and Missing Map Regression

**Files:** Create apps/api/src/supplier/ancillary/duffel-ancillary.service.spec.ts and apps/api/test/ancillary-catalog.e2e-spec.ts. Modify apps/api/src/duffel/duffel.service.ts only for seat-map fallback. Mark T025 in specs/029-duffel-provider-narrowing/tasks.md after GREEN.

**Interfaces:** Consumes real `DuffelService.getSeatMapsAndServices(offerId: string, forceRefresh = false): Promise<AncillaryCatalog>`, `AncillaryCatalogService.getCatalog(offerId: string, refresh = false): Promise<AncillaryCatalog>`, and `AncillariesService.read(userId: string, intentId: string, refresh = false)`. Produces executable characterization tests and graceful legacy missing-map behavior. The new supplier test deliberately imports the existing DuffelService; do not create a fake future service.

- [ ] Read complete catalog method and all callers, existing apps/api/src/duffel/duffel-ancillary.service.spec.ts, real controller, service and catalog dependencies. Build narrow typed external boundary doubles with valid offer segments and a baggage service (`ase_bag_1`, `pas_1`, `seg_1`, USD 30.00, checked 23kg, maximum quantity 2).
- [ ] Add one 404 regression test and run RED before changing production:

```typescript
mockSeatMapsGet.mockRejectedValue({ status: 404, message: 'Seat map not found' });
mockOffersGet.mockResolvedValue({ data: rawOffer });
const catalog = await service.getSeatMapsAndServices('off_123', true);
expect(catalog.segments).toEqual([{ segmentId: 'seg_1', origin: 'SGN', destination: 'SIN', seatMapAvailable: false, seatMap: null }]);
expect(catalog.baggageServices).toContainEqual(expect.objectContaining({ serviceId: 'ase_bag_1', passengerId: 'pas_1', amount: '30.00', currency: 'USD' }));
```

Run from apps/api: `./node_modules/.bin/jest.CMD --config jest.config.json --runInBand src/supplier/ancillary/duffel-ancillary.service.spec.ts`. Expected RED: 502 UPSTREAM_UNAVAILABLE from the missing map.

- [ ] Catch only the seat-map operation's missing-map error inside the existing concurrent pair. Return `{ data: [] }` only for numeric 404 status/statusCode or HttpException.getStatus()=404; rethrow other errors. Preserve reservations before both operations and preserve the offer promise, timeout and normalizer.

```typescript
const seatMapsPromise = this.duffel.seatMaps.get({ offer_id: offerId }).catch((error: unknown) => {
  const status = error instanceof HttpException ? error.getStatus()
    : error && typeof error === 'object' && 'status' in error ? error.status
    : error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
  if (status === 404) return { data: [] };
  throw error;
});
```

- [ ] Run GREEN, then add each remaining behavior separately: TTL 4 HIT returns cache metadata with no reservation/SDK calls; TTL 3/0 and force refresh call both supplier endpoints and meter twice; demonstrate both calls start before either response settles; exhausted/unavailable first reservation and denied second reservation make no SDK calls; empty maps preserve baggage; seat-map 500 and offer 404 do not silently succeed. Use concrete assertions, not only toBeDefined.

```typescript
expect(catalog.cache).toEqual({ status: 'HIT', ttlSeconds: 4 });
expect(rateBudget.reserveAttempt).not.toHaveBeenCalled();
expect(mockSeatMapsGet).not.toHaveBeenCalled();
expect(mockOffersGet).not.toHaveBeenCalled();
```

- [ ] Add an HTTP E2E test using real AncillariesController -> AncillariesService -> AncillaryCatalogService -> DuffelService, real budget service with stubbed cache/DB/SDK external boundaries, and a test auth guard that supplies an owned user. GET `/bookings/intent/11111111-1111-4111-8111-111111111111/ancillaries?refresh=true` returns 200, missing seats and retained bag service on SDK seat-map 404. Also verify budget-denied response 429 with no upstream call. Close the Nest application and restore environment/spies in cleanup.
- [ ] Run focused supplier and existing Duffel ancillary specs, then E2E: `./node_modules/.bin/jest.CMD --config test/jest-e2e.json --runInBand test/ancillary-catalog.e2e-spec.ts`. Run TypeScript `./node_modules/.bin/tsc.CMD -p tsconfig.json --noEmit`. Mark T025 only after success. Stage only this task's files and commit `test(ancillary): lock catalog cache and missing seat-map behavior`.

### Task 2: T026 Pricing and Passenger Scope Parity

**Files:** Extend apps/api/src/payment/ancillary-payment-validation.service.spec.ts; create apps/api/src/ancillaries/ancillaries.service.spec.ts; optionally extend apps/api/src/duffel/duffel-ancillary.service.spec.ts for SDK repricing assertions. Mark T026 in tasks.md after GREEN. No production changes expected.

**Interfaces:** Consumes real `AncillaryPaymentValidationService.validateForPayment(input: ValidateAncillaryPaymentInput): Promise<ValidatedAncillaryPayment>`, `AncillariesService.commit(userId: string, intentId: string, key: string, dto: CommitAncillarySelectionDto)` and `DuffelService.repriceOffer(offerId: string, intendedServices: { serviceId: string; quantity: number }[]): Promise<AncillaryRepriceOutput>`. Produces parity tests that survive supplier rewiring.

- [ ] Read existing payment spec and all selection/repricing callers. Inventory existing scenarios before adding tests; do not repeat existing broad coverage. Build real catalog, Duffel and idempotency collaborators with external SDK/Prisma/cache doubles. Valid owned intent contains local passenger p1 -> supplier pas_1 and p2 -> pas_2, base 420.00 USD, future expiries, PENDING state, selection snapshot and catalog fingerprint.
- [ ] Add one uncovered repricing assertion at a time. Supplier `getPriced` receives duplicate bag requests as one `{ id: 'ase_bag_1', quantity: 3 }`; returns total 510.00, base 420.00, currency USD and 30.00 x3 service line. Assert exact outputs and one reservation:

```typescript
expect(result).toEqual({ totalAmount: '510.00', baseAmount: '420.00', currency: 'USD', serviceLines: [{ serviceId: 'ase_bag_1', amount: '30.00', quantity: 3 }], invalidServiceIdentities: [] });
expect(mockOffersGetPriced).toHaveBeenCalledWith('off_123', { intended_payment_methods: [{ type: 'card', card_id: 'mock_card' }], intended_services: [{ id: 'ase_bag_1', quantity: 3 }] });
```

- [ ] Through payment public API assert authoritative total and base persistence, invalidServiceIdentities error mapping, and mixed selected-service currency rejection before repricing. Existing behavior tests may pass immediately: record characterization GREEN, no contrived production change.
- [ ] Through real AncillariesService.commit verify valid selection uses supplier catalog amount rather than client amount, passenger-mismatched catalog service and unknown service ID fail HTTP 400 ANCILLARY_SCOPE_INVALID, and mismatched selected currency fails ANCILLARY_CURRENCY_MISMATCH. Assert errors identify selected service/passenger and no selection writes occurred. Use real validateAncillarySelection and calculateAncillaryTotals via service, not mocked internal methods.

```typescript
await expect(service.commit('user-1', intentId, 'key-1', dto)).rejects.toMatchObject({ response: { code: 'ANCILLARY_SCOPE_INVALID', invalidSelections: expect.arrayContaining([expect.objectContaining({ serviceId: 'ase_unknown', intentPassengerId: 'p1' })]) } });
expect(selectionCreate).not.toHaveBeenCalled();
```

- [ ] Run `./node_modules/.bin/jest.CMD --config jest.config.json --runInBand src/payment/ancillary-payment-validation.service.spec.ts src/ancillaries src/duffel/duffel-ancillary.service.spec.ts src/supplier/ancillary/duffel-ancillary.service.spec.ts`. Run API tsc. Mark T026 after GREEN; commit `test(ancillary): lock authoritative pricing and passenger scope parity`.

### Task 3: T027 Metered Ancillary SDK Adapter

**Files:** Create apps/api/src/supplier/ancillary/duffel-ancillary.adapter.ts and .spec.ts. A small raw mock fixture file in the same directory is allowed if required to avoid coupling the adapter to the legacy service. Mark T027 in tasks.md. Update relevant feature sections of context/architecture.md and context/progress-checker.md with exact completed scope and test evidence.

**Interfaces:** Constructor injects `@Inject(DUFFEL_SDK) private readonly duffel: Duffel`, `private readonly rateBudgetService: DuffelRateBudgetService`. Produces `getSeatMaps(offerId: string): Promise<unknown>`, `getOfferWithServices(offerId: string): Promise<unknown>`, `getPricedOffer(offerId: string, services: Array<{ id: string; quantity: number }>): Promise<unknown>`. All methods return raw unwrapped response `.data`, with null/empty missing seat maps. Priced method forwards supplied service lines; deduplication stays in future service/current reprice caller.

- [ ] Read installed SDK typings and existing search adapter budget/mock patterns. Add first test resolving injected adapter through Test.createTestingModule and assert raw SDK data is returned; run RED for missing adapter.
- [ ] Implement Injectable constructor and first method minimally:

```typescript
async getOfferWithServices(offerId: string): Promise<unknown> {
  await this.reserveAttempt();
  return (await this.duffel.offers.get(offerId, { return_available_services: true })).data;
}
```

- [ ] Add one budget denial test at a time and implement shared private reservation helper using typed BudgetReservationResult. Preserve existing messages, retryAfterSeconds, resetAt for exhaustion; 429 unavailable fails closed. Check denial happens before every SDK call, and failed supplier attempts still consume reservation.

```typescript
if (!result.ok) {
  throw new HttpException({ code: result.error === 'EXHAUSTED' ? 'RATE_LIMIT_EXCEEDED' : 'BUDGET_UNAVAILABLE', message: result.error === 'EXHAUSTED' ? 'Daily Duffel API rate limit exceeded' : 'Duffel rate budget is temporarily unavailable', retryAfterSeconds: result.retryAfterSeconds, ...('resetAt' in result ? { resetAt: result.resetAt } : {}) }, HttpStatus.TOO_MANY_REQUESTS);
}
```

- [ ] Implement seatMaps.get with its own reservation and only missing-map 404 fallback. Test raw data, empty/unavailable data, status/statusCode/HttpException 404, and non-404 propagation. Budget denial remains outside missing-map catch.
- [ ] Implement getPricedOffer, using installed SDK request types without any:

```typescript
const response = await this.duffel.offers.getPriced(offerId, {
  intended_payment_methods: [{ type: 'card', card_id: 'mock_card' }],
  intended_services: services,
});
return response.data;
```

- [ ] Preserve the non-Jest test/mock fallback as raw supplier payloads that produce the existing catalog and reprice semantics after future normalization: seg_mock_1 SGN/SIN, pas_mock_1, ase_mock_seat_1/2 USD15, ase_mock_bag_1 USD30 maximum2 for catalog; priced base420, bag35, other service18, quantities and invalid identity handling. In tests restore JEST_WORKER_ID, NODE_ENV and DUFFEL_ACCESS_TOKEN exactly. No SDK construction, no legacy DuffelService dependency, no budget cost for synthetic outputs. Validate raw fixtures and zero upstream/reservations in mock mode; Jest mode still exercises injected SDK even with token=mock.
- [ ] Run focused adapter/catalog/parity suites, API tsc, scoped lint; inspect diff for any and unrelated changes. Mark T027 and update context files with passed evidence; commit `feat(ancillary): extract metered Duffel SDK adapter`.

## Validation and Closure

- Run the GOAL matrix using explicit API Jest config and direct installed binaries; run broader ancillary/payment unit regression once after task work, then full API unit gate with CI network guard.
- From root run eslint for apps/api/**/*.ts and packages/shared/**/*.ts, shared types tests, API tsc, and node --test tests/ci/ci-workflow.contract.test.mjs. Sandbox child-process EPERM requires approved execution outside sandbox; never change tests to bypass it.
- Convergence is limited to T025–T027 and the approved legacy 404 fix. Keep T028 onward unchecked; do not claim whole US2 complete.
- Pin review baseline 508c65b7. Run independent parallel Standards and Spec reviews; resolve blocking findings through implementation workers.
- Workflow step 9 follows local gate success. Prior PR #357 is merged; a new PR is needed for this slice. Never merge automatically.

## Plan Self-Review

- Coverage: catalog cache/budget/missing maps -> Task1; authoritative reprice/currency/identity/passenger parity -> Task2; standalone metered raw SDK/mock adapter -> Task3.
- Type consistency: actual core DUFFEL_SDK and BudgetReservationResult; raw adapter methods return unknown; shared AncillaryCatalog/AncillaryRepriceOutput remain unchanged.
- Boundaries: legacy 404 fix is approved necessity, no new service/module/normalizer or consumer rewiring. New ancillaries service spec is created because the named file does not exist.
- Characterization tests may be GREEN without new production code; only actual behavior changes require RED->GREEN proof.
