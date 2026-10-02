# Active Feature

This file tracks the currently active in-flight feature, its checkpoints, and exit gates.

---

## Feature 029 — Narrow the Duffel Supplier Boundary

- **Status**: In Progress (Phase 5 In Progress; Completed Locally through T034)
- **Branch**: `codex/029-duffel-provider-narrowing`
- **Specification**: [specs/029-duffel-provider-narrowing/spec.md](../specs/029-duffel-provider-narrowing/spec.md)
- **Implementation Plan**: [specs/029-duffel-provider-narrowing/plan.md](../specs/029-duffel-provider-narrowing/plan.md)
- **Tasks**: [specs/029-duffel-provider-narrowing/tasks.md](../specs/029-duffel-provider-narrowing/tasks.md)

### Current Summary
Phase 0 (research/ADR), Phase 1 (baseline locks), Phase 2 (core SDK provider & atomic Redis rate budget), and Phase 3 (`FLIGHT_SEARCH_PORT` extraction, normalizer, and consumer rewiring across Flights, BookingIntent, Readiness, and ChatHandoff) are fully implemented and verified (US1 complete). Phase 4 (T025–T031), including `DuffelAncillaryService`, `SupplierAncillaryModule`, consumer rewiring, the ancillary/payment Jest checkpoint (11 suites, 153 tests), API TypeScript check, supplier ancillary module E2E (1 suite, 1 test), and post-T030 network-guard API suite (127 suites, 2,312 tests), is complete locally. Phase 5 has started: T032–T034 are complete with code review and scoped convergence; the latest API unit gate on `f3793c26` passed (128 suites, 2,359 tests), with typecheck and API/shared lint passing. Standards review has 0 open findings (2 resolved), and Spec review is GO. PR #361 CI is pending while two approved E2E positive-fixture corrections are applied without changing assertions. T035–T043 remain pending, including order consumer rewiring; legacy monolith deletion and Phases 7–8 remain pending.

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
- [ ] Complete later order normalization, cancellation/recovery services, fulfillment binding, consumer rewiring, and related work (T035–T043; pending).

Exit gate:
```text
unconfirmed cancellations preserve processing/hold; order operations isolated
```

### Phase 6 — Monolith Deletion (User Story 4)
- [ ] Decommission legacy `DuffelService` and `DuffelModule` (T039).
- [ ] Verify clean architecture boundary census: zero bracket access, zero direct SDK imports (T040).

Exit gate:
```text
DuffelService and DuffelModule deleted; zero residual imports across codebase
```

### Phase 7 — Neutral Naming & Schema Migration (User Story 5)
- [ ] Rename Nest modules and internal domain types to `Supplier` / `Flight` (T041–T042).
- [ ] Author forward Prisma physical migration renaming columns and indices (`duffel_` -> `supplier_`) (T043).
- [ ] Preserve legacy booking snapshot JSON reader compatibility (T044).
- [ ] Test migration from scratch and against existing schema copies (T045).

Exit gate:
```text
clean migration from scratch; zero orphan duffel database columns; wire compatibility preserved
```

### Phase 8 — Final Verification & Audit
- [ ] Execute quickstart test matrix across all packages (T046).
- [ ] Perform boundary and naming census allowlist audit (T047).
- [ ] Execute local security, privacy, and HMAC attestation gates (T048).
- [ ] Remote CI pipeline convergence and green PR status (T049–T050).
- [ ] Synchronize context documentation (`context/architecture.md`, `context/progress-checker.md`).

Exit gate:
```text
all local and remote gates pass; 0 regressions; PR merged to development
```
