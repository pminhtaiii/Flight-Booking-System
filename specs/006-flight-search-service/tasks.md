# Tasks: Duffel Flight Search Service

**Input**: Design documents from `/specs/006-flight-search-service/`

**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and basic structure

- [X] T001 Install `@duffel/api` SDK in `apps/api/package.json`
- [X] T002 Create types and interfaces in `apps/api/src/duffel/duffel.types.ts`
- [X] T003 Create Duffel module definition in `apps/api/src/duffel/duffel.module.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core database models and base infrastructure that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T004 Add `FlightOffer`, `SearchHistory`, and `OfferRecovery` models to `apps/api/prisma/schema.prisma`
- [X] T005 Run database migration using `npx prisma migrate dev`
- [X] T006 [P] Implement base client initialization and configuration in `apps/api/src/duffel/duffel.service.ts`
- [X] T007 [P] Implement Redis-based response caching in `apps/api/src/duffel/duffel.service.ts`
- [X] T008 [P] Implement API budget tracker with priority thresholds in `apps/api/src/duffel/duffel.service.ts`
- [X] T009 [P] Implement daily scheduled cleanup cron job in `apps/api/src/duffel/duffel-cleanup.service.ts`

**Checkpoint**: Foundation ready - user story implementation can now begin in parallel

---

## Phase 3: User Story 1 - Search for Flights (Priority: P1) 🎯 MVP

**Goal**: Allow authenticated users to search for flights (one-way/round-trip) with caching and budget checks.

**Independent Test**: Perform a valid search from UI or API endpoint and receive a list of matching flight offers.

### Tests for User Story 1

- [x] T010 [P] [US1] Write backend search contract E2E test in `apps/api/test/flights-search.e2e-spec.ts`
- [x] T011 [P] [US1] Write frontend Playwright search integration test in `apps/web/tests/search.spec.ts`

### Implementation for User Story 1

- [x] T012 [P] [US1] Implement search query and response DTOs in `apps/api/src/flights/dto/search-flight.dto.ts`
- [x] T013 [P] [US1] Create controller with search endpoint in `apps/api/src/flights/flights.controller.ts`
- [x] T014 [US1] Implement search orchestrator and response transform in `apps/api/src/flights/flights.service.ts`
- [x] T015 [US1] Implement async write-behind persistence in `apps/api/src/flights/flights.service.ts`
- [x] T016 [US1] Register flights module in `apps/api/src/flights/flights.module.ts` and `apps/api/src/app.module.ts`
- [x] T017 [US1] Refactor AgentGateway to call `DuffelService` search in `apps/api/src/agent-gateway/agent-gateway.service.ts`
- [x] T018 Delete deprecated Amadeus provider directory `apps/api/src/agent-gateway/amadeus/`
- [x] T019 [US1] Wire search input and results list components in `apps/web/components/search/SearchPageClient.tsx`

**Checkpoint**: User Story 1 is fully functional and testable independently.

---

## Phase 4: User Story 2 - View Flight Details with Live Pricing (Priority: P2)

**Goal**: Allow users to click "View Details" to see layout details, layovers, and a live reconfirmed price. Handles expired offers.

**Independent Test**: Load details page for an offer ID; verify layovers and price match. Verify 410 Gone recovery flow redirects to form.

### Tests for User Story 2

- [x] T020 [P] [US2] Write backend detail and re-price E2E tests in `apps/api/test/flights-detail.e2e-spec.ts`

### Implementation for User Story 2

- [x] T021 [P] [US2] Implement flight detail response DTOs in `apps/api/src/flights/dto/detail-flight.dto.ts`
- [x] T022 [US2] Add detail retrieval endpoint in `apps/api/src/flights/flights.controller.ts`
- [x] T023 [US2] Implement re-price call and fallback recovery parameters in `apps/api/src/flights/flights.service.ts`
- [x] T024 [US2] Create flight detail view page in `apps/web/app/search/[flightId]/page.tsx`
- [x] T025 [US2] Implement details card component in `apps/web/components/search/FlightDetailPageClient.tsx`
- [x] T026 [US2] Add expired offer recovery redirect in `apps/web/components/search/SearchPageClient.tsx`

**Checkpoint**: User Stories 1 and 2 are fully functional and integrated.

---

## Phase 5: User Story 3 - Search History & Analytics Capture (Priority: P3)

**Goal**: Store lightweight search metadata indefinitely for dashboard charts.

**Independent Test**: Check database `SearchHistory` table after searches to confirm rows exist. Verify cron deletes raw offers but keeps history.

### Tests for User Story 3

- [ ] T027 [P] [US3] Write history persistence and cron cleanup E2E tests in `apps/api/test/flights-analytics.e2e-spec.ts`

### Implementation for User Story 3

- [ ] T028 [US3] Ensure search metadata writing in write-behind logic in `apps/api/src/flights/flights.service.ts`
- [ ] T029 [US3] Integrate search history repository in cron task in `apps/api/src/duffel/duffel-cleanup.service.ts`

**Checkpoint**: All user stories are independently functional and history analytics are captured.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Security, logging, documentation, and final E2E verification

- [ ] T030 [P] Ensure audit logs use opaque ID and omit PII in `apps/api/src/flights/flights.service.ts`
- [ ] T031 Update user guide documentation in `PROJECT.md`
- [ ] T032 Verify all automated unit and E2E tests pass across workspaces
- [ ] T033 Run verification scenarios in `specs/006-flight-search-service/quickstart.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3+)**: All depend on Foundational phase completion
  - User stories can then proceed in parallel (if staffed)
  - Or sequentially in priority order (P1 → P2 → P3)
- **Polish (Final Phase)**: Depends on all desired user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (Phase 2) - No dependencies on other stories
- **User Story 2 (P2)**: Can start after Foundational (Phase 2) - May integrate with US1 but should be independently testable
- **User Story 3 (P3)**: Can start after Foundational (Phase 2) - May integrate with US1/US2 but should be independently testable

### Within Each User Story

- Tests (if included) MUST be written and FAIL before implementation
- Models before services
- Services before endpoints
- Core implementation before integration
- Story complete before moving to next priority

### Parallel Opportunities

- All Setup tasks marked [P] can run in parallel
- All Foundational tasks marked [P] can run in parallel (within Phase 2)
- Once Foundational phase completes, all user stories can start in parallel (if team capacity allows)
- All tests for a user story marked [P] can run in parallel
- Models within a story marked [P] can run in parallel
- Different user stories can be worked on in parallel by different team members

---

## Parallel Example: User Story 1

```bash
# Launch all tests for User Story 1 together:
Task: "Write backend search contract E2E test in apps/api/test/flights-search.e2e-spec.ts"
Task: "Write frontend Playwright search integration test in apps/web/tests/search.spec.ts"

# Launch all models for User Story 1 together:
Task: "Implement search query and response DTOs in apps/api/src/flights/dto/search-flight.dto.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL - blocks all stories)
3. Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: Test User Story 1 independently
5. Deploy/demo if ready

### Incremental Delivery

1. Complete Setup + Foundational → Foundation ready
2. Add User Story 1 → Test independently → Deploy/Demo (MVP!)
3. Add User Story 2 → Test independently → Deploy/Demo
4. Add User Story 3 → Test independently → Deploy/Demo
5. Each story adds value without breaking previous stories
