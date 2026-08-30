# Tasks: Disruption & Flight-Change Management Phase 6

**Input**: Design documents from `/specs/014-disruption-flight-change-management/`

**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US3, US4)
- Include exact file paths in descriptions

## Path Conventions

- **NestJS backend**: `apps/api/src/`
- **TypeScript shared types**: `packages/shared/src/`

## Phase 1: Setup (Shared Infrastructure)

- [x] T001 Initialize database models and run migrations (Completed in Phase 1)
- [x] T002 Implement core domain normalizer, matcher, classifier, and diff (Completed in Phase 2)
- [x] T003 Implement synchronization pipeline service and claim mechanism (Completed in Phase 3)
- [x] T004 Implement signed webhook ingestion and event processor (Completed in Phase 4)
- [x] T005 Implement budget-aware reconciliation service (Completed in Phase 5)

## Phase 2: Foundational (Blocking Prerequisites)

- [x] T006 Ensure base disruption and webhook models exist (Completed in previous phases)

## Phase 3: User Story 3 - Traveller Disruption APIs & Local Read Model (Priority: P1)

**Goal**: Allow travellers to read the current itinerary (from newest revision or original snapshot) and disruption summaries locally without Duffel calls, and query disruption history or perform active revision acknowledgement and acceptance.

**Independent Test**: Use integration/E2E test suite to verify list and details endpoints populate extended fields, history is paginated and ordered correctly, and actions transition state atomically and idempotently.

### Tests for User Story 3

- [x] T007 Write failing E2E tests for booking detail/list read extensions, history pagination, and lifecycle action endpoints in apps/api/test/disruption.e2e-spec.ts

### Implementation for User Story 3

- [x] T008 [P] Extend DTO schemas in apps/api/src/booking/dto/booking-response.dto.ts to include currentItinerary and disruption fields
- [x] T009 Extend BookingService.getBookingDetail and listBookings in apps/api/src/booking/booking.service.ts to retrieve current itinerary (newest revision or flightSnapshot), timing fields, and disruption summary, strictly using local DB and obeying FEATURE_FLAG_DISRUPTION_SURFACING
- [x] T010 Implement owner-scoped paginated disruption history endpoint GET /api/bookings/:bookingId/disruptions in apps/api/src/disruption/api/disruption.controller.ts and DisruptionService
- [x] T011 Implement acknowledge endpoint POST /api/bookings/:bookingId/disruptions/:revisionId/acknowledge with active revision, detected state verification, and idempotency checks in apps/api/src/disruption/api/disruption.controller.ts
- [x] T012 Implement accept endpoint POST /api/bookings/:bookingId/disruptions/:revisionId/accept with local resolution (TRAVELLER_ACCEPTED) and idempotency checks in apps/api/src/disruption/api/disruption.controller.ts
- [x] T013 [P] Add transition audit logging for actions in apps/api/src/disruption/api/disruption.controller.ts or DisruptionService

## Phase 4: User Story 4 - Cancellation Integration (Priority: P1)

**Goal**: Integrate disruption resolution into the existing supplier-first cancellation flow, ensuring confirmation of cancellation transitions disruption status to RESOLVED (BOOKING_CANCELLED).

**Independent Test**: Verify via E2E test that when cancellation completes successfully, disruption is resolved, audit event is written, and sync races do not recreate revisions.

### Tests for User Story 4

- [x] T014 Write failing E2E tests for cancellation integration, race conditions, and refund recovery isolation in apps/api/test/cancellation.e2e-spec.ts

### Implementation for User Story 4

- [x] T015 Modify cancelBooking in apps/api/src/booking/booking.service.ts to resolve active disruption to RESOLVED (BOOKING_CANCELLED) in the same transaction that sets the booking to CANCELLED_PENDING_REFUND
- [x] T016 Ensure sync transactions in apps/api/src/disruption/sync/supplier-sync.service.ts check booking eligibility and abort write if booking is cancelled

## Phase 5: Polish & Cross-Cutting Concerns

- [x] T017 Run typescript compile, format, and lint checks across the backend
- [x] T018 Run the complete E2E test suite to verify no regressions in existing flows
