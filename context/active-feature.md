# Active Feature

This file tracks the currently active in-flight feature, its checkpoints, and exit gates.

---

## Feature 029 — Narrow the Duffel Supplier Boundary

- **Status**: In Progress (Phase 5; T032–T041 complete locally; T042–T043 pending)
- **Branch**: `codex/029-duffel-provider-narrowing`
- **Specification**: [specs/029-duffel-provider-narrowing/spec.md](../specs/029-duffel-provider-narrowing/spec.md)
- **Implementation Plan**: [specs/029-duffel-provider-narrowing/plan.md](../specs/029-duffel-provider-narrowing/plan.md)
- **Tasks**: [specs/029-duffel-provider-narrowing/tasks.md](../specs/029-duffel-provider-narrowing/tasks.md)

### Current Summary
Phases 0–4 are complete locally. Phase 5 is complete locally through T041: fulfillment now lives in `SupplierOrderModule`, and cancellation, booking recovery, disruption sync, and payment fulfillment consume its exports. T040 preserves recoverable saga state when cancellation is unconfirmed; T041 defers unsafe stale recovery and requires explicit cancellation proof. T040 review had zero findings. T041 validation on 2026-10-02 passed the recovery suite (55/55), payment safety E2E (2/2), API TypeScript check, and API lint. Fixture corrections were explicitly approved on 2026-10-02 and documented beside the corrected cases. Earlier T039 validation and Slice 3 convergence/review findings are in the [slice verification record](../specs/029-duffel-provider-narrowing/slice-3-verification.md); they are separate from T041 results. T042–T043, neutral naming/schema (T044–T054), and final audit (T055–T057) remain pending; Feature 029 is not complete.

---

### Phase 0 — Research & Constitution Alignment
- [x] Reconcile codebase against ADR and specify single internal SDK/config/budget owner.
- [x] Define atomic 1,500 daily Duffel attempt rate budget policy with 1,000 user / 500 agent allocations.
- [x] Define `FLIGHT_SEARCH_PORT` and `FULFILLMENT_GATEWAY_PORT` capability contracts.

Exit gate:
```text
constitution check passes; rate budget semantics locked; boundary contracts approved
```

### Phase 1 — Setup & Behavior Baseline
- [x] Characterize raw vs cached flight searches, UUID generation, rate budget, and expired offer behavior.
- [x] Characterize ancillary catalog, missing seat-map fallback, and priced-offer reconciliation.
- [x] Characterize fulfillment adapter, order idempotency, payment saga, and unconfirmed cancellation paths.
- [x] Seal private bracket escape hatch `duffelService['duffel']` with public `getOfferById`.

Exit gate:
```text
zero direct SDK property access; baseline characterization suites pass (260/260 tests)
```

### Phase 2 — Core Foundation & Rate Budget
- [x] Implement `DuffelCoreModule` exporting singleton `DUFFEL_SDK` provider.
- [x] Implement atomic dual-counter rate budget in `CacheService` via Redis Lua script.
- [x] Implement `DuffelRateBudgetService` with UTC midnight reset and attempted-call charging semantics.
- [x] Wire `DuffelCoreModule` into `DuffelModule` and remove obsolete monthly budget accounting.

Exit gate:
```text
every remote attempt reserved atomically; cache hits bypass budget; core suites pass (133/133)
```

### Phase 3 — Search Capability Isolation (User Story 1 🎯)
- [x] Extract `DuffelSearchAdapter` encapsulating raw offer search and live offer lookup with budget reservation.
- [x] Implement deterministic RFC 4122 v4 `FlightOfferNormalizer` with zero `any`.
- [x] Implement `DuffelSearchService` with Redis SHA-256 query caching (15-min TTL) and caller sub-allocations.
- [x] Relocate midnight cleanup cron to `flight-offer-cleanup.service.ts`.
- [x] Package `SupplierSearchModule` exporting strictly `FLIGHT_SEARCH_PORT`.
- [x] Rewire `FlightsService` and `FlightsModule` to consume `FLIGHT_SEARCH_PORT`.
- [x] Rewire `BookingIntentService` live offer verification to consume `FLIGHT_SEARCH_PORT`.
- [x] Migrate stored raw-offer JSON readers in Readiness, Agent Gateway, and Chat Handoff to port.

Exit gate:
```text
zero Duffel imports in search/intent/gateway; 100% search parity; Phase 3 checkpoint passes (323/323)
```

### Phase 4 — Ancillary Capability Isolation (User Story 2)
- [x] Add regression coverage for installed SDK 404 error shape preserving `seatMapAvailable: false` (T025).
- [x] Lock authoritative repricing totals, aggregated duplicate baggage, and currency validation (T026).
- [x] Implement metered raw `DuffelAncillaryAdapter` with constructor SDK and budget injection (T027).
- [x] Implement guarded `AncillaryNormalizer` mapping seats, baggage, and invalid identities (T028).
- [x] Implement `DuffelAncillaryService` and `SupplierAncillaryModule` (T029 local pass).
- [x] Rewire `AncillariesModule` and `AncillaryCatalogService` to supplier ancillary module (T030).
- [x] Rewire `PaymentModule` and ancillary payment validation to supplier ancillary module (T030).
- [x] Ancillary checkpoint verification gate and API regression pass (T031).

Exit gate:
```text
✅ Passed locally: ancillary consumers isolated from legacy Duffel; catalog/repricing parity verified (11 focused suites/153 tests, API TypeScript exit 0, network-guard API suite 127/127 suites).
```

### Phase 5 — Order Capability Isolation (User Story 3)
- [x] Lock order-operation parity characterization (T032; commit `93fe963a`, reviewed and approved).
- [x] Add safe-compensation and recovery-deferral characterization and implementation (T033; commits `1739d209` and `acc77e0b`; focused checks, code review, scoped convergence, and full API gate pass).
- [x] Extract the metered raw `DuffelOrderAdapter` (T034; commit `2675a0f2`, review GO with no Important/Critical findings).
- [x] Extract order/snapshot normalization and remove vendor types from the disruption normalizer (T035; `2223c7c9`; focused checks and independent review passed).
- [x] Extract cancellation quote/confirm/replay orchestration over the metered order adapter (T036; `0c28be32`; explicit cancelled-order evidence required for replay success).
- [x] Extract order retrieval and snapshot recovery plus service-graph E2E (T037; `2a85a113`; focused checks and independent review passed).
- [x] Add `SupplierOrderModule` and bind fulfillment capability (T038; present on the current base).
- [x] Rewire cancellation, booking recovery, sync, fulfillment modules, and AppModule to supplier order boundaries (T039; task review and local gates passed).
- [x] Preserve saga retry checkpoint, payment hold, PROCESSING booking, and order evidence during unconfirmed compensation (T040; reviewed with zero findings).
- [x] Defer stale recovery on missing/invalid order IDs, lookup failures, unconfirmed cancellation, and typed budget/rate denial; require explicit cancellation proof (T041; recovery 55/55, safety E2E 2/2, API typecheck and lint passed).
- [ ] Delete the legacy Duffel monolith after equivalent tests and consumer migration (T042).
- [ ] Run the order/saga/recovery/privacy and API compile checkpoint (T043).

Exit gate:
```text
unconfirmed cancellations preserve processing/hold; order operations isolated
```

### Phase 6 — Neutral Naming & Physical Schema (User Story 4; T044–T054)
- [ ] Pin wire/HMAC, legacy snapshots, and provider-ID boundary tests (T044–T046).
- [ ] Rename internal types and add explicit current-wire compatibility mappings (T047–T051).
- [ ] Apply forward physical Prisma column/index renames and regenerate the client (T052–T053).
- [ ] Validate fresh/existing migrations and cross-service compatibility (T054).

Exit gate:
```text
clean migration from scratch; zero orphan duffel database columns; wire compatibility preserved
```

### Phase 7 — Final Verification & Audit (T055–T057)
- [ ] Execute full API/shared/web/agent, E2E, security, and remote CI gates (T055).
- [ ] Audit supplier boundary and provider-name compatibility exceptions (T056).
- [ ] Synchronize implemented architecture, progress, and relevant library guidance (T057).

Exit gate:
```text
all local and remote gates pass; 0 regressions; PR merged to development
```
