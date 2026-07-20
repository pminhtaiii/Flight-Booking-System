# Tasks: Bookings Management & Confirmation

**Input**: Design documents from `/specs/011-booking-management/`

**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: E2E tests are included in Phase 7 as requested by the plan.md verification plan.

**Organization**: Tasks are grouped by phase to align with PR execution order.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Next.js Web Frontend**: `apps/web/`
- **NestJS Backend API**: `apps/api/`
- **Shared Package**: `packages/shared/`

---

## Phase 1: Database Schema & Shared Types

**Purpose**: Database schema definition, migration execution, and shared type exports.

- [X] T001 [US5] [US6] Define `Booking` model, `BookingStatus` enum, and `BookingFailureReason` enum in [schema.prisma](apps/api/prisma/schema.prisma)
- [X] T002 [US5] Apply database migration and regenerate Prisma Client using `npx prisma migrate dev`
- [X] T003 [P] [US5] Define and export `BookingStatus` enum in [booking-status.ts](packages/shared/src/booking-status.ts)
- [X] T004 [P] [US5] Define and export `BookingFailureReason` enum in [booking-failure-reason.ts](packages/shared/src/booking-failure-reason.ts)
- [X] T005 [P] [US5] [US6] Define and export booking DTOs and snapshots in [booking-types.ts](packages/shared/src/booking-types.ts)

**Checkpoint**: Database updated and shared packages compiled. Ready for backend service development.

---

## Phase 2: Booking Service & REST API

**Purpose**: Core NestJS modules, controllers, DTOs, and database query methods.

- [X] T006 [P] [US3] [US4] [US5] [US6] Create NestJS `BookingModule` definition in [booking.module.ts](apps/api/src/booking/booking.module.ts)
- [X] T007 [US3] [US4] [US5] [US6] Create NestJS `BookingService` base CRUD in [booking.service.ts](apps/api/src/booking/booking.service.ts) (depends on T006)
- [X] T008 [US3] [US4] Implement `listBookings` and `getBookingDetail` queries in [booking.service.ts](apps/api/src/booking/booking.service.ts) (depends on T007)
- [X] T009 [P] [US3] [US4] Implement DTOs for paginated list query and responses in [dto/](apps/api/src/booking/dto/) (depends on T006)
- [X] T010 [P] [US3] [US4] Create `BookingController` exposing list and detail endpoints in [booking.controller.ts](apps/api/src/booking/booking.controller.ts) (depends on T006)
- [X] T011 [US3] [US4] [US5] [US6] Register `BookingModule` in [app.module.ts](apps/api/src/app.module.ts) (depends on T006)

**Checkpoint**: REST API endpoints are functional, secure, and ready for integration.

---

## Phase 3: Payment Pipeline Integration

**Purpose**: Integrate booking creation at start of checkout pipeline, validate client UUIDs, handle idempotency, and schedule sweep cron.

- [X] T012 [US5] Add `bookingId` field to [confirm-payment.dto.ts](apps/api/src/payment/dto/confirm-payment.dto.ts)
- [X] T013 [US5] Implement UUID format validation and user ownership checks in [payment.service.ts](apps/api/src/payment/payment.service.ts)
- [X] T014 [US5] Implement concurrency/idempotency collision resolution for `id` and `bookingIntentId` in [payment.service.ts](apps/api/src/payment/payment.service.ts)
- [X] T015 [US5] Insert `BookingService.createBooking` with `PROCESSING` status as the first step of the confirm pipeline in [payment.service.ts](apps/api/src/payment/payment.service.ts)
- [X] T016 [US1] [US2] [US6] Update booking to `CONFIRMED` on pipeline success and `FAILED` on pipeline failure (mapping errors to failure reason; for `CAPTURE_FAILED` failures, persist Duffel-retrieved snapshots and departure date) in [payment.service.ts](apps/api/src/payment/payment.service.ts)
- [X] T017 [US1] Implement stale `PROCESSING` booking cleanup and background sweeper cron in [booking.service.ts](apps/api/src/booking/booking.service.ts)

**Checkpoint**: Backend booking lifecycle and payment confirmation integration complete.

---

## Phase 4: Checkout Loading Escalation (Frontend)

**Purpose**: Frontend client-side UUID generation, timed progress stepper, and escape hatch handler.

- [X] T018 [P] [US5] Generate client-side UUID v4 on confirm payment click and pass it in payload in [checkout/page.tsx](apps/web/app/checkout/page.tsx)
- [X] T019 [US1] Build `CheckoutLoadingEscalation` component implementing all 4 timed phases (stepper, reassurance, escape hatch, auto-redirect) in [CheckoutLoadingEscalation.tsx](apps/web/components/checkout/CheckoutLoadingEscalation.tsx)
- [X] T020 [US1] Register `beforeunload` event handler and programmatically unregister it prior to programmatic redirects in [checkout/page.tsx](apps/web/app/checkout/page.tsx)

**Checkpoint**: Real-time loading indicators and navigation protection active on checkout.

---

## Phase 5: Booking Detail Page (Frontend)

**Purpose**: Booking detail view displaying flight snapshots, passenger tables, status badges, confirmation banner, and context-aware error handlers.

- [X] T021 [P] [US1] [US4] Implement `BookingStatusBadge` and `BookingConfirmationBanner` in [components/bookings/](apps/web/components/bookings/)
- [X] T022 [P] [US2] [US4] Implement `BookingProcessingState` and `BookingFailureState` with context-aware retry button in [components/bookings/](apps/web/components/bookings/)
- [X] T023 [US4] [US6] Implement main `BookingDetail` rendering component displaying flight segments snapshot, baggage, and passenger details in [components/bookings/BookingDetail.tsx](apps/web/components/bookings/BookingDetail.tsx)
- [X] T024 [US4] [US1] Implement booking detail page route with ownership validation in [bookings/[bookingId]/page.tsx](apps/web/app/bookings/%5BbookingId%5D/page.tsx) (on mount, strip `confirmed` query param via router.replace/replaceState to prevent banner re-display on refresh)

**Checkpoint**: Booking detail page fully renders PROCESSING, CONFIRMED, and FAILED states.

---

## Phase 6: My Bookings List Page (Frontend)

**Purpose**: Tabbed list page rendering upcoming and past booking items with pagination and retry actions.

- [X] T025 [P] [US3] Build `BookingCard` component displaying departure, destination, dates, PNR, status, and retry action in [components/bookings/BookingCard.tsx](apps/web/components/bookings/BookingCard.tsx)
- [X] T026 [US3] Build `BookingsList` component with tabs (Upcoming vs Past) and pagination in [components/bookings/BookingsList.tsx](apps/web/components/bookings/BookingsList.tsx)
- [X] T027 [US3] Implement list page route and add My Bookings to top navigation layout in [bookings/page.tsx](apps/web/app/bookings/page.tsx)

**Checkpoint**: Users can navigate to, browse, and filter their entire flight booking history.

---

## Phase 7: E2E Testing & Verification

**Purpose**: Automate validation of API endpoints and UI journeys, update codebase docs.

- [X] T028 [P] Implement backend API E2E tests covering detail, list, ownership, and pipeline in [booking.e2e-spec.ts](apps/api/test/booking.e2e-spec.ts)
- [X] T029 [P] Implement Playwright UI E2E tests covering loading escalation, detail states, lists, and retry actions in [bookings.spec.ts](apps/web/tests/bookings.spec.ts)
- [X] T030 Update system documentation in [progress-checker.md](context/progress-checker.md) and [architecture.md](context/architecture.md)

**Checkpoint**: Full integration verification completed. Feature ready for release.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Database & Types (Phase 1)**: Can start immediately.
- **Service & API (Phase 2)**: Depends on Phase 1 completion.
- **Pipeline Integration (Phase 3)**: Depends on Phase 2 completion.
- **Frontend Components (Phases 4–6)**: Can start in parallel after Phase 2 is complete, but Phase 4/5 integration depends on Phase 3 API payload formats.
- **E2E Testing (Phase 7)**: Depends on all implementation phases.

### Parallel Opportunities

- Shared type files (T003, T004, T005) in Phase 1 can be developed in parallel.
- Controller/DTO setup (T009, T010) can run in parallel.
- Component skeletons (T021, T022) in Phase 5 can be built in parallel.
- Playwright tests (T029) and backend Jest tests (T028) can be written in parallel.

---

## Implementation Strategy

### MVP First (Phases 1–3)
1. Apply database schemas and build shared types.
2. Build NestJS BookingService and REST endpoints.
3. Integrate booking creation and lifecycle updating within the checkout pipeline.
4. Verify via REST client that the backend lifecycle works correctly.

### Incremental Delivery (Phases 4–6)
1. Add the loading escalation to checkout UI.
2. Deploy the detailed booking view.
3. Add the historical booking list page.
