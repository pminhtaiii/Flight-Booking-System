# Tasks: Backend Client Unification

**Input**: [spec.md](./spec.md), [plan.md](./plan.md), [research.md](./research.md), [data-model.md](./data-model.md), [client contract](./contracts/backend-client.md), [quickstart.md](./quickstart.md).
**Tests**: Required by FR-012; characterize each domain before migration.
**Organization**: One independently testable migration per user story; mutations never gain automatic replay.

## Phase 1: Setup and baseline

- [x] T001 Characterize current dashboard 401/403, timeout, malformed JSON/schema, and success outcomes in `apps/web/lib/server/dashboard.spec.ts`.
- [x] T002 [P] Characterize flight search POST, offer GET, auth, status, and view mapping in `apps/web/lib/server/flight-search.spec.ts`.
- [x] T003 [P] Characterize all eight booking-management operations, 400/422 message forwarding, mutation send count, and status mapping in `apps/web/lib/server/booking-management.spec.ts`.
- [x] T004 [P] Characterize booking response status/body/header mapping in `apps/web/app/api/booking-management/bookings/[bookingId]/cancellation/route.spec.ts` and `apps/web/app/api/booking-management/bookings/[bookingId]/cancellation/quote/route.spec.ts`.

## Phase 2: Foundational client contract

- [x] T005 Write failing factory, default/injected token provider, URL precedence, missing-token, no-store, 10-second attempt timeout, JSON schema/none-mode success, malformed successful JSON versus malformed non-2xx status/body, and safe cause-code tests in `apps/web/lib/server/backend-client.spec.ts`.
- [x] T006 Extend `apps/web/lib/server/backend-client.spec.ts` with the exact GET retry matrix, three-attempt and 31-second total caps, 100 ms exponential base, delta/HTTP-date Retry-After including far-future header, 500 and other status no-retry, and all mutation methods single-attempt.
- [x] T007 Implement `createBackendClient`, default `backendClient`, inline TransportResult/RequestOpts, parsing/validation, safe diagnostics, and bounded retry in `apps/web/lib/server/backend-client.ts` until T005–T006 pass.

## Phase 3: User Story 1 - Resilient dashboard reads (P1)

**Goal**: Same dashboard outcomes with bounded transient GET recovery.
**Independent test**: Fake backend recovers on second GET; invalid JSON/schema still maps to non-retryable INVALID_RESPONSE.

- [x] T008 [US1] Add dashboard tests for 502/503/504 recovery, 429 Retry-After, 500 no-retry, missing token, and invalid JSON/schema distinction in `apps/web/lib/server/dashboard.spec.ts`.
- [x] T009 [US1] Migrate `getDashboardSummary` in `apps/web/lib/server/dashboard.ts` to `backendClient.request` with DashboardSummarySchema and preserve existing outcome reason/message/retryable mapping.
- [x] T010 [US1] Run `apps/web/lib/server/backend-client.spec.ts` and `apps/web/lib/server/dashboard.spec.ts` using `specs/028-backend-client-unification/quickstart.md`; record parity in `specs/028-backend-client-unification/verification.md`.

## Phase 4: User Story 2 - Preserve flight outcomes (P2)

**Goal**: Search and offer selection share transport with current domain outcomes.
**Independent test**: Search POST sends once; offer GET follows narrow retry policy; response projection and outcomes match fixtures.

- [ ] T011 [US2] Add flight tests for transport result mapping, malformed raw payload, GET transient recovery, and search POST single-send in `apps/web/lib/server/flight-search.spec.ts`.
- [ ] T012 [US2] Migrate `searchFlights` and `selectFlightOffer` in `apps/web/lib/server/flight-search.ts` to the client using current upstream schemas; retain query/offer validation, mapping, and final view schema checks.
- [ ] T013 [US2] Run `apps/web/lib/server/flight-search.spec.ts` and `apps/web/lib/server/backend-client.spec.ts`; record outcome parity in `specs/028-backend-client-unification/verification.md`.

## Phase 5: User Story 3 - Preserve booking outcomes (P3)

**Goal**: All eight booking operations share transport without changing domain results or replaying mutations.
**Independent test**: Existing booking tests cover list/detail/status/quote/cancel/acknowledge/accept/revisions, including error-body forwarding and single-send mutations.

- [ ] T014 [US3] Add tests for six JSON-consuming operation schemas, malformed 400/422 error-body fallback, invalid successful JSON, empty-body acknowledge/accept success, GET retry policy, and mutation send count in `apps/web/lib/server/booking-management.spec.ts`.
- [ ] T015 [US3] Migrate `listBookings`, `getBookingDetail`, `getCancellationStatus`, and `getCancellationQuote` in `apps/web/lib/server/booking-management.ts` to the client with raw list/detail/cancellation-status/cancellation-quote schemas preserving current tolerated fields/defaults.
- [ ] T016 [US3] Migrate `cancelBooking` and `getItineraryRevisions` in `apps/web/lib/server/booking-management.ts` using raw cancellation-result/revisions schemas, and migrate `acknowledgeDisruption` and `acceptDisruption` using explicit none mode; retain domain mapping and view validation.
- [ ] T017 [US3] Run `apps/web/lib/server/booking-management.spec.ts` and `apps/web/lib/server/backend-client.spec.ts`; record eight-operation parity in `specs/028-backend-client-unification/verification.md`.

## Phase 6: User Story 4 - Share booking response mapping (P4)

**Goal**: One booking-specific route adapter used by six route handlers.
**Independent test**: Representative success/error outcomes return identical status, body, and headers through all six handlers.

- [ ] T018 [US4] Add table-driven mapping tests in `apps/web/lib/server/outcome-response.spec.ts` and six-handler status/body/header parity coverage in `apps/web/app/api/booking-management/route-parity.spec.ts`, reusing existing cancellation route fixtures.
- [ ] T019 [US4] Extract the unchanged BookingManagementOutcome-to-NextResponse mapping into `apps/web/lib/server/outcome-response.ts`.
- [ ] T020 [US4] Replace duplicate mapper definitions/imports in `apps/web/app/api/booking-management/bookings/[bookingId]/route.ts`, `cancellation/route.ts`, `cancellation/quote/route.ts`, and `revisions/route.ts`.
- [ ] T021 [US4] Replace duplicate mapper definitions/imports in `apps/web/app/api/booking-management/bookings/[bookingId]/disruptions/acknowledge/route.ts` and `disruptions/accept/route.ts`.
- [ ] T022 [US4] Run `apps/web/lib/server/outcome-response.spec.ts`, `apps/web/app/api/booking-management/route-parity.spec.ts`, and both existing cancellation route specs; record six-handler parity in `specs/028-backend-client-unification/verification.md`.

## Phase 7: Polish and cross-cutting verification

- [ ] T023 Remove orphaned URL/token/retry/timeout/parsing helpers from `apps/web/lib/server/flight-search.ts`, `apps/web/lib/server/booking-management.ts`, and `apps/web/lib/server/dashboard.ts`; verify only `apps/web/lib/server/backend-client.ts` owns them.
- [ ] T024 Run focused tests, web lint, typecheck, and build from `specs/028-backend-client-unification/quickstart.md`; record exit codes and no public/Prisma/dependency diff in `specs/028-backend-client-unification/verification.md`.
- [ ] T025 Update `context/architecture.md` and `context/progress-checker.md` with implemented boundaries and verified task status; do not mark planned work complete before the gate passes.

## Dependencies

T001–T004 baseline → T005–T007 client → US1 (T008–T010) → US2 (T011–T013) → US3 (T014–T017) → US4 (T018–T022) → polish. T002–T004 may run in parallel after T001, but migrations of shared transport consumers should be integrated in this order for clear review and rollback.

## Parallel execution examples

- After T001, T002, T003, and T004 edit different test files and can run in parallel.
- After T017, T018 adapter tests and T023 transport-helper census can be prepared in separate files, but remove helpers only after all consumer tests pass.

## Implementation strategy

MVP is the client plus dashboard (US1): it proves the interface and delivers transient read recovery. Flight and booking migrations follow as independent working slices; route deduplication finishes the refactor. Run each focused gate before starting the next migration.
