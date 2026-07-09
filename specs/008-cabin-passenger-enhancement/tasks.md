# Tasks: Cabin Class & Passenger Type Enhancement

**Input**: Design documents from `/specs/008-cabin-passenger-enhancement/`

**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: Test tasks are included under E2E Testing & Verification phase.

**Organization**: Tasks are grouped by phase and user story to enable independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and basic structure

- [x] T001 Verify/generate ignore files based on project setup (e.g., `.gitignore`, `.dockerignore`, `.eslintignore`, `.prettierignore`)
- [x] T002 Update active feature configuration in `.specify/feature.json`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core database migrations that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T003 Modify database schema to replace `passengers` with `adults`, `children`, `infants`, and `cabinClass` in `apps/api/prisma/schema.prisma`
- [x] T004 Run migrations via `npx prisma migrate dev --schema=apps/api/prisma/schema.prisma` to apply schema changes to PostgreSQL
- [x] T005 Verify Prisma client types are regenerated correctly using `npx prisma generate --schema=apps/api/prisma/schema.prisma`

**Checkpoint**: Foundation ready - user story implementation can now begin

---

## Phase 3: User Story 1 - Select Cabin Class for Flight Search (Priority: P1) 🎯 MVP

**Goal**: Select cabin class before searching, request cabin from Duffel, and compute cabin match classification (`full`/`mixed`/`downgraded`).

**Independent Test**: Search SGN → NRT with "Business" and verify results are business class or display mixed-cabin/downgraded badges.

### Implementation for User Story 1

- [x] T006 [P] [US1] Create isolated `mapPassengersToDuffel` function in `apps/api/src/duffel/duffel.service.ts`
- [x] T007 [US1] Modify `searchFlights` signature to accept `cabinClass` and flat passenger breakdown in `apps/api/src/duffel/duffel.service.ts`
- [x] T008 [US1] Update `duffel.offerRequests.create` call to pass `cabin_class` preference and mapped passengers in `apps/api/src/duffel/duffel.service.ts`
- [x] T009 [US1] Update cache key SHA-256 computation to include cabin class and passenger breakdown in `apps/api/src/duffel/duffel.service.ts`
- [x] T010 [P] [US1] Update mock data generation to include cabin class in `apps/api/src/duffel/duffel.service.ts` or `apps/api/src/duffel/duffel.types.ts`
- [x] T011 [P] [US1] Update `FlightSearchRequestDto` to replace `passengers` with flat passenger fields and `cabinClass` in `apps/api/src/flights/dto/search-flight.dto.ts`
- [x] T012 [P] [US1] Add custom cross-field validators for passenger limits and infants in `apps/api/src/flights/dto/search-flight.dto.ts`
- [x] T013 [P] [US1] Add per-segment `cabinClass` and DTO fields for mixed/downgraded cabins in `apps/api/src/flights/dto/search-flight.dto.ts` and `apps/api/src/flights/dto/detail-flight.dto.ts`
- [x] T014 [US1] Implement three-tier cabin match classification and mismatch details mapper in `apps/api/src/flights/flights.service.ts`
- [x] T015 [US1] Update `search` endpoint in `apps/api/src/flights/flights.controller.ts` to map and pass new request fields
- [x] T016 [US1] Update async write-behind persistence logic to save new fields to database in `apps/api/src/flights/flights.service.ts`
- [x] T017 [US1] Update `getFlightDetail` and 410 recovery to include cabin class and passenger breakdown in `apps/api/src/flights/flights.service.ts` and `apps/api/src/flights/flights.controller.ts`
- [x] T018 [P] [US1] Add cabin class dropdown to Next.js flight search form in `apps/web/components/search/SearchPageClient.tsx`
- [x] T019 [US1] Add client-side validation and search API integration in `apps/web/components/search/SearchPageClient.tsx`
- [x] T020 [US1] Display `cabinClassMatch` badge and expandable per-segment details on search result cards in `apps/web/components/search/SearchPageClient.tsx`
- [x] T021 [P] [US1] Display cabin match details on the flight details page in `apps/web/components/search/FlightDetailPageClient.tsx`
- [x] T022 [US1] Update 410 recovery logic to pre-fill search form with recovered cabin/passenger data in `apps/web/components/search/SearchPageClient.tsx`

**Checkpoint**: User Story 1 functional and testable.

---

## Phase 4: User Story 2 - Specify Passenger Types (Priority: P1)

**Goal**: Allow specifying adults, children, and infants with correct pricing from Duffel.

**Independent Test**: Search with 1 adult + 1 child + 1 infant, verify different price from 3 adults.

### Implementation for User Story 2

- [ ] T023 [US2] Add passenger type picker (Adults/Children/Infants) in `apps/web/components/search/SearchPageClient.tsx`
- [ ] T024 [US2] Implement passenger breakdown client-side validation rules in `apps/web/components/search/SearchPageClient.tsx`

---

## Phase 5: User Story 3 - Agent Gateway Honest Degradation (Priority: P2)

**Goal**: Respond honestly when chatbot user requests premium cabins or passenger breakdown, and log triggers.

**Independent Test**: Chat "find business class flight" and verify limitation response and log output.

### Implementation for User Story 3

- [ ] T025 [P] [US3] Create keyword constants for cabin and passenger types in `apps/api/src/agent-gateway/agent-gateway.constants.ts`
- [ ] T026 [US3] Implement keyword detection, honest limitation response, and logging in `apps/api/src/agent-gateway/agent-gateway.service.ts`
- [ ] T027 [US3] Update `searchFlights` in `apps/api/src/agent-gateway/agent-gateway.service.ts` to map request with defaults to the new Flights DTO shape

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Cleanup, documentation, and manual verification

- [ ] T028 [P] Update project documentation files in `context/`
- [ ] T029 Run quickstart.md validation scenario verification

---

## Phase 7: E2E Testing & Verification

**Purpose**: Automated verification of backend, agent gateway, and frontend E2E functionality

- [ ] T030 [P] Implement backend E2E tests for cabin search, mixed/downgraded classification, passenger validation, cache separation, and 410 recovery in `apps/api/test/flights-search.e2e-spec.ts` and `apps/api/test/flights-detail.e2e-spec.ts`
- [ ] T031 [P] Implement agent gateway keyword detection E2E tests in `apps/api/test/agent-gateway.e2e-spec.ts`
- [ ] T032 [P] Implement Playwright UI E2E tests for cabin selector, passenger picker, and mismatch badges in `apps/web/tests/search.spec.ts`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: Depends on Setup. Blocks all User Stories.
- **User Stories (Phases 3-5)**: All depend on Foundational (Phase 2).
- **Polish (Phase 6)** & **Testing (Phase 7)**: Depend on User Stories completion.
