# Tasks: Authenticated Booking Dashboard

**Input**: Design documents from `/specs/021-dashboard-building/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/dashboard-summary.openapi.yaml](contracts/dashboard-summary.openapi.yaml), [quickstart.md](quickstart.md)

**Tests**: Required by FR-019. Within each story, add failing tests before the corresponding implementation and retain existing regressions.

**Organization**: Tasks are grouped by user story. US1 is the live dashboard MVP; US2 adds productive actions; US3 completes entry routing and recovery.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel because it targets a separate file and has no incomplete dependency.
- **[Story]**: Maps the task to US1, US2, or US3 from `spec.md`.

## Phase 1: Setup and Decision Guardrails

**Purpose**: Establish implementation references and prevent prototype mock semantics from leaking into production.

- [x] T001 Record the feature execution baseline and affected-file checklist in `specs/021-dashboard-building/implementation-notes.md`
- [x] T002 [P] Add a dashboard contract conformance checklist derived from the OpenAPI artifact to `specs/021-dashboard-building/checklists/contract.md`
- [x] T003 [P] Add a visual translation checklist covering tokenization, removed prototype controls, supported production routes, responsive states, and accessibility to `specs/021-dashboard-building/checklists/visual.md`
- [x] T004 Confirm the installed Next.js 14.2.3 route/session APIs against available local documentation or installed types and record any repository-specific constraints in `specs/021-dashboard-building/implementation-notes.md`

---

## Phase 2: Foundational Shared Contract

**Purpose**: Create the one response-shape source of truth that blocks API and web implementation.

**Critical**: Finish this phase before any story implementation.

- [x] T005 Write failing Zod contract tests for valid summaries, non-negative counts, canonical statuses, ISO timestamps, exact object keys, nullable display fields, and a maximum of five recent records in `packages/shared/src/types/dashboard.types.spec.ts`
- [x] T006 Implement `DashboardStatsSchema`, `DashboardRecentBookingSchema`, `DashboardSummarySchema`, inferred types, and the `DashboardOutcome` failure union in `packages/shared/src/types/dashboard.types.ts`
- [x] T007 Export the dashboard contract through the shared type barrel in `packages/shared/src/types/index.ts`
- [x] T008 Add the compiled dashboard schema spec to the shared package test command in `packages/shared/package.json`, run it, and record the command/result in `specs/021-dashboard-building/implementation-notes.md`

**Checkpoint**: API and web can import the same validated contract.

---

## Phase 3: User Story 1 - View a Trustworthy Booking Overview (Priority: P1) MVP

**Goal**: An authenticated traveler sees accurate owner-scoped booking metrics and five safe recent bookings on a production dashboard.

**Independent Test**: Seed mixed-status bookings for two users and verify `/dashboard` shows only the signed-in user's four metrics and five newest bookings, including the zero-data case.

### Tests for User Story 1

- [x] T009 [P] [US1] Write failing `DashboardService` tests for owner/time filters, canonical `COMPLETED` plus stale-past-`CONFIRMED` counting, all five cancellation-family statuses, one captured clock boundary, null departures, concurrent five-query execution, `take: 5`, descending ordering, and malformed snapshot projection in `apps/api/src/dashboard/dashboard.service.spec.ts`
- [x] T010 [P] [US1] Write failing controller tests for `JwtAuthGuard`, authenticated user forwarding, and exact summary return behavior in `apps/api/src/dashboard/dashboard.controller.spec.ts`
- [x] T011 [P] [US1] Write failing API integration tests for 401 behavior, user A/user B isolation, metric definitions, recent ordering/limit, and prohibited-field absence in `apps/api/test/dashboard.e2e-spec.ts`
- [x] T012 [P] [US1] Write failing server-loader tests for missing sessions, bearer forwarding, `cache: 'no-store'`, timeout, status mapping, malformed JSON, schema rejection, and successful parsing in `apps/web/lib/server/dashboard.spec.ts`
- [x] T013 [P] [US1] Add an in-process local port-3101 dashboard-summary fixture keyed by bearer-token scenario and failing Playwright scenarios for populated metrics, five recent records, recent-detail links, empty state, no prototype controls, and no fake insight/shield content in `apps/web/tests/dashboard.spec.ts`

### API and Contract Implementation for User Story 1

- [ ] T014 [US1] Implement a pure allowlisted historical/current flight-snapshot display mapper and direct Prisma summary queries in `apps/api/src/dashboard/dashboard.service.ts`
- [ ] T015 [US1] Implement authenticated `GET /dashboard/summary` controller behavior with request-derived user identity and private no-store response semantics in `apps/api/src/dashboard/dashboard.controller.ts`
- [ ] T016 [US1] Register only `PrismaModule`, `DashboardService`, and `DashboardController` in `apps/api/src/dashboard/dashboard.module.ts`
- [ ] T017 [US1] Add `DashboardModule` to the application dependency graph in `apps/api/src/app.module.ts`
- [ ] T018 [US1] Update module-graph expectations to cover `DashboardModule` without adding booking-management, profile, payment, or cache dependencies in `apps/api/src/app.module.spec.ts`
- [ ] T019 [US1] Make service/controller/API tests pass and capture the verified results in `specs/021-dashboard-building/implementation-notes.md`

### Web Data Boundary and UI Implementation for User Story 1

- [ ] T020 [US1] Implement the server-only session-aware, bounded, no-store summary loader and typed failure mapping in `apps/web/lib/server/dashboard.ts`
- [ ] T021 [P] [US1] Add semantic light/dark/fallback dashboard surface, text, focus, action, and status tokens without hardcoded production component colors in `apps/web/app/globals.css`
- [ ] T022 [P] [US1] Implement the four-card booking-only metric view with semantic icons and labels in `apps/web/components/dashboard/DashboardStats.tsx`
- [ ] T023 [P] [US1] Implement the owner-safe recent timeline, empty state, relative/absolute date semantics, and booking detail/list links in `apps/web/components/dashboard/DashboardRecentBookings.tsx`
- [ ] T024 [US1] Compose the approved Wayfinder hierarchy, dashboard-scoped desktop sidebar/sticky top bar, and compact mobile navigation through a display-only typed interface in `apps/web/components/dashboard/DashboardShell.tsx`
- [ ] T025 [US1] Translate the approved responsive glassmorphic layout into token-based styles with no inline color styles, prototype banner, or variant switcher in `apps/web/app/dashboard/dashboard.module.css`
- [ ] T026 [US1] Implement the authenticated dashboard Server Component, expired-session redirect, and non-fabricated upstream error branch in `apps/web/app/dashboard/page.tsx`
- [ ] T027 [US1] Add a server-rendered responsive skeleton matching final layout geometry in `apps/web/app/dashboard/loading.tsx`
- [ ] T028 [US1] Add the required `'use client'` Next.js error-boundary contract with typed `error` and `reset` props plus a safe retry UI that exposes no transport details in `apps/web/app/dashboard/error.tsx`
- [ ] T029 [US1] Make loader and US1 Playwright tests pass and record the MVP evidence in `specs/021-dashboard-building/implementation-notes.md`

**Checkpoint**: US1 independently resolves the dashboard 404 and provides a secure, live, visually approved booking overview.

---

## Phase 4: User Story 2 - Start the Next Travel Task (Priority: P2)

**Goal**: The dashboard becomes a productive hub through quick search, booking links, and supported production actions.

**Independent Test**: Submit valid and invalid quick searches and activate every dashboard action; all enabled paths reach production routes with preserved values and keyboard operation.

### Tests for User Story 2

- [ ] T030 [P] [US2] Extend the in-process dashboard fixture and Playwright coverage for quick-search validation, preserved search values, keyboard submission, exact production action destinations, Profile action presence when booking readiness is enabled, Profile action absence when disabled, and absence of `/prototype/*` links in `apps/web/tests/dashboard.spec.ts`
- [ ] T031 [P] [US2] Add unit tests for search normalization/URL creation in `apps/web/components/dashboard/dashboard-search.spec.ts` and for Profile action omission/inclusion when booking readiness is false/true in `apps/web/components/dashboard/dashboard-actions.spec.ts`

### Implementation for User Story 2

- [ ] T032 [US2] Implement pure quick-search normalization, validation, and production search URL construction in `apps/web/components/dashboard/dashboard-search.ts`
- [ ] T033 [US2] Implement accessible quick-search controls in `apps/web/components/dashboard/DashboardQuickSearch.tsx`, add typed initial-value props in `apps/web/components/search/SearchFormClient.tsx`, and consume sanitized dashboard query parameters in `apps/web/app/search/page.tsx`
- [ ] T034 [P] [US2] Implement a pure flag-aware action builder that always returns `/search`, `/bookings?tab=upcoming`, and `/bookings?tab=past` and conditionally returns `/profile` in `apps/web/components/dashboard/dashboard-actions.ts`, then render those actions in `apps/web/components/dashboard/DashboardQuickActions.tsx`
- [ ] T035 [US2] Evaluate `isBookingReadinessEnabled()` in `apps/web/app/dashboard/page.tsx`, pass the resulting profile-action availability through `apps/web/components/dashboard/DashboardShell.tsx`, and integrate quick search plus the derived action set
- [ ] T036 [US2] Add responsive and focus styles for quick-search/action controls using semantic tokens in `apps/web/app/dashboard/dashboard.module.css`
- [ ] T037 [US2] Make US2 unit and Playwright tests pass and record the always-available destinations plus the flag-conditioned Profile inclusion/omission in `specs/021-dashboard-building/implementation-notes.md`

**Checkpoint**: US2 independently proves every presented action works and no mock/prototype destination remains.

---

## Phase 5: User Story 3 - Enter and Recover Safely (Priority: P3)

**Goal**: Authenticated root entry redirects to the dashboard, anonymous marketing remains intact, and auth/upstream failures recover safely.

**Independent Test**: Exercise root and dashboard routes across authenticated, anonymous, expired-token, unavailable-API, invalid-response, narrow-screen, keyboard, and reduced-motion scenarios.

### Tests for User Story 3

- [ ] T038 [P] [US3] Extend the bearer-scenario dashboard fixture and Playwright coverage for authenticated root redirect, anonymous landing preservation, direct dashboard login redirect, expired-session messaging, malformed/unavailable upstream recovery, 360/768/desktop overflow, keyboard focus, and reduced-motion behavior in `apps/web/tests/dashboard.spec.ts`
- [ ] T039 [P] [US3] Add page-level unit coverage for root session branching and dashboard outcome-to-render/redirect behavior in `apps/web/tests/dashboard-routing.unit.ts`

### Implementation for User Story 3

- [ ] T040 [US3] Convert the root page to a server-side session branch that redirects authenticated users and preserves anonymous `LandingPage` rendering in `apps/web/app/page.tsx`
- [ ] T041 [US3] Align dashboard unauthenticated and expired-session routing with existing secure login-return behavior in `apps/web/app/dashboard/page.tsx`
- [ ] T042 [US3] Finalize compact navigation, no-horizontal-overflow, contrast, focus-visible, reduced-motion, and backdrop-filter fallback styles in `apps/web/app/dashboard/dashboard.module.css`
- [ ] T043 [US3] Make US3 routing and browser tests pass and record viewport/accessibility evidence in `specs/021-dashboard-building/implementation-notes.md`

**Checkpoint**: All three stories are independently functional and the dashboard is the safe authenticated entry hub.

---

## Phase 6: Polish, Verification, and Documentation Sync

**Purpose**: Enforce cross-cutting privacy/design constraints and leave code, tests, and repository context synchronized.

- [ ] T044 [P] Audit production dashboard source for hardcoded hex/rgba values, raw Tailwind color classes, inline color styles, prototype controls/routes, client tokens, backend URLs, raw snapshots, provider IDs, payment data, and passenger PII; record results in `specs/021-dashboard-building/checklists/visual.md`
- [ ] T045 [P] Add the dashboard module, endpoint, web server boundary, root redirect, and no-cache rationale to `context/architecture.md`
- [ ] T046 Update the dashboard-scoped sidebar decision and removed profile-banner/unsupported-insight assumptions in `context/project-overview.md`, then record feature status, exclusions, and verified results in `context/progress-checker.md`
- [ ] T047 Run every automated command in `specs/021-dashboard-building/quickstart.md` and record exact exit codes in `specs/021-dashboard-building/implementation-notes.md`
- [ ] T048 Perform the manual populated, empty, expired, unavailable, responsive, keyboard, dark-theme, and reduced-motion walkthrough from `specs/021-dashboard-building/quickstart.md`
- [ ] T049 Reconcile completed tasks, deferred items, and remaining evidence links in `specs/021-dashboard-building/tasks.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1** starts immediately.
- **Phase 2** depends on the contract/open questions captured in Phase 1 and blocks all stories.
- **US1 (Phase 3)** depends on Phase 2 and is the MVP.
- **US2 (Phase 4)** depends on the US1 shell/page but not on US3 routing work.
- **US3 (Phase 5)** depends on the US1 loader/page outcomes; its root-route work can run alongside US2 after US1.
- **Phase 6** depends on every story selected for release.

### User Story Dependency Graph

```text
Setup -> Shared Contract -> US1 Live Overview (MVP)
                              |-> US2 Hub Actions
                              |-> US3 Entry & Recovery
US2 + US3 ---------------------> Polish & Verification
```

### Within Each User Story

- Write and observe failing tests before production implementation.
- Define the shared schema before API or loader code.
- Implement service before controller/module registration.
- Implement server loader before page composition.
- Build atomic visual components before shell integration.
- Finish story-specific tests before declaring its checkpoint complete.

## Parallel Opportunities

- T002 and T003 can run in parallel after T001.
- T009-T013 can be authored in parallel after the shared contract is available.
- T021-T023 target separate files and can run in parallel after T020 defines data shape.
- T030 and T031 can be authored in parallel; T034 can run alongside T032-T033 after destinations are confirmed.
- T038 and T039 can run in parallel; US3 root work can run alongside completed US2 work.
- T044 and T045 target separate audit/architecture files and can run in parallel before final gates; T046 follows because it synchronizes two project-context files.

## Parallel Example: User Story 1

```text
Task T009: Service query/mapping tests in apps/api/src/dashboard/dashboard.service.spec.ts
Task T010: Controller auth tests in apps/api/src/dashboard/dashboard.controller.spec.ts
Task T011: API integration tests in apps/api/test/dashboard.e2e-spec.ts
Task T012: Web loader tests in apps/web/lib/server/dashboard.spec.ts
Task T013: Browser acceptance tests in apps/web/tests/dashboard.spec.ts
```

## Parallel Example: User Story 2

```text
Task T030: Browser action/search scenarios in apps/web/tests/dashboard.spec.ts
Task T031: Pure search and feature-flagged action derivation tests in apps/web/components/dashboard/dashboard-search.spec.ts and apps/web/components/dashboard/dashboard-actions.spec.ts
```

## Parallel Example: User Story 3

```text
Task T038: Browser auth/responsive/recovery scenarios in apps/web/tests/dashboard.spec.ts
Task T039: Page routing unit coverage in apps/web/tests/dashboard-routing.unit.ts
```

## Implementation Strategy

### MVP First

1. Complete T001-T008.
2. Complete T009-T029 in test-first order.
3. Stop and validate US1: authenticated `/dashboard`, four live metrics, five safe recent bookings, empty/error states.
4. Demo or ship US1 if the team wants the smallest deployable increment.

### Incremental Delivery

1. **US1**: Live booking overview removes the 404 and supplies the core value.
2. **US2**: Quick search and actions turn the overview into an operating hub.
3. **US3**: Root routing and recovery complete the entry experience.
4. **Polish**: Privacy/design audit, context sync, full quickstart and manual acceptance.

## Tracker Summary

- **Total tasks**: 49
- **Setup tasks**: 4
- **Foundational tasks**: 4
- **US1 tasks**: 21
- **US2 tasks**: 8
- **US3 tasks**: 6
- **Polish tasks**: 6
- **Suggested MVP**: T001-T029 (Setup + shared contract + US1)
- **Parallel task markers**: 17

## Notes

- Every checkbox follows the required `- [ ] T### [P?] [US?] Description with file path` format.
- Story labels appear only inside user-story phases.
- Do not create a migration, dashboard Redis cache, profile read, currency aggregate, or AI insight while executing these tasks.
- If a listed quick-action destination does not exist as a production route, omit or visibly disable it and record that decision; never point production UI at `/prototype/*`.
- Update `tasks.md` checkboxes only after the corresponding implementation and verification evidence exists.
