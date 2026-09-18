# Tasks: Event-Driven Module Deepening

**Input**: spec.md, plan.md, research.md, data-model.md and contracts/ in this directory.
**Status**: Planned; all tasks unstarted.
**Tests**: Required by FR-014. Each behavior uses RED → GREEN → REFACTOR; do not batch all test writing before implementation.

## Phase 1 — Setup

- [x] T001 [Setup] Re-inventory payment entry points, every projection call and all booking business-state writers against current code; update `specs/024-event-driven-module-deepening/contracts/booking-events.md` and `contracts/payment-fulfillment.md` with any drift before editing runtime files.
- [x] T002 [Setup] Record pre-change HTTP success/failure/replay/Tier2 and compensation baselines in `apps/api/test/payment-fulfillment.e2e-spec.ts` using existing controller and controlled providers; record baseline commands in `specs/024-event-driven-module-deepening/validation-evidence.md`.

## Phase 2 — Foundation

These stable seams block US1 extraction. Event infrastructure/schema are deliberately deferred to US2 so US1 is independently deployable.

- [x] T003 Extract existing idempotency service/decorator and its regression tests into `apps/api/src/idempotency/payment-idempotency.service.ts`, `payment-idempotency.service.spec.ts` and `idempotency.module.ts`; preserve the complete non-saga surface and all acquisition/abandon semantics.
- [x] T004 Rewire service/decorator imports and remove duplicate payment provider registration in `apps/api/src/payment/payment.module.ts`, payment controllers/services and `apps/api/src/ancillaries/ancillaries.module.ts`, `apps/api/src/ancillaries/ancillaries.service.ts`; prove ancillary code no longer imports PaymentModule solely for idempotency.

## Phase 3 — US1: Safe payment orchestration (P1, MVP)

**Independent acceptance**: Existing confirmation/status behavior and all controlled-provider retry/recovery scenarios pass while original projection integration still runs.

- [x] T005 [US1] Add assertOwned, fenced saga checkpoint and atomic terminal completion operations plus foreground/background stale-owner tests in `apps/api/src/idempotency/payment-idempotency.service.ts` and `payment-idempotency.service.spec.ts`; predicate on key/user/path/hash/acquired lockedAt and incomplete response, prevent checkpoint regression, and reject cron-cleared/deleted ownership.
- [x] T006 [US1] Define concrete normalized inputs/outcomes and DI tokens in `apps/api/src/payment-fulfillment/ports/payment-gateway.port.ts` and `fulfillment-gateway.port.ts`, covering every input/evidence field in `contracts/payment-fulfillment.md` without SDK types or any.
- [x] T007 [P] [US1] Implement and test Stripe status normalization, capture/void keys, bounded admission and release in `apps/api/src/common/stripe-payment.adapter.ts` and `stripe-payment.adapter.spec.ts`; bind/export the payment port token in `apps/api/src/common/stripe.module.ts`.
- [x] T008 [P] [US1] Implement and test Duffel order metadata/idempotency/services, legacy redacted evidence, snapshot fallback and bounded admission in `apps/api/src/duffel/duffel-fulfillment.adapter.ts` and `duffel-fulfillment.adapter.spec.ts`; bind/export fulfillment token in `apps/api/src/duffel/duffel.module.ts`.
- [x] T009 [US1] Create `apps/api/src/payment/payment-methods.module.ts` to register/export existing PaymentMethodService once; import it from both `apps/api/src/payment/payment.module.ts` and `apps/api/src/payment-fulfillment/payment-fulfillment.module.ts`, remove the old provider registration, and preserve consent/nonfatal save behavior in `payment-method.service.spec.ts`.
- [x] T010 [US1] Extract confirmation and background orchestration with retained same-promise 25-second handoff into `apps/api/src/payment-fulfillment/payment-fulfillment.saga.ts` and `payment-fulfillment.saga.spec.ts`; retain immutable ancillary/passenger validation, compensation matrix, atomic canonical bundles and fenced completion. Assert full acquired ownership before every authorize/create/capture/void/cancel/retrieve operation and after adapter admission; test takeover before each operation and while queued, including background compensation, without holding DB locks during provider calls.
- [x] T011 [US1] Compose `apps/api/src/payment-fulfillment/payment-fulfillment.module.ts` with IdempotencyModule, SDK token providers, PaymentMethodsModule, lifecycle/intent, Prisma and audit dependencies; inject saga directly in `apps/api/src/payment/payment.controller.ts` and import saga module from `payment.module.ts`, never reverse.
- [x] T012 [US1] Remove extracted orchestration from `apps/api/src/payment/payment.service.ts`; migrate confirmation portions of `payment.service.spec.ts`, `payment-ancillary-order-recovery.spec.ts` and `payment-ancillary-pipeline.spec.ts` to saga ownership while retaining create/status tests and all existing ancillary boundary/binding cases.
- [x] T013 [US1] Complete real PostgreSQL/HTTP tests in `apps/api/test/payment-fulfillment.e2e-spec.ts` for each checkpoint resume, duplicate effects, atomic completion/rollback, stale owner before/after pending handoff and existing replay status asymmetry. Explicitly cover capture throw followed by captured, authorized/voided or unavailable evidence; failed compensation; and database failure after capture. Assert known capture never cancels order/payment, unknown remains recoverable, and lease loss prevents subsequent provider calls. Extend `apps/api/test/payment-idempotency.e2e-spec.ts` where acquisition fixtures belong.
- [x] T014 [US1] Add real Nest composition coverage in `apps/api/test/module-deepening.e2e-spec.ts` proving SDK token resolution, single PaymentMethodService registration, no PaymentModule/saga cycle and BookingRecoveryService retaining direct wrappers instead of saga ports; run US1 static/API gates and record results in `specs/024-event-driven-module-deepening/validation-evidence.md`.

## Phase 4 — US2: Event-driven safe booking projection (P1)

**Independent acceptance**: Every mutation in the event contract projects committed state; rollback/no-op emits none; listener failure preserves command success; races/privacy pass. **Deployment depends on US3** being complete; no partial producer cutover.

For T026–T030 specifically, each named service owns invoking the publisher after its outer transaction resolves, or returning events when using caller-owned context. Each named service test must assert no publish before resolution, none on rollback, and one committed batch afterward; T027 additionally asserts retry-attempt collector isolation. This is required implementation/acceptance for each task, not a generic final-test deferral.

- [x] T015 [US2] Resolve a Nest-10-compatible event-emitter version/peer requirements, update `apps/api/package.json` and `pnpm-lock.yaml`, and document chosen dependency in `context/library-docs.md` and `context/code-standards.md`; do not upgrade Nest as a side effect.
- [x] T016 [US2] Add `Booking.version` default 1 and `BookingAgentProjection.sourceVersion` default 0 to `apps/api/prisma/schema.prisma` and create `apps/api/prisma/migrations/20260915000000_booking_projection_versions/migration.sql`. In `apps/api/test/booking-projection-version-migration.e2e-spec.ts`, test legacy defaults/reference preservation and prepare a legacy-writer fixture against the upgraded schema that proves Booking.version stays unchanged. Full reset-and-repair compatibility verification runs in T038 once reconciliation exists; record migration-test exit codes in `specs/024-event-driven-module-deepening/validation-evidence.md`.
- [x] T017 [US2] Define passive envelope and the exact event catalog in `apps/api/src/domain-events/domain-event.base.ts`, `booking.events.ts`, `refund.events.ts`; add privacy/no-behavior tests in `domain-events.spec.ts`.
- [x] T018 [US2] Implement explicit transaction/event context and safe postcommit publisher in `apps/api/src/domain-events/booking-event-publisher.service.ts`, `booking-event-publisher.service.spec.ts` and `domain-events.module.ts`; test rollback disposal, retry collectors and dispatch rejection isolation without generic transaction machinery.
- [x] T019 [US2] Add `apps/api/src/booking-lifecycle/booking-state.module.ts`; move sole BookingLifecycleService registration from `booking-lifecycle.module.ts` into it, re-export through lifecycle module, retain recovery SDK/refund imports, and update `apps/api/test/module-deepening.e2e-spec.ts` to prove single instance and acyclic settlement integration.
- [x] T020 [US2] Implement guarded versioned lifecycle creation/confirm/fail/complete and transaction-aware mutation methods in `apps/api/src/booking-lifecycle/booking-lifecycle.service.ts`, `booking-lifecycle.types.ts` and `booking-lifecycle.service.spec.ts`; preserve authoritative captured FAILED recovery, exclude bookkeeping and return no events for no-op writes.
- [x] T021 [US2] Implement cycle-scoped promise hydration of coherent booking/latest-revision/ordered-segment snapshots in `apps/api/src/domain-events/booking-event-hydrator.service.ts` and `booking-event-hydrator.service.spec.ts`; prove same-cycle sharing, later-cycle reload and cleanup after failure.
- [x] T022 [US2] Extract safe mapping into `apps/api/src/booking-projection/booking-projection.service.ts`, migrate tests into `booking-projection.service.spec.ts`, and implement atomic guarded persistence in `booking-projection.repository.ts`; preserve references and prohibit fallback from a malformed authoritative revision to stale flightSnapshot.
- [x] T023 [US2] Add thin booking-only listener, metrics and module composition in `apps/api/src/booking-projection/booking-projection.listener.ts`, `booking-projection.listener.spec.ts`, `booking-projection.metrics.ts` and `booking-projection.module.ts`; isolate errors and expose bounded safe outcome counters/durations.
- [x] T024 [US2] Pass transaction/event context and flush after outer financial commit in `apps/api/src/payment-fulfillment/payment-fulfillment.saga.ts`; adapt `payment-fulfillment.saga.spec.ts` to prove projection failure cannot trigger compensation or fail a captured command.
- [x] T025 [US2] Replace four recovery projection calls/direct canonical updates with lifecycle recovery outcomes in `apps/api/src/booking-lifecycle/booking-recovery.service.ts` and `booking-recovery.service.spec.ts`; retain direct Stripe/Duffel and PROCESSING guards. Commit existing paired booking/payment status writes atomically with version/event collection; keep no-payment and captured-without-order branches' guarded booking mutation explicit, and initiate any existing automated refund outside that commit. Assert rollback preserves booking/payment plus existing PaymentEvent, BookingIntent and LedgerEntry facts; do not invent duplicate event/ledger writes in branches that currently leave them untouched. Recovery invokes publisher only after its outer commit.
- [x] T026 [US2] Route cancellation claim/finalization through lifecycle inside existing transactions in `apps/api/src/cancellation/cancellation.service.ts`, `cancellation.service.spec.ts` and `cancellation.module.ts`; preserve obligations, disruption resolution, quote locks and refund lock order.
- [x] T027 [US2] Route material/nonmaterial revision and timing updates through lifecycle context in `apps/api/src/disruption/sync/supplier-sync.service.ts` and `supplier-sync.service.spec.ts`; allocate collector per transaction retry, exclude lease housekeeping and increment once per revision commit.
- [x] T028 [US2] Route disruption acknowledge/accept aggregate changes through lifecycle context in `apps/api/src/disruption/api/disruption.service.ts` and `disruption.service.spec.ts`; preserve idempotent guards and business audit behavior.
- [ ] T029 [US2] Route refund success/failure booking transitions through BookingStateModule in `apps/api/src/refund-settlement/refund-settlement.service.ts`, `refund-settlement.service.spec.ts` and `refund-settlement.module.ts`; produce distinct refund.settled only on eligible nonreplay branch and preserve balanced ledger/lock order.
- [ ] T030 [US2] Route RETRY_WITH_FRESH_KEY booking-state reset through lifecycle within the existing retry transaction in `apps/api/src/payment/payment-refund.service.ts` and `payment-refund.service.spec.ts`; preserve refund idempotency and outer postcommit dispatch.
- [ ] T031 [US2] Remove projection service provider/export from `apps/api/src/agent-gateway/agent-gateway.module.ts`, remove old `booking-agent-projection.service.ts` after migrated consumers, drop AgentGatewayModule imports from lifecycle/cancellation and projection-related forwardRef from `apps/api/src/disruption/disruption.module.ts`; retain the other two query cycles.
- [ ] T032 [US2] Add single root EventEmitterModule.forRoot and BookingProjectionModule registration plus validated adapter settings in `apps/api/src/app.module.ts`; update `apps/api/test/module-deepening.e2e-spec.ts` to initialize real listeners and verify final imports/providers.
- [ ] T033 [US2] Add PostgreSQL event/projection tests in `apps/api/test/booking-events.e2e-spec.ts` for all inventoried transitions, no-op/rollback/nested/retry boundaries, reverse hydration completion and concurrent insertion with stable references.
- [ ] T034 [US2] Adapt `apps/api/test/booking-agent-projection-privacy.e2e-spec.ts`, `apps/api/src/agent-gateway/safe-booking-read/safe-booking-read.service.spec.ts`, `apps/api/test/chat-persistence-migration.e2e-spec.ts` and existing booking/refund/disruption E2E fixtures to eventual writes without changing owner boundaries or public DTOs.

## Phase 5 — US3: Repair and operate projections (P2)

**Independent acceptance**: Lost events and missing/stale rows repair using DB only; >100 mixed candidates progress fairly, five-worker bound holds, malformed rows stay visible. Ship with US2.

- [ ] T035 [US3] Implement LEFT JOIN missing/stale booking-ID keyset scan in `apps/api/src/booking-projection/booking-projection.repository.ts` and `booking-projection.repository.spec.ts`; implement the contract's limit/afterBookingId input and bookingIds/nextCursor/reachedEnd output, include no-source-data rows and test empty, partial and final-full-page semantics.
- [ ] T036 [US3] Implement minute-scheduled, locally nonoverlapping 100/5 repair in `apps/api/src/booking-projection/booking-projection-reconciliation.service.ts` and `booking-projection-reconciliation.service.spec.ts`; reuse hydrator/writer, advance cursor over failed/skipped outcomes, reset on reachedEnd for the next pass without scanning an extra page, and classify current/skipped/failed/repaired correctly.
- [ ] T037 [US3] Replace duplicated backfill extraction/unconditional upsert in `apps/api/prisma/scripts/backfill-booking-agent-projections.ts` with shared guarded projection writer; adapt `apps/api/test/booking-projection-backfill.e2e-spec.ts` for stable references, version fencing and repeat-safe execution.
- [ ] T038 [US3] Add `apps/api/test/booking-projection-reconciliation.e2e-spec.ts` covering suppressed events, all missing rows, malformed low IDs, >100 candidates, five-worker bound, overlapping live writes/replicas and no provider/financial calls. Complete the T016 legacy-writer compatibility fixture in `apps/api/test/booking-projection-version-migration.e2e-spec.ts`: reset projection freshness, reconcile, verify repaired data and stable agentReference, assert payment/refund/ledger rows unchanged, and record exit codes in `specs/024-event-driven-module-deepening/validation-evidence.md`.
- [ ] T039 [US3] Wire observable booking_projection.failure and projection_reconciliation stale_found/repaired/failed/current/skipped/duration snapshots using existing telemetry conventions in `apps/api/src/booking-projection/booking-projection.metrics.ts` and `booking-projection.metrics.spec.ts`; test bounded labels with identifiers only in safe logs.
- [ ] T040 [US3] Write operations and rollback/reactivation procedure in `docs/runbooks/booking-projection-reconciliation.md`, including backlog traversal, malformed source handling, minute cadence, multi-replica limitation and legacy-writer freshness reset; link it from `specs/024-event-driven-module-deepening/quickstart.md`.

## Phase 6 — Closure and cross-cutting verification

- [ ] T041 Re-run the full mutation/import inventory and module boot test in `apps/api/test/module-deepening.e2e-spec.ts`; prove no direct projection calls remain in core and every contract mutation has version/commit coverage, without altering unrelated cycles.
- [ ] T042 Run all quickstart static/API/unit/database E2E gates and controlled-provider smoke; adjust `tests/smoke/sanity.test.mjs` only if existing synchronous projection assumptions require bounded waits, and record final exit codes/scenario coverage in `specs/024-event-driven-module-deepening/validation-evidence.md`.
- [ ] T043 Synchronize implemented boundaries, dependencies and completion evidence in `context/architecture.md`, `context/progress-checker.md`, `context/library-docs.md` and `context/code-standards.md`; do not label planned code as implemented.
- [ ] T044 Review implemented code against `specs/024-event-driven-module-deepening/spec.md`, `plan.md` and `tasks.md` with subagents; append actionable gaps as tasks and resolve HIGH/CRITICAL findings before recording implementation signoff in `validation-evidence.md`.

## Dependencies and parallel execution

T001–T004 → US1 (T005–T014) → US2 (T015–T034) → US3 (T035–T040) → closure. US2/US3 are separate testable stories but one deployment boundary. Do not activate incomplete event-only writes.

- US1: T007 and T008 can run in parallel after T006; separate files and SDK modules. T010 waits for T005–T009; T011–T014 follow sequentially.
- US2: keep writer/module tasks sequential because lifecycle interfaces and shared composition overlap. After T032, T033 database event suite and T034 privacy fixtures may run independently if their databases are isolated; no automatic [P] designation while setup is shared.
- US3: T035 → T036 → T037 → T038 → T039 → T040. Avoid parallel repository edits; run independent scenario fixtures only with isolated databases.

## Traceability and delivery strategy

| Requirements | Tasks |
|---|---|
| FR-001, FR-002, FR-005 | T002, T010–T014, T024, T042 |
| FR-003 | T006–T008, T032 |
| FR-004 | T003–T005, T010, T013 |
| FR-006 | T019, T025–T032, T041 |
| FR-007, FR-008, FR-013 | T017–T020, T024–T030, T033 |
| FR-009, FR-010 | T021–T023, T033–T034 |
| FR-011 | T016, T035–T038 |
| FR-012 | T014, T023, T032, T039–T040, T043 |
| FR-014 | T002, T005–T044 (behavior-specific tests and final gates) |

Suggested MVP: US1 after setup/foundation, with its regression gates. Then deliver the complete projection slice together. Total 44 tasks: setup 2, foundation 2, US1 10, US2 20, US3 6, closure 4. Task IDs are sequential; every task has a concrete file path. No task is marked complete by planning review.
