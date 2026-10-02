# Phase 5 Slice 2 — approved execution plan

Approved 2026-10-02. Scope: T035, T036, T037 only. Review baseline: `72e217e6cbb5147f34d46625433ff50131c14c20`.

## Boundaries and execution

One Luna 6/max implementer owns each task. T035 and T036 have independent file ownership; T037 starts after T035 is verified and committed. The orchestrator serializes commits and task/document updates. One independent reviewer checks each task; final Standards and Spec reviewers run separately. No new dependency, endpoint, generic capability port, database migration, or consumer rewiring. SupplierOrderModule and fulfillment binding remain T038.

Use constructor injection for concrete internal supplier collaborators. Feature consumers continue to use their approved exported interfaces; no feature code imports SDK internals. No type assertions or `any` in added code/tests. Tests use real internal collaborators and mock only SDK, budget/store, or HTTP boundaries. Existing test expectations remain immutable. Stop and report the same failure after one corrective attempt.

## T035 — snapshot normalization

Owned files: `apps/api/src/supplier/order/order-snapshot.normalizer.ts`, adjacent spec, `apps/api/src/disruption/domain/itinerary-normalizer.ts`, and the legacy `DuffelService` snapshot method if needed to share mapping without changing constructor compatibility. Existing itinerary tests are preserved; add coverage without changing existing expectations.

Public service API:

```typescript
@Injectable()
export class OrderSnapshotNormalizer {
  mapDuffelOrderToSnapshots(order: unknown): {
    flightSnapshot: FlightSnapshot;
    passengerSnapshot: PassengerSnapshot;
  };
  normalizeDuffelOrder(order: unknown): NormalizedSegment[];
}
```

Pure internal mapping functions may support the injectable service and deprecated legacy delegates, avoiding manual service construction. Disruption retains `normalizeFlightSegments(segments: FlightSegmentSnapshot[]): NormalizedSegment[]` and a deprecated type-neutral `normalizeDuffelOrder(order: unknown)` compatibility delegate. Supplier code may import the neutral NormalizedSegment type only; no runtime cycle.

1. Add one failing public-interface test for exact multi-slice flight/passenger snapshot JSON parity; run it RED.
2. Extract minimal mapping with runtime narrowing; run GREEN. Preserve operating/marketing fallback, ISO duration formatting, stops, last available cabin, first-passenger contacts, missing-name/date defaults, optional terminal/aircraft fields, and segment IDs.
3. Add one failing ordered itinerary test covering sliceOrder/segmentOrder/globalOrder, distinct operating/marketing carriers, city fallbacks, and local dates; implement and run GREEN.
4. Add incremental legacy persisted-snapshot and malformed/partial input checks; preserve existing partial-order defaults rather than inventing stricter completeness requirements. Verify no vendor types remain in disruption domain.
5. Refactor green; run focused tests, typecheck, and package lint. Reviewer checks T035 only. Mark T035 complete and commit its files.

```powershell
pnpm --filter @api/backend exec jest --runInBand src/supplier/order/order-snapshot.normalizer.spec.ts src/disruption/domain/itinerary-normalizer.spec.ts src/duffel/duffel.service.spec.ts
pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit
pnpm --filter @api/backend lint
```

## T036 — cancellation

Owned files: new cancellation service and adjacent spec. If upstream error translation loses definitive already-cancelled evidence, prefer reconciling failed cancel through the existing adapter's order status rather than accepting message fragments. Coordinate any essential adapter changes with the orchestrator.

```typescript
@Injectable()
export class DuffelCancellationService {
  constructor(private readonly orderAdapter: DuffelOrderAdapter) {}
  createCancellationQuote(orderId: string): Promise<DuffelCancellationQuote>;
  confirmCancellationQuote(quoteId: string): Promise<DuffelConfirmedCancellation>;
  cancelOrder(orderId: string): Promise<unknown>;
}
```

Own concrete output types within supplier/order or reuse supplier-neutral shared types; do not import types from the legacy monolith. Preserve quote extension fields, nullable money/currency, pending versus confirmed status, and HttpException codes/status including budget denial. No environment-triggered fabricated cancellation quotes.

1. Add one failing quote creation test through the service with real adapter and mocked SDK/budget; implement minimal guarded quote mapping and run GREEN.
2. Add pending/confirmed quote tests one at a time; preserve confirmation timestamp and refunds.
3. Add failing replay test: upstream cancellation fails but order retrieval explicitly reports cancelled; implement idempotent success. Active/unknown order and failed reconciliation must retain failure. Budget denial must not trigger speculative reconciliation calls or bypass budget.
4. Add incremental malformed response/error/status tests and guards against generic non-cancellable or unconfirmed evidence being treated as success.
5. Refactor green; focused tests, typecheck, package lint; independent T036 review; mark and commit.

```powershell
pnpm --filter @api/backend exec jest --runInBand src/supplier/order/duffel-cancellation.service.spec.ts src/supplier/order/duffel-order.adapter.spec.ts
pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit
pnpm --filter @api/backend lint
```

## T037 — recovery

Owned files: new recovery service and adjacent spec; one dedicated E2E spec exercising the new services together through Nest DI, real adapter and normalizer, and external SDK/budget boundaries. Do not bind production modules before T038.

```typescript
@Injectable()
export class DuffelRecoveryService {
  constructor(
    private readonly orderAdapter: DuffelOrderAdapter,
    private readonly normalizer: OrderSnapshotNormalizer,
  ) {}
  retrieveOrder(orderId: string): Promise<DuffelRecoveredOrder>;
  retrieveCompleteOrder(orderId: string): Promise<unknown>;
  recoverOrderSnapshots(orderId: string): Promise<{
    flightSnapshot: FlightSnapshot;
    passengerSnapshot: PassengerSnapshot;
  }>;
}
```

Recovered status retains the existing ACTIVE/CANCELLED shape, where cancelled_at or confirmed cancellation establishes CANCELLED. A cancellation ID alone is insufficient. Complete retrieval preserves raw data. Snapshot recovery makes exactly one complete-order retrieval and delegates to the normalizer. Upstream failures retain `UPSTREAM_ORDER_RETRIEVAL_FAILED`; typed budget denials retain their existing status/code. Partial snapshots retain legacy defaults.

1. Add failing active-order behavior through real internal collaborators; implement and run GREEN.
2. Add cancelled_at, confirmed cancellation, and unconfirmed cancellation-ID cases incrementally; preserve adapter status semantics.
3. Add failing snapshot recovery test and minimal delegation; verify exact output and one budget reservation per retrieval.
4. Add partial-order, malformed complete-order, upstream-error, and budget-denial behavior tests incrementally.
5. Add Nest application E2E covering quote/confirm/recovery and safe replay, preserving budget admission and legacy snapshot output. Use external mocks only, no database mutations.
6. Focused tests, E2E, typecheck, package lint; independent T037 review; mark and commit.

```powershell
pnpm --filter @api/backend exec jest --runInBand src/supplier/order/duffel-recovery.service.spec.ts
pnpm --filter @api/backend exec jest --config test/jest-e2e.json --runInBand supplier-order-services
pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit
pnpm --filter @api/backend lint
```

## Slice gates

Run order checkpoint from quickstart, API/shared lint, shared tests, API typecheck, network-guard full API test suite, static CI contract, and focused E2E. Assess convergence only for T035–T037, leaving later tasks pending. Final code-review compares baseline...HEAD with separate Standards and Spec agents. Resolve blocking findings, update active-feature/progress/architecture with actual results, commit documentation, push existing feature branch/PR, and use ci-feedback-loop to verify HEAD. Never claim remote CI passed without success evidence.

Self-review: all three tasks mapped to exact files, interfaces and executable checks; behavior tests precede implementation; no placeholders or new framework; existing task IDs/order unchanged.
