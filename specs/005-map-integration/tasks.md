# Tasks: Map Integration

**Input**: Design documents from `/specs/005-map-integration/`

**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: Tests are optional but we write Jest/Playwright E2E tests as requested in the plan.

**Organization**: Tasks are grouped by implementation phase and user story to enable independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and basic structure

- [x] T001 [P] Add `Airport` shared type to `packages/shared/src/types/airport.ts`
- [x] T002 Update exports in `packages/shared/src/index.ts` to export the new airport types

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core database infrastructure that MUST be complete before ANY user story can be implemented

- [x] T003 Add `Airport` model and `AirportType` enum to Prisma schema in `apps/api/prisma/schema.prisma`
- [x] T004 Create Prisma migration for the airports table using `npx prisma migrate dev --name add_airports --schema=apps/api/prisma/schema.prisma`
- [x] T005 Write seed script to parse OurAirports CSV → filter by IATA + type → batch insert in `apps/api/prisma/seed/airports.ts` (using CSV at `specs/005-map-integration/airports.csv`)
- [x] T006 Register the airport seed script in Prisma seed or hook it up to be runnable

**Checkpoint**: Foundation ready - database schema and seed data are populated.

---

## Phase 3: User Story 1 - Airport Map & REST API (Priority: P1) 🎯 MVP

**Goal**: Display interactive map showing origin/destination and route arc. Requires backend REST endpoints.

**Independent Test**: Perform flight search (HAN -> NRT) and verify the map renders with both airport markers and a connecting arc.

### Backend Airports REST Endpoints

- [x] T007 Create NestJS `AirportsModule`, `AirportsController`, and `AirportsService` in `apps/api/src/airports/`
- [x] T008 [US1] Implement `GET /airports/search?q=` with Redis caching in `apps/api/src/airports/airports.controller.ts`
- [x] T009 [US1] Implement `GET /airports/:iataCode` with Redis caching in `apps/api/src/airports/airports.controller.ts`
- [x] T010 [US1] Implement `GET /airports/nearby` with Redis caching in `apps/api/src/airports/airports.controller.ts`
- [x] T011 [US1] Implement `GET /airports/all` with Redis caching in `apps/api/src/airports/airports.controller.ts`
- [x] T012 [US1] Write API E2E tests in `apps/api/test/airports.e2e-spec.ts` and verify they pass

### Frontend Map Foundation & Components

- [ ] T013 Install map dependencies: `maplibre-gl`, `react-map-gl`, `@turf/great-circle`, `@turf/helpers` in `apps/web/package.json`
- [ ] T014 [US1] Create frontend API client in `apps/web/lib/airport-service.ts` to call backend airport endpoints
- [ ] T015 [US1] Create `MapContainer.tsx` in `apps/web/components/map/MapContainer.tsx` with dynamic Next.js wrapper (ssr: false)
- [ ] T016 [US1] Create `MapControls.tsx` in `apps/web/components/map/MapControls.tsx` for zoom and styles
- [ ] T017 [US1] Create `AirportMarkerLayer.tsx` in `apps/web/components/map/AirportMarkerLayer.tsx` using clustered markers
- [ ] T018 [US1] Create `AirportPopup.tsx` in `apps/web/components/map/AirportPopup.tsx` showing details on click
- [ ] T019 [US1] Create `FlightRouteLayer.tsx` in `apps/web/components/map/FlightRouteLayer.tsx` using Turf great-circle arcs
- [ ] T020 [US1] Create helper utilities in `apps/web/components/map/map-utils.ts` for great-circle routes and viewport bound fits
- [ ] T021 [US1] Integrate map panel into the search results page layout in `apps/web/app/search/page.tsx`

**Checkpoint**: User Story 1 is functional. Can search flights, see markers and curved route arc on results page.

---

## Phase 4: User Story 2 - Airport Autocomplete with Map Preview (Priority: P2)

**Goal**: real-time map preview during autocomplete typing and selection

- [ ] T022 [US2] Implement autocomplete suggestion list dropdown on origin/destination fields in flight search form
- [ ] T023 [US2] Wire selection change in search form to place live preview markers and dashed preview arcs on map

---

## Phase 5: User Story 3 - Flight Route Details Map (Priority: P2)

**Goal**: Show route map with layovers on flight details page

- [ ] T024 [US3] Create specific flight route detail map rendering (with stopovers) on `/search/[flightId]` page
- [ ] T025 [US3] Show details popup or tooltip on layover markers on hover

---

## Phase 6: User Story 4 & 5 - Dark Mode & Destination Explorer (Priority: P3)

**Goal**: Support dark/light map styles and destination exploration

- [ ] T026 [US4] Configure map tile style toggle and automatic sync with app theme (light/dark tiles)
- [ ] T027 [US5] Implement popular destination markers on homepage/explore map with search form pre-fill on click

---

## Phase 7: Polish & E2E Validation

**Purpose**: UI/UX polish, bundle optimization, and Playwright UI tests

- [ ] T028 [P] Update documentation in `docs/` and walkthrough
- [ ] T029 Code cleanups, linting, type-checking fixes
- [ ] T030 Write Playwright E2E tests for map search flow and interactions in `apps/web/tests/map.spec.ts`
- [ ] T031 Run validation scenarios in `specs/005-map-integration/quickstart.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies
- **Foundational (Phase 2)**: Depends on Setup, blocks all User Stories
- **User Story 1 (Phase 3)**: Depends on Foundational phase completion. This is the MVP.
- **User Story 2 & 3 (Phases 4-5)**: Depend on User Story 1 map component foundation.
- **User Story 4 & 5 (Phase 6)**: Depend on User Story 1 map component foundation.
- **Polish (Phase 7)**: Depends on all user stories being complete.
