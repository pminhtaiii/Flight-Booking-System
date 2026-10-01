# Feature 029 Ancillary Slice 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete GOAL.md's T028 and T029 ancillary normalization, cache orchestration, repricing, and module registration.

**Architecture:** Extract supplier-shape interpretation into AncillaryNormalizer. DuffelAncillaryService owns cache/freshness and safe errors, calls the existing independently metered DuffelAncillaryAdapter, and returns shared ancillary domain types. SupplierAncillaryModule exports only the concrete service; consumer rewiring remains T030.

**Tech Stack:** Existing TypeScript, NestJS, Jest, CacheService, shared types and installed Duffel adapter; no new dependency.

**Spec:** specs/029-duffel-provider-narrowing/spec.md (FR-001, FR-003, FR-005, FR-007, FR-010, FR-012 and US2), contracts/supplier-boundaries.md, and GOAL.md.

## Global Constraints

- SDK calls MUST be contained in Duffel adapters.
- Ancillary MUST preserve catalog caching, seat/passenger identity mapping, repricing, and authoritative payment totals.
- Each actual call reserves budget separately. Cache hits consume zero reservations and zero supplier calls.
- Preserve `seatmap:${offerId}`, fresh-cache threshold `ttl > 3`, write TTL `60`, catalog timeout `4500` milliseconds, shared output shapes, and existing HTTP status/error codes.
- No new dependency, external endpoint, generic ancillary port, consumer rewiring, schema change, monolith removal, or graphify update.
- Zero `any`; explicitly typed parameters/returns; `unknown` narrowed by guards; assertions only with necessary boundary justification.
- Keep existing tests unchanged. Add new suites exercising real service, adapter and normalizer; mock only SDK, Redis/cache and budget-store boundaries. Never weaken or change tests to make implementation pass.
- Use sequential RED/GREEN behavior cycles and commit each task. Update relevant context docs after verified implementation.
- User approved this design on 2026-10-01 and requested gpt-6-luna with max reasoning for all subagents, each owning 1–2 tasks. Review each task with one independent reviewer, then run the code-review skill's two final axes.

## File responsibilities and boundaries

| File | Responsibility |
|---|---|
| apps/api/src/supplier/ancillary/ancillary.normalizer.ts | Guard unknown supplier shapes and produce shared catalogs/repricing values |
| apps/api/src/supplier/ancillary/ancillary.normalizer.spec.ts | Unit tests through normalizer's public methods |
| apps/api/src/supplier/ancillary/duffel-ancillary.service.ts | Catalog caching, concurrent adapter operations, deadline, deduplication and safe errors |
| apps/api/src/supplier/ancillary/duffel-ancillary.capability.spec.ts | Real service+adapter+normalizer integration and budget boundary tests |
| apps/api/src/supplier/ancillary/supplier-ancillary.module.ts | ConfigModule, CacheModule, DuffelCoreModule imports; local providers; service-only export |
| apps/api/src/supplier/ancillary/supplier-ancillary.module.spec.ts | Nest module compilation, concrete resolution and export isolation |
| apps/api/test/supplier-ancillary.e2e-spec.ts | Capability module E2E across cache, SDK and repricing without rewiring T030 consumers |
| specs/029-duffel-provider-narrowing/tasks.md | Check T028/T029 only after tests and review |
| context/architecture.md and context/progress-checker.md | Verified slice status and remaining T030/T031 |

### Task 1: T028 — AncillaryNormalizer

**Files:** Create ancillary.normalizer.ts and ancillary.normalizer.spec.ts at apps/api/src/supplier/ancillary; mark T028 in specs/029-duffel-provider-narrowing/tasks.md after GREEN.

**Read:** context/code-standards.md; context/library-docs.md Duffel section; .agents/skills/tdd/SKILL.md; packages/shared/src/types/ancillary.types.ts; apps/api/src/duffel/duffel.service.ts lines 620–790 and 850–925. Check for installed library skills before using libraries; follow existing installed APIs and patterns.

**Interfaces:**

```typescript
@Injectable()
export class AncillaryNormalizer {
  normalizeCatalog(rawSeatMaps: unknown, rawOffer: unknown): AncillaryCatalog;
  normalizeRepricedOffer(
    rawPricedOffer: unknown,
    deduplicatedServices: Array<{ id: string; quantity: number }>,
  ): AncillaryRepriceOutput;
}
```

Consumes unknown supplier payloads; produces existing @shared/types AncillaryCatalog and AncillaryRepriceOutput. Typed supplier shapes RawDuffelSeatMap, RawDuffelOfferWithServices, RawDuffelPricedOffer stay internal to this normalizer. No SDK, cache or budget imports. Shape guards must protect nested arrays/records and required identities/prices without casting arbitrary unknown payloads into trusted types.

- [ ] Step 1: Add one RED catalog test for a mapped segment and a seat. Use Nest's Test.createTestingModule with the real normalizer, fake time, and this exact fixture/assertion:

```typescript
const offer = { slices: [{ segments: [{ id: 'seg_1', origin: { iata_code: 'SGN' }, destination: { iata_code: 'SIN' } }] }] };
const maps = [{ segment_id: 'seg_1', cabins: [{ cabin_class: 'economy', rows: [{ row_number: 1, sections: [{ elements: [{ type: 'seat', designator: '1A', disclosures: ['restricted'], available_services: [{ id: 'seat_1', passenger_id: 'pas_1', total_amount: '15.00', total_currency: 'USD' }] }, { type: 'aisle' }] }] }] }] }];
expect(normalizer.normalizeCatalog(maps, offer).segments[0]).toEqual({
  segmentId: 'seg_1', origin: 'SGN', destination: 'SIN', seatMapAvailable: true,
  seatMap: { cabins: [{ cabinClass: 'economy', rows: [{ rowNumber: 1, elements: [
    { type: 'seat', designator: '1A', restricted: true, availableServices: [{ serviceId: 'seat_1', passengerId: 'pas_1', amount: '15.00', currency: 'USD' }] },
    { type: 'aisle' },
  ] }] }] },
});
```

- [ ] Step 2: Run `pnpm --filter @api/backend exec jest --runInBand src/supplier/ancillary/ancillary.normalizer.spec.ts`; capture missing-module/behavior failure in task report.
- [ ] Step 3: Implement guarded catalog and seat projection. Iterate cabin rows and flatten section elements in order. Keep seat/non-seat distinctions, exact string amounts, restrictions, and defaults for optional collections. Map offer segments to matching map.segment_id. Missing map gives false/null. Catalog contains current ISO fetchedAt and MISS/60 metadata.

```typescript
const catalog: AncillaryCatalog = {
  fetchedAt: new Date().toISOString(),
  cache: { status: 'MISS', ttlSeconds: 60 },
  segments,
  baggageServices,
};
return catalog;
```

- [ ] Step 4: Run focused test GREEN. Add the next RED seat-service quarantine test, using incomplete variants missing each of id, passenger_id, total_amount, total_currency; assert availableServices equals only the complete fixture. Add false-restricted and multiple-section tests one cycle at a time; implement only needed guards.
- [ ] Step 5: Add RED baggage test with two passenger IDs and segment IDs; assert two domain services preserving passenger/segment identity, amount and currency. Use this required projection:

```typescript
expect(catalog.baggageServices).toEqual(['pas_1', 'pas_2'].map((passengerId) => ({
  serviceId: 'bag_1', passengerId, segmentIds: ['seg_1'], type: 'checked',
  weightValue: 23, weightUnit: 'kg', maxQuantity: 2, amount: '30.00', currency: 'USD',
})));
```

Implement type==='baggage' filtering, all required field guards, quarantine missing/empty IDs, amount/currency, passenger_ids, segment_ids or metadata.type; defaults weightValue/weightUnit null and maxQuantity 1. Add each quarantine/default behavior in its own RED/GREEN cycle. Null/malformed nested input must not create trusted empty service IDs or malformed domain values.
- [ ] Step 6: Add RED authoritative price test, then implement valid price projection without computing, rounding or replacing supplier base/total:

```typescript
const result = normalizer.normalizeRepricedOffer({ total_amount: '473.00', base_amount: '420.00', total_currency: 'USD', service_lines: [{ service_id: 'seat_1', total_amount: '18.00', quantity: 1 }, { service_id: 'bag_1', total_amount: '35.00', quantity: 1 }] }, [{ id: 'seat_1', quantity: 1 }, { id: 'bag_1', quantity: 1 }]);
expect(result).toEqual({ totalAmount: '473.00', baseAmount: '420.00', currency: 'USD', serviceLines: [{ serviceId: 'seat_1', amount: '18.00', quantity: 1 }, { serviceId: 'bag_1', amount: '35.00', quantity: 1 }], invalidServiceIdentities: [] });
```

On malformed successful pricing, throw a safe error for T029 to map to 502; never invent a payable amount. Empty service lines on a valid priced offer preserve baseline behavior. To normalize invalid service identities, accept raw supplier rejection with status/statusCode/meta.status 400 and optional errors/message; identify intended IDs in message/detail strings, deduplicate, fall back to all submitted identities. Return the baseline zero-price invalid result. Add RED/GREEN tests for identified IDs, all-ID fallback, SDK meta.status, absent service lines and malformed pricing.

```typescript
expect(normalizer.normalizeRepricedOffer({ meta: { status: 400 }, errors: [{ detail: 'Invalid seat_1' }] }, [{ id: 'seat_1', quantity: 1 }, { id: 'bag_1', quantity: 1 }])).toEqual({ totalAmount: '0.00', baseAmount: '0.00', currency: 'USD', serviceLines: [], invalidServiceIdentities: ['seat_1'] });
```

- [ ] Step 7: Self-review unknown guards, zero-any, fixture coverage and type consistency. Run normalizer suite and API `tsc -p tsconfig.json --noEmit`, record exact commands/outcomes. Mark T028 [X], stage only task files/tasks.md and commit `feat(ancillary): extract guarded catalog and price normalization`. Write full report to task-1-report.md; return status, commit and test counts.

### Task 2: T029 — DuffelAncillaryService and SupplierAncillaryModule

**Files:** Create duffel-ancillary.service.ts, duffel-ancillary.capability.spec.ts, supplier-ancillary.module.ts and supplier-ancillary.module.spec.ts under apps/api/src/supplier/ancillary; create apps/api/test/supplier-ancillary.e2e-spec.ts. Update tasks.md T029, context/architecture.md and context/progress-checker.md. Leave existing service contract, payment, controller and consumer tests unchanged.

**Read:** Task 1's actual public normalizer interfaces; existing duffel-ancillary.adapter.ts; legacy getSeatMapsAndServices/repriceOffer; existing duffel-ancillary.service.spec.ts; supplier core module; cache service API; .agents/skills/tdd/SKILL.md; context/testing.md and library rules.

**Interfaces:**

```typescript
@Injectable()
export class DuffelAncillaryService {
  constructor(
    private readonly adapter: DuffelAncillaryAdapter,
    private readonly normalizer: AncillaryNormalizer,
    private readonly cacheService: CacheService,
  ) {}
  getSeatMapsAndServices(offerId: string, forceRefresh = false): Promise<AncillaryCatalog>;
  repriceOffer(offerId: string, intendedServices: Array<{ serviceId: string; quantity: number }>): Promise<AncillaryRepriceOutput>;
}
```

Consumes real existing adapter.getSeatMaps/getOfferWithServices/getPricedOffer Promise<unknown>, Task 1 normalizer, CacheService.get/getTtl/set. Exports concrete service through module. No direct budget/SDK calls and no monolith dependency.

- [x] Step 1: Add a RED integration test through Nest Test.createTestingModule providing real service, adapter, normalizer and DuffelRateBudgetService. Override only DUFFEL_SDK and CacheService boundary providers. The cache double includes checkAndIncrement returning `{ allowed: true, current: 1 }`; exhaustion returns `{ allowed: false, current: 1500 }`, store failure adds `storeError: true`. Count this storage operation to verify reservations without mocking internal budget behavior. Set fresh cached catalog TTL 4; assert HIT/4, no SDK calls and no budget reservations. Run `pnpm --filter @api/backend exec jest --runInBand src/supplier/ancillary/duffel-ancillary.capability.spec.ts`, record RED missing class.
- [x] Step 2: Implement cache path and getSeatMapsAndServices signatures. Read TTL before value; ttl>3 and readable catalog returns HIT. Cache read/parse failure falls back to supplier without exposing raw values in logs.

```typescript
if (!forceRefresh) {
  const ttl = await this.cacheService.getTtl(cacheKey);
  if (ttl > 3) {
    const rawCache = await this.cacheService.get(cacheKey);
    // Parse and guard cached domain shape before returning shared values.
  }
}
```

- [x] Step 3: Add RED tests one at a time for TTL 3/0, TTL>3 without cached value, force refresh, cache parse failure, cache write failure. Implement concurrent raw lookup, guarded normalization and best-effort write TTL60:

```typescript
const [rawSeatMaps, rawOffer] = await Promise.all([
  this.adapter.getSeatMaps(offerId),
  this.adapter.getOfferWithServices(offerId),
]);
const catalog = this.normalizer.normalizeCatalog(rawSeatMaps, rawOffer);
await this.cacheService.set(cacheKey, JSON.stringify(catalog), 60);
return catalog;
```

Wrap cache read/write separately, supplier failures must not become cache hits. A deferred SDK test proves both calls start before either settles. Boundary tests prove two successful reservations for two calls, zero on cache HIT, no SDK call for denied adapter, safe budget exception propagation. Under concurrent per-call admission, a permitted sibling may start when the other is denied; do not charge twice in the service to reproduce monolith pre-reservation. Preserve old monolith suites unchanged and document this distinction.
- [x] Step 4: Add RED/GREEN missing-map tests for [], raw status404, statusCode404, meta.status404 and HttpException404 using actual adapter. Missing map retains baggage. Offer404 and seat-map500 produce 502 UPSTREAM_UNAVAILABLE, never graceful fallback. Supplier429 variants produce 429 UPSTREAM_RATE_LIMITED. Budget HttpExceptions retain 429 RATE_LIMIT_EXCEEDED/BUDGET_UNAVAILABLE and retry metadata. Use generic messages; never expose supplier error bodies.
- [x] Step 5: Add RED timeout test with fake timers and never-settling SDK promises. Implement existing 4500ms overall catalog Promise.race deadline and clear timer in finally on all outcomes. Timeout is 504 with code UPSTREAM_UNAVAILABLE (legacy wire code); never introduce GATEWAY_TIMEOUT as the body code. Assert no timer remains after success/failure. Test network timeout errors safely map to504 when applicable.
- [x] Step 6: Add RED deduplication/authoritative pricing test and implement:

```typescript
const quantities = new Map<string, number>();
for (const service of intendedServices) {
  quantities.set(service.serviceId, (quantities.get(service.serviceId) ?? 0) + service.quantity);
}
const deduplicatedServices = Array.from(quantities, ([id, quantity]) => ({ id, quantity }));
const pricedOffer = await this.adapter.getPricedOffer(offerId, deduplicatedServices);
return this.normalizer.normalizeRepricedOffer(pricedOffer, deduplicatedServices);
```

Assert SDK intended_services combines bag quantities and preserves first-seen order; authoritative amounts exactly retained; one budget reservation; input array unchanged. Add raw SDK400 invalid-identity and all-ID fallback tests, pass rejection to normalizer only for400. Test 429, budget denial, generic failure and malformed successful price safe errors. No payment authority or retries added.
- [x] Step 7: Add RED Nest module resolution/export-isolation tests then implement exact registration:

```typescript
@Module({
  imports: [ConfigModule, CacheModule, DuffelCoreModule],
  providers: [DuffelAncillaryService, DuffelAncillaryAdapter, AncillaryNormalizer],
  exports: [DuffelAncillaryService],
})
export class SupplierAncillaryModule {}
```

Compile actual module with SDK/cache test overrides; resolve service and exercise public operation. Test module export metadata matches only concrete service, no core/SDK/adapter/normalizer leakage.
- [x] Step 8: Add capability E2E importing actual SupplierAncillaryModule, cache in-memory boundary and SDK double. Exercise MISS->HIT->force-refresh, 404 seat-map+baggage and deduplicated repricing. This extracted capability remains inactive for domain consumers until T030; don't rewire app/controller/payment to satisfy E2E.
- [x] Step 9: Run focused checkpoint and compile:

```powershell
pnpm --filter @api/backend exec jest --runInBand src/supplier/ancillary src/ancillaries src/payment/ancillary-payment-validation.service.spec.ts src/duffel/duffel.service.spec.ts
pnpm --filter @api/backend exec jest --runInBand --config test/jest-e2e.json test/supplier-ancillary.e2e-spec.ts test/ancillary-catalog.e2e-spec.ts
pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit
```

- [x] Step 10: Self-review, update relevant context docs accurately with actual evidence and remaining T030/T031, mark T029 [X], stage only task files/docs and commit `feat(ancillary): add cached supplier capability and module`. Record full RED/GREEN commands, counts, compile and limitations in task-2-report.md.

### Task 2 completion evidence

All ten steps are complete by behavior and validation. The initial cache-hit and module behaviors were already green and received GREEN regression coverage; these checkboxes record completed behavior and do not claim a separately observed RED for every planned case.

Validation: the original focused checkpoint passed 12 suites/191 tests; the requested E2E checkpoint passed 2 suites/4 tests; API TypeScript compile passed; the coordinator API network-guard and API/shared lint gates passed 127 suites/2,311 tests and zero lint warnings before the later timeout-code correction. The standards-only focused rerun first exposed the existing ETIMEDOUT 502-vs-504 mismatch (41/42); separate service-only commit 8d93ab0740caaf6d6e5b1d33b110d872a9a91089 corrected it. On top of that fix, the capability/module tests passed 2 suites/42 tests, capability E2E passed 1/1, TypeScript passed, and API lint passed with zero warnings.

T030 consumer rewiring and T031 broader checkpoint remain pending.


## Slice convergence and final validation

Run speckit-converge scoped to GOAL.md T028/T029, preserving future tasks. Run code-review Standards and Spec axes in parallel against fixed starting commit 63568a22103ab6393d228391baee144f1e77f299, with one agent per axis. Resolve blockers through implementer; don't weaken tests. Run API/shared eslint, shared tests, static CI contract, API compile and full API test suite with tests/ci/node-network-guard.cjs. Remote PR/CI requires concrete approval if not already authorized; do not merge or claim remote green without execution evidence.
