# Tasks: Deepen Codebase Architecture

**Input**: Design documents from specs/019-improve-architecture/

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Required for every architecture slice because Feature 019 preserves public behavior while changing critical payment, booking, agent, and web boundaries.

**Organization**: Tasks are grouped by user story and ordered by the approved characterize → add → cut over → remove workflow.

## Format: [ID] [P?] [Story] Description

- **[P]**: Can run in parallel because it changes different files and does not depend on an incomplete task.
- **[Story]**: Maps the task to a user story in spec.md.
- **[x]**: Verified complete from repository code, tests, branch history, and context/progress-checker.md on 2026-08-22.
- **[ ]**: Still required. Existing partial or legacy behavior does not count as complete unless the target Feature 019 boundary and its verification are present.

---

## Phase 1: Setup and Delivery Contract

**Purpose**: Establish the approved architecture, migration sequence, and executable validation gates.

- [x] T001 Record the six-slice implementation order, rollout boundaries, and target source layout in specs/019-improve-architecture/plan.md
- [x] T002 [P] Define the target entities and in-process contracts in specs/019-improve-architecture/data-model.md and specs/019-improve-architecture/contracts/
- [x] T003 [P] Document focused and full regression commands for all six slices in specs/019-improve-architecture/quickstart.md

---

## Phase 2: Foundational Behavior Characterization

**Purpose**: Freeze public behavior before module ownership changes. These tests remain regression gates for every later phase.

**Critical**: No target module should replace legacy behavior without its corresponding characterization gate.

- [x] T004 [P] Characterize equivalent inline, webhook, cron, and admin refund outcomes in apps/api/test/characterization/refund-characterization.e2e-spec.ts
- [x] T005 [P] Characterize booking lifecycle, recovery, management responses, and the existing Payment↔Booking cycle in apps/api/test/characterization/booking-characterization.e2e-spec.ts
- [x] T006 [P] Characterize trusted snapshot validation, TTL, replacement, ownership, and privacy projection in apps/agent/tests/characterization/test_snapshot_characterization.py
- [x] T007 [P] Characterize all eight SSE event shapes, ordering, and failure cleanup sequencing in apps/agent/tests/characterization/test_sse_characterization.py
- [x] T008 [P] Characterize browser Flight Search and Booking Management behavior and record credential/transport leakage baselines in apps/web/tests/characterization/search-seam.characterization.spec.ts and apps/web/tests/characterization/booking-seam.characterization.spec.ts
- [x] T009 [P] Characterize Agent Gateway route, authentication, status, response, and privacy compatibility in apps/api/test/characterization/agent-gateway-characterization.e2e-spec.ts
- [x] T010 Run the cross-workspace characterization regression gate and record passing evidence in context/progress-checker.md

**Checkpoint**: The behavior-preservation safety rail is complete.

---

## Phase 3: User Story 1 - Settle Every Verified Refund Consistently (Priority: P1) MVP

**Goal**: Make one provider-blind settlement boundary own terminal Refund Transaction, ledger, Payment, cancellation obligation, Booking, event, and audit state for every trigger.

**Independent Test**: Submit equivalent verified outcomes through inline, webhook, cron, and admin paths; verify identical state, exactly one balanced ledger pair, correct partial/full aggregates, and idempotent replay.

### Tests and schema expansion

- [x] T011 [P] [US1] Add CancellationRefundObligation, Refund Transaction linkage, and refund-linked ledger constraints in apps/api/prisma/schema.prisma
- [x] T012 [P] [US1] Add the additive expand migration in apps/api/prisma/migrations/20260822000000_cancellation_refund_obligation_expand/migration.sql
- [x] T013 [US1] Implement restart-safe obligation and ledger backfill validation in apps/api/prisma/scripts/backfill-cancellation-refund-obligations.ts
- [x] T014 [P] [US1] Cover conversion, quarantine, idempotency, relationship, and balanced-ledger migration invariants in apps/api/src/payment/backfill-cancellation-refund-obligations.spec.ts and apps/api/test/cancellation-refund-obligation-migration.e2e-spec.ts

### Reservation and provider-blind settlement

- [x] T015 [US1] Implement Payment-first locking, dual-capacity reservation, and idempotency reuse in apps/api/src/refund/refund-transaction.service.ts and apps/api/src/refund/refund.module.ts
- [x] T016 [P] [US1] Cover concurrent capacity, active/successful aggregates, retry reuse, and mismatch rejection in apps/api/src/refund/refund-transaction.service.spec.ts
- [x] T017 [US1] Implement normalized provider-blind terminal settlement and module wiring in apps/api/src/refund-settlement/refund-settlement.types.ts, apps/api/src/refund-settlement/refund-settlement.service.ts, and apps/api/src/refund-settlement/refund-settlement.module.ts
- [x] T018 [P] [US1] Cover idempotent replay, ledger uniqueness, partial fulfillment, dispute overlays, zero obligations, and failures in apps/api/src/refund-settlement/refund-settlement.service.spec.ts
- [x] T019 [US1] Prove multi-transaction fulfillment, capacity protection, replay, direct refunds, and state projections against PostgreSQL in apps/api/test/refund-settlement.e2e-spec.ts

### Trigger cutover

- [x] T020 [US1] Convert inline cancellation refunds to reserve, call Stripe outside locks, and settle normalized INLINE outcomes in apps/api/src/payment/payment-refund.service.ts
- [x] T021 [P] [US1] Convert verified Stripe webhook outcomes to unified WEBHOOK settlement in apps/api/src/payment/payment-webhook.service.ts
- [x] T022 [P] [US1] Convert scheduled refund recovery outcomes to unified CRON settlement in apps/api/src/payment/payment-cron.service.ts and apps/api/src/payment/payment-refund.service.ts
- [x] T023 [P] [US1] Convert administrator resolution outcomes to unified ADMIN settlement with actor attribution in apps/api/src/payment/admin-refund.controller.ts and apps/api/src/payment/payment-refund.service.ts
- [x] T024 [P] [US1] Verify all four cutover paths in apps/api/src/payment/payment-refund.service.spec.ts, apps/api/src/payment/payment-webhook.service.spec.ts, apps/api/src/payment/payment-cron.service.spec.ts, and apps/api/src/payment/admin-refund.controller.spec.ts
- [x] T025 [US1] Replace booking-scoped cancellation refund idempotency with transaction-specific identities while preserving retry reuse in apps/api/src/payment/payment-refund.service.ts and apps/api/src/refund/refund-transaction.service.ts

### Contract migration and final gate

- [x] T026 [US1] Add the contract migration that requires cancellation obligation linkage and removes Refund.bookingId and Booking.cancellationRefund only after the observation window in apps/api/prisma/schema.prisma and apps/api/prisma/migrations/20260823000000_refund_obligation_contract/migration.sql
- [x] T027 [US1] Add preflight, reverse-mapping, abort/quarantine, rollback, and cleanup-eligibility procedures for the contract migration in docs/runbooks/refund-settlement-migration.md
- [x] T028 [P] [US1] Add settlement replay/conflict, reservation rejection, backfill mismatch, and ledger invariant telemetry without raw provider data or PII in apps/api/src/refund-settlement/refund-settlement.service.ts and apps/api/src/refund/refund-transaction.service.ts
- [x] T029 [US1] Run Feature 019 Gate 1 after the contract migration and record exact migration, unit, E2E, lint, typecheck, and rollback evidence in context/progress-checker.md and context/architecture.md

**Checkpoint**: User Story 1 is complete only when Slice 1D is contracted safely and Gate 1 passes.

---

## Phase 4: User Story 2 - Isolate Booking Lifecycle, Reads, and Cancellation (Priority: P2)

**Goal**: Replace the broad BookingService and Payment↔Booking cycle with provider-blind Lifecycle, Booking Management, and supplier-first Cancellation boundaries.

**Independent Test**: Compile with no Payment↔Booking forwardRef or broad BookingService injection, then pass confirmation, recovery, query, disruption, and cancellation behavior through public interfaces.

### Tests and implementation

- [x] T030 [P] [US2] Add failing normalized lifecycle and recovery unit tests in apps/api/src/booking-lifecycle/booking-lifecycle.service.spec.ts and apps/api/src/booking-lifecycle/booking-recovery.service.spec.ts
- [x] T031 [US2] Define BookingPipelineOutcome and implement provider-blind booking transitions in apps/api/src/booking-lifecycle/booking-lifecycle.types.ts, apps/api/src/booking-lifecycle/booking-lifecycle.service.ts, and apps/api/src/booking-lifecycle/booking-lifecycle.module.ts
- [x] T032 [US2] Move provider-aware stale recovery and existing schedules behind the lifecycle core in apps/api/src/booking-lifecycle/booking-recovery.service.ts
- [ ] T033 [US2] Replace Payment's broad BookingService calls with BookingLifecycleService at every confirmation, failure, and recovery point in apps/api/src/payment/payment.service.ts and apps/api/src/payment/payment.service.spec.ts
- [ ] T034 [P] [US2] Rewire disruption reconciliation to BookingLifecycleService in apps/api/src/disruption/sync/reconciliation.service.ts, apps/api/src/disruption/disruption.module.ts, and apps/api/src/disruption/sync/reconciliation.service.spec.ts
- [ ] T035 [US2] Move safe booking projection write ownership behind a booking-owned provider without introducing a lifecycle↔gateway cycle in apps/api/src/booking-lifecycle/booking-agent-projection-writer.service.ts and apps/api/src/agent-gateway/booking-agent-projection.service.ts
- [x] T036 [P] [US2] Add failing list, detail, disruption projection, itinerary mapping, sorting, and tenant-isolation tests in apps/api/src/booking-management/booking-management.service.spec.ts
- [x] T037 [US2] Extract safe read projections into apps/api/src/booking-management/booking-management.service.ts and apps/api/src/booking-management/booking-management.module.ts
- [ ] T038 [P] [US2] Add failing cancellation status, quote, supplier-first cancellation, recovery, obligation, and refund-trigger tests in apps/api/src/cancellation/cancellation.service.spec.ts
- [ ] T039 [US2] Extract cancellation orchestration without terminal settlement writes into apps/api/src/cancellation/cancellation.service.ts and apps/api/src/cancellation/cancellation.module.ts
- [ ] T040 [US2] Make Booking HTTP composition inject Booking Management and Cancellation directly in apps/api/src/booking/booking.controller.ts, apps/api/src/booking/booking.controller.spec.ts, and apps/api/src/booking/booking.module.ts
- [ ] T041 [US2] Remove the mutual BookingModule/PaymentModule forwardRef imports and update module composition in apps/api/src/booking/booking.module.ts and apps/api/src/payment/payment.module.ts
- [ ] T042 [US2] Remove BookingService and its exports after all production callers migrate from apps/api/src/booking/booking.service.ts and apps/api/src/booking/booking.module.ts
- [ ] T043 [US2] Run Feature 019 Gate 2, add a no-cycle/no-broad-service static assertion, and record unit, E2E, typecheck, build, observability, and rollback evidence in apps/api/test/characterization/booking-characterization.e2e-spec.ts, context/architecture.md, and context/progress-checker.md

**Checkpoint**: User Story 2 is independently testable with no Payment↔Booking cycle.

---

## Phase 5: User Story 3 - Centralize Trusted Search Snapshot Integrity (Priority: P3)

**Goal**: Put snapshot creation, atomic replacement, validation, selection, and privacy-safe projections behind one authoritative lifecycle.

**Independent Test**: Create, persist, reload, replace, validate, select, and project through TrustedSearchSnapshotLifecycle while rejecting stale or malformed state and preserving handoff behavior.

- [x] T044 [P] [US3] Add failing lifecycle, stale-writer, expiry, selection, legacy-normalization, and privacy tests in apps/agent/tests/test_trusted_snapshot.py and apps/agent/tests/test_search_snapshot.py
- [x] T045 [US3] Create canonical SnapshotOwner, TrustedSearchSnapshot, TrustedSearchOffer, and ResolvedOfferSelection models in apps/agent/src/agent/trusted_search_snapshot/models.py
- [x] T046 [US3] Implement owner-scoped Redis persistence and atomic version-aware replacement in apps/agent/src/agent/trusted_search_snapshot/repository.py
- [x] T047 [US3] Implement next_version, create_or_replace, load_active, select, safe projection, and delete operations in apps/agent/src/agent/trusted_search_snapshot/lifecycle.py and apps/agent/src/agent/trusted_search_snapshot/__init__.py
- [x] T048 [US3] Add one fail-closed legacy graph-state normalization boundary for snapshot aliases in apps/agent/src/agent/trusted_search_snapshot/lifecycle.py
- [x] T049 [P] [US3] Route search snapshot creation and identifier-free LLM projection through the lifecycle in apps/agent/src/agent/tools/search_flights.py
- [x] T050 [P] [US3] Route selection validation through ResolvedOfferSelection in apps/agent/src/agent/tools/signal_checkout_intent.py
- [x] T051 [P] [US3] Route active/selectable checkout validation through the lifecycle in apps/agent/src/agent/graph/checkout_gate.py
- [x] T052 [P] [US3] Route handoff node selection through resolved lifecycle state while keeping HMAC and token issuance in NestJS in apps/agent/src/agent/graph/nodes.py
- [x] T053 [US3] Route chat/browser snapshot loading and projection through the lifecycle in apps/agent/src/agent/streaming/sse.py or apps/agent/src/agent/chat_turn/runner.py
- [x] T054 [US3] Convert apps/agent/src/agent/models/snapshot.py and apps/agent/src/agent/repositories/trusted_snapshot_repository.py to compatibility re-exports, then remove them after full gates pass
- [x] T055 [US3] Run Feature 019 Gate 3 plus handoff/privacy/T093 coverage and record atomic replacement, rejection telemetry, compatibility, rollback, and cleanup evidence in context/architecture.md and context/progress-checker.md

**Checkpoint**: User Story 3 has one production snapshot authority and no identifier leakage.

---

## Phase 6: User Story 4 - Separate Chat Turn Lifecycle from SSE Transport (Priority: P4)

**Goal**: Make a typed, transport-independent runner own durable turn orchestration and cancellation-safe cleanup while SSE becomes a thin adapter.

**Independent Test**: Exercise ChatTurnRunner without HTTP, then verify SSE encoding, disconnect closure, fence loss, failure ordering, and shutdown cleanup independently.

- [x] T056 [P] [US4] Add failing golden contracts for all eight strict event variants and unchanged names, keys, and order in apps/agent/tests/test_event_contracts.py
- [x] T057 [US4] Implement the authoritative strict ChatTurnEvent union and SSE encoding helpers in apps/agent/src/agent/chat_turn/events.py
- [x] T058 [P] [US4] Add failing runner success, failure, disconnect, fence-loss, cancellation, and shutdown tests in apps/agent/tests/test_chat_turn_runner.py
- [x] T059 [US4] Define ChatTurnCommand and the transport-independent runner interface in apps/agent/src/agent/chat_turn/models.py, apps/agent/src/agent/chat_turn/runner.py, and apps/agent/src/agent/chat_turn/__init__.py
- [x] T060 [US4] Move session, memory, snapshot, lease, guardrail, persistence, recovery, and summarization ownership into apps/agent/src/agent/chat_turn/runner.py
- [x] T061 [US4] Isolate LangGraph astream_events v2 parsing and typed event ordering in apps/agent/src/agent/chat_turn/runner.py
- [x] T062 [US4] Implement one awaited cancellation-safe finalizer that blocks stale fencing owners and completes durable cleanup before terminal errors in apps/agent/src/agent/chat_turn/runner.py

- [ ] T063 [US4] Reduce apps/agent/src/agent/streaming/sse.py to admission, HTTP error mapping, disconnect detection, runner closure, and typed SSE encoding
- [ ] T064 [US4] Replace raw active queue shutdown mutation with cancelled and awaited runner handles in apps/agent/src/agent/main.py
- [ ] T065 [P] [US4] Verify thin-adapter encoding, cleanup ordering, no leaked leases/tasks, direct stream, and output guardrails in apps/agent/tests/test_sse_integration.py, apps/agent/tests/test_stream_session_control.py, and apps/agent/tests/test_direct_stream.py
- [ ] T066 [US4] Run Feature 019 Gate 4 plus full agent, web direct-stream, and real T093 gates and record cleanup telemetry, rollback, and compatibility evidence in context/architecture.md and context/progress-checker.md

**Checkpoint**: User Story 4 is independently testable without HTTP or LangGraph in the transport layer.

---

## Phase 7: User Story 5 - Keep Transport and Credentials Out of Rendering (Priority: P5)

**Goal**: Serve Flight Search and Booking Management through typed authenticated server seams without placing JWTs, backend URLs, provider identifiers, or retry policy in Client Components.

**Independent Test**: Inspect component props and browser requests, verify only approved same-origin seams are used, and confirm visible search, booking, cancellation, disruption, and history outcomes remain compatible.

### Shared contracts and Flight Search

- [x] T067 [P] [US5] Add failing runtime-schema and serialization tests for Flight Search and Booking Management outcomes in packages/shared/src/types/flight-search.types.spec.ts and packages/shared/src/types/booking-management.types.spec.ts
- [x] T068 [P] [US5] Define provider-free Flight Search Zod schemas and inferred outcome types in packages/shared/src/types/flight-search.types.ts
- [x] T069 [P] [US5] Define prepared Booking Management views and typed command/read outcomes in packages/shared/src/types/booking-management.types.ts
- [x] T070 [US5] Export only the new vertical contracts through stable imports in packages/shared/src/types/index.ts
- [ ] T071 [P] [US5] Add failing authenticated transport, retry, timeout, validation, and error-mapping tests in apps/web/lib/server/flight-search.spec.ts
- [ ] T072 [US5] Implement server-only searchFlights and selectFlightOffer operations in apps/web/lib/server/flight-search.ts
- [ ] T073 [US5] Implement serializable Next.js 14 search and selection Server Actions in apps/web/app/search/actions.ts
- [ ] T074 [US5] Remove access-token props, local offer contracts, backend URLs, bearer fetches, and client retry logic from apps/web/app/search/page.tsx and apps/web/components/search/SearchFormClient.tsx
- [ ] T075 [P] [US5] Introduce private API_URL transition configuration and convert browser-interception fixtures to approved server/mock-scenario seams in apps/web/.env.example and apps/web/tests/checkout-foundation.spec.ts

### Booking Management

- [ ] T076 [P] [US5] Add failing list, detail, status, quote, cancellation, disruption, history, no-store, and typed error tests in apps/web/lib/server/booking-management.spec.ts
- [ ] T077 [US5] Implement authenticated server-only Booking Management operations and prepared view mapping in apps/web/lib/server/booking-management.ts
- [ ] T078 [US5] Convert initial booking list and detail reads to the server module in apps/web/app/bookings/page.tsx and apps/web/app/bookings/[bookingId]/page.tsx
- [ ] T079 [P] [US5] Add thin same-origin polling and itinerary-history Route Handlers in apps/web/app/api/booking-management/bookings/[bookingId]/status/route.ts and apps/web/app/api/booking-management/bookings/[bookingId]/itinerary-revisions/route.ts
- [ ] T080 [P] [US5] Add thin allowlisted commands in apps/web/app/api/booking-management/bookings/[bookingId]/cancellation/quote/route.ts, apps/web/app/api/booking-management/bookings/[bookingId]/cancellation/confirm/route.ts, and apps/web/app/api/booking-management/bookings/[bookingId]/disruptions/[action]/route.ts
- [ ] T081 [US5] Remove useSession, accessToken, public backend URL, direct NestJS fetches, raw any, and fallback transport logic from apps/web/components/bookings/BookingDetail.tsx
- [ ] T082 [US5] Remove token props and direct NestJS history fetches from apps/web/components/bookings/ItineraryRevisionHistory.tsx
- [ ] T083 [US5] Run Feature 019 Gate 5, the scoped credential/transport static check, Next typecheck/build, and checkout/bookings/disruptions Playwright; record observability, rollback, and Decision 6 documentation in context/code-standards.md, context/architecture.md, and context/progress-checker.md

**Checkpoint**: User Story 5 renders prepared views with no browser-held backend credentials or transport policy.

---

## Phase 8: User Story 6 - Give Each Agent Tool a Local Capability Boundary (Priority: P6)

**Goal**: Replace AgentGatewayService with capability-local authentication, audit, search, readiness, booking-read, preference, and Chat ownership while preserving every approved route and privacy contract.

**Independent Test**: Construct and invoke each capability with only local dependencies, verify unchanged route/status/body behavior, and prove no raw request data reaches audit storage.

- [x] T084 [P] [US6] Export existing API-key and claim guards through a narrow module in apps/api/src/agent-gateway/auth/agent-auth.module.ts
- [x] T085 [P] [US6] Add failing allowlisted tool audit and raw-parameter rejection tests in apps/api/src/agent-gateway/audit/agent-tool-audit.service.spec.ts
- [x] T086 [US6] Implement tool-name, outcome, duration, response-size, and sanitized trace-only audit storage in apps/api/src/agent-gateway/audit/agent-tool-audit.service.ts
- [ ] T087 [P] [US6] Add capability-local legacy/V2 search, attestation, mapping, and dependency-isolation tests in apps/api/src/agent-gateway/attested-flight-search/attested-flight-search.service.spec.ts
- [ ] T088 [US6] Extract attested search ownership while preserving routes and safe projections in apps/api/src/agent-gateway/attested-flight-search/attested-flight-search.controller.ts, apps/api/src/agent-gateway/attested-flight-search/attested-flight-search.service.ts, and apps/api/src/agent-gateway/attested-flight-search/attested-flight-search.module.ts
- [ ] T089 [P] [US6] Add readiness projection, observability, and dependency-isolation tests in apps/api/src/agent-gateway/booking-readiness/agent-booking-readiness.service.spec.ts
- [ ] T090 [US6] Extract booking readiness ownership in apps/api/src/agent-gateway/booking-readiness/agent-booking-readiness.controller.ts, apps/api/src/agent-gateway/booking-readiness/agent-booking-readiness.service.ts, and apps/api/src/agent-gateway/booking-readiness/agent-booking-readiness.module.ts
- [ ] T091 [P] [US6] Add summary/detail privacy, compatibility, and dependency-isolation tests in apps/api/src/agent-gateway/safe-booking-read/safe-booking-read.service.spec.ts
- [ ] T092 [US6] Extract two-tier safe booking read ownership while retaining the legacy broad endpoint only as a compatibility route in apps/api/src/agent-gateway/safe-booking-read/safe-booking-read.controller.ts, apps/api/src/agent-gateway/safe-booking-read/safe-booking-read.service.ts, and apps/api/src/agent-gateway/safe-booking-read/safe-booking-read.module.ts
- [ ] T093 [P] [US6] Add allowlisted preference projection and dependency-isolation tests in apps/api/src/agent-gateway/traveler-preferences/traveler-preferences.service.spec.ts
- [ ] T094 [US6] Extract traveler preference ownership in apps/api/src/agent-gateway/traveler-preferences/traveler-preferences.controller.ts, apps/api/src/agent-gateway/traveler-preferences/traveler-preferences.service.ts, and apps/api/src/agent-gateway/traveler-preferences/traveler-preferences.module.ts
- [ ] T095 [US6] Move existing agent chat persistence paths to Chat-owned controller/access boundaries with compatibility tests in apps/api/src/chat/agent-chat.controller.ts, apps/api/src/chat/agent-chat-access.service.ts, and apps/api/test/agent-chat-gateway.e2e-spec.ts
- [ ] T096 [US6] Recompose capability modules and remove migrated methods/dependencies from apps/api/src/agent-gateway/agent-gateway.controller.ts and apps/api/src/agent-gateway/agent-gateway.module.ts
- [ ] T097 [US6] Delete apps/api/src/agent-gateway/agent-gateway.service.ts after every controller and proven external provider has migrated
- [ ] T098 [US6] Run Feature 019 Gate 6, gateway/chat E2E, privacy corpus, no-broad-service static checks, full API gates, and Python tool integration; record observability, rollback, and separate legacy endpoint deprecation status in context/architecture.md and context/progress-checker.md

**Checkpoint**: User Story 6 has local capability boundaries with no catch-all gateway service.

---

## Phase 9: Polish and Cross-Cutting Completion

**Purpose**: Prove repository-wide compatibility, synchronize operational documentation, and remove migration scaffolding only after evidence permits it.

- [ ] T099 [P] Update ownership graphs, stable module boundaries, data flow, and compatibility state for all completed slices in context/architecture.md
- [ ] T100 [P] Update accepted server-seam, stable-import, and module naming rules introduced by Feature 019 in context/code-standards.md and context/library-docs.md only where usage rules changed
- [ ] T101 Complete migration preflight, observability, observation-window, rollback, and cleanup-eligibility procedures in docs/runbooks/refund-settlement-migration.md, docs/runbooks/booking-module-split.md, docs/runbooks/trusted-search-snapshot.md, docs/runbooks/chat-turn-runner.md, docs/runbooks/web-server-seams.md, and docs/runbooks/agent-gateway-capabilities.md
- [ ] T102 Run pnpm build, pnpm lint, pnpm test, full agent Ruff/pytest, and full API E2E exactly as documented in specs/019-improve-architecture/quickstart.md
- [ ] T103 Run the real T093 Playwright flow to exit code 0, remove eligible compatibility helpers, verify SC-001 through SC-009, and record final evidence in context/progress-checker.md

---

## Dependencies and Execution Order

### Phase dependencies

- **Setup (Phase 1)**: Complete.
- **Foundational characterization (Phase 2)**: Complete and remains a regression gate.
- **US1 (Phase 3)**: Implemented through T025; T026–T029 complete Slice 1D and the final refund gate.
- **US2 (Phase 4)**: Starts after US1's contract boundary is stable because Cancellation consumes refund orchestration.
- **US3 (Phase 5)**: Can start after Phase 2 and is technically independent of US2, but the approved rollout keeps slices sequential.
- **US4 (Phase 6)**: Depends on the US3 lifecycle interface because Chat Turn Runner loads and projects trusted snapshots.
- **US5 (Phase 7)**: Can start after Phase 2 and is technically independent of US3/US4, but follows the approved sequence.
- **US6 (Phase 8)**: Starts after earlier slices have stabilized booking projection and web/API ownership.
- **Polish (Phase 9)**: Depends on all selected story phases and their focused gates.

### User story completion order

1. **US1 (P1)**: Refund Settlement and contract migration.
2. **US2 (P2)**: Booking Lifecycle, Management, and Cancellation split.
3. **US3 (P3)**: Trusted Search Snapshot Lifecycle.
4. **US4 (P4)**: Typed Chat Turn Runner.
5. **US5 (P5)**: Flight Search and Booking Management server seams.
6. **US6 (P6)**: Agent Gateway capability-local modules.

### Parallel opportunities

- Tasks marked [P] within a phase touch independent test or module files and can be assigned concurrently.
- US3 and US5 can be developed in parallel after Phase 2 if separate teams preserve the approved per-slice gates.
- Capability test tasks T087, T089, T091, and T093 can run in parallel before their matching implementation tasks.
- Documentation tasks T099 and T100 can run in parallel after the relevant implementation facts stabilize.

---

## Parallel Execution Examples

### User Story 2

- T030: Booking Lifecycle and recovery tests.
- T036: Booking Management tests.
- T038: Cancellation tests.

### User Story 3

- T049: Search lifecycle cutover.
- T050: Selection signal cutover.
- T051: Checkout gate cutover.
- T052: Handoff node cutover.

### User Story 5

- T068 and T069: Independent shared vertical contracts.
- T071 and T076: Independent Flight Search and Booking Management server-seam tests.

### User Story 6

- T087, T089, T091, and T093: Independent capability-local contract tests.

---

## Implementation Strategy

### Current resume point

1. Keep T001–T025 checked; they are supported by code and verification evidence.
2. Resume at T026, Feature 019 Slice 1D.
3. Do not mark US1 complete until T029 records the post-contract Gate 1 result.
4. Continue one architecture slice at a time, preserving the compatibility and rollback boundary until each focused gate passes.

### Incremental delivery

1. Finish US1 contract cleanup and validate independently.
2. Deliver US2 and remove the cycle only after every caller cluster passes.
3. Deliver US3 before moving snapshot ownership into the chat runner.
4. Deliver US4 with typed events before thinning SSE.
5. Deliver US5 in independent Flight Search and Booking Management sub-slices.
6. Deliver US6 one capability at a time; delete the broad service last.
7. Complete Phase 9 and the real T093 gate before declaring Feature 019 complete.

---

## Notes

- Completed status was reconciled on 2026-08-22 against the working tree, branch history, focused test artifacts, context/progress-checker.md, and three Luna exploration audits.
- Legacy behavior or reusable helpers are not marked complete when the target Feature 019 module boundary is absent.
- Preserve public endpoint paths, event names and keys, deterministic transactional ownership, privacy projections, and no-new-runtime-dependency constraints.
- Keep Candidate 9 Duffel capability narrowing and the broader Traveler Profile/shared-contract redesign out of Feature 019.
- Commit after each task or tightly coupled task group, and update context documentation after each implemented slice.
