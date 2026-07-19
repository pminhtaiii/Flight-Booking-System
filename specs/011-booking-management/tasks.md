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

- [ ] T001 Define `Booking` model, `BookingStatus` enum, and `BookingFailureReason` enum in [schema.prisma](file:///c:/Booking%20Systems/apps/api/prisma/schema.prisma)
- [ ] T002 Apply database migration and regenerate Prisma Client using `npx prisma migrate dev`
- [ ] T003 [P] Define and export `BookingStatus` enum in [booking-status.ts](file:///c:/Booking%20Systems/packages/shared/src/booking-status.ts)
- [ ] T004 [P] Define and export `BookingFailureReason` enum in [booking-failure-reason.ts](file:///c:/Booking%20Systems/packages/shared/src/booking-failure-reason.ts)
- [ ] T005 [P] Define and export booking DTOs and snapshots in [booking-types.ts](file:///c:/Booking%20Systems/packages/shared/src/booking-types.ts)

**Checkpoint**: Database updated and shared packages compiled. Ready for backend service development.

---

## Phase 2: Booking Service & REST API

**Purpose**: Core NestJS modules, controllers, DTOs, and database query methods.

- [ ] T006 [P] Create NestJS `BookingService` base CRUD in [booking.service.ts](file:///c:/Booking%20Systems/apps/api/src/booking/booking.service.ts)
- [ ] T007 [P] Implement `listBookings` and `getBookingDetail` queries in [booking.service.ts](file:///c:/Booking%20Systems/apps/api/src/booking/booking.service.ts)
- [ ] T008 [P] Implement DTOs for paginated list query and responses in [dto/](file:///c:/Booking%20Systems/apps/api/src/booking/dto/)
- [ ] T009 [P] Create `BookingController` exposing list and detail endpoints in [booking.controller.ts](file:///c:/Booking%20Systems/apps/api/src/booking/booking.controller.ts)
- [ ] T010 Register `BookingModule` in [app.module.ts](file:///c:/Booking%20Systems/apps/api/src/app.module.ts)

**Checkpoint**: REST API endpoints are functional, secure, and ready for integration.

---

## Phase 3: Payment Pipeline Integration

**Purpose**: Integrate booking creation at start of checkout pipeline, validate client UUIDs, handle idempotency, and schedule sweep cron.

- [ ] T011 [US5] Add `bookingId` field to [confirm-payment.dto.ts](file:///c:/Booking%20Systems/apps/api/src/payment/dto/confirm-payment.dto.ts)
- [ ] T012 [US5] Implement UUID format validation and user ownership checks in [payment.service.ts](file:///c:/Booking%20Systems/apps/api/src/payment/payment.service.ts)
- [ ] T013 [US5] Implement concurrency/idempotency collision resolution for `id` and `bookingIntentId` in [payment.service.ts](file:///c:/Booking%20Systems/apps/api/src/payment/payment.service.ts)
- [ ] T014 [US5] Insert `BookingService.createBooking` with `PROCESSING` status as the first step of the confirm pipeline in [payment.service.ts](file:///c:/Booking%20Systems/apps/api/src/payment/payment.service.ts)
- [ ] T015 [US1] [US2] [US6] Update booking to `CONFIRMED` on pipeline success and `FAILED` on pipeline failure (mapping errors to failure reason) in [payment.service.ts](file:///c:/Booking%20Systems/apps/api/src/payment/payment.service.ts)
- [ ] T016 [US1] Implement stale `PROCESSING` booking cleanup and background sweeper cron in [booking.service.ts](file:///c:/Booking%20Systems/apps/api/src/booking/booking.service.ts)

**Checkpoint**: Backend booking lifecycle and payment confirmation integration complete.

---

## Phase 4: Checkout Loading Escalation (Frontend)

**Purpose**: Frontend client-side UUID generation, timed progress stepper, and escape hatch handler.

- [ ] T017 [P] [US5] Generate client-side UUID v4 on confirm payment click and pass it in payload in [checkout/page.tsx](file:///c:/Booking%20Systems/apps/web/app/checkout/page.tsx)
- [ ] T018 [US1] Build `CheckoutLoadingEscalation` component implementing all 4 timed phases (stepper, reassurance, escape hatch, auto-redirect) in [CheckoutLoadingEscalation.tsx](file:///c:/Booking%20Systems/apps/web/components/checkout/CheckoutLoadingEscalation.tsx)
- [ ] T019 [US1] Register `beforeunload` event handler and programmatically unregister it prior to programmatic redirects in [checkout/page.tsx](file:///c:/Booking%20Systems/apps/web/app/checkout/page.tsx)

**Checkpoint**: Real-time loading indicators and navigation protection active on checkout.

---

## Phase 5: Booking Detail Page (Frontend)

**Purpose**: Booking detail view displaying flight snapshots, passenger tables, status badges, confirmation banner, and context-aware error handlers.

- [ ] T020 [P] [US1] [US4] Implement `BookingStatusBadge` and `BookingConfirmationBanner` in [components/bookings/](file:///c:/Booking%20Systems/apps/web/components/bookings/)
- [ ] T021 [P] [US2] [US4] Implement `BookingProcessingState` and `BookingFailureState` with context-aware retry button in [components/bookings/](file:///c:/Booking%20Systems/apps/web/components/bookings/)
- [ ] T022 [US4] [US6] Implement main `BookingDetail` rendering component displaying flight segments snapshot, baggage, and passenger details in [components/bookings/BookingDetail.tsx](file:///c:/Booking%20Systems/apps/web/components/bookings/BookingDetail.tsx)
- [ ] T023 [US4] Implement booking detail page route with ownership validation in [bookings/[bookingId]/page.tsx](file:///c:/Booking%20Systems/apps/web/app/bookings/%5BbookingId%5D/page.tsx)

**Checkpoint**: Booking detail page fully renders PROCESSING, CONFIRMED, and FAILED states.

---

## Phase 6: My Bookings List Page (Frontend)

**Purpose**: Tabbed list page rendering upcoming and past booking items with pagination and retry actions.

- [ ] T024 [P] [US3] Build `BookingCard` component displaying departure, destination, dates, PNR, status, and retry action in [components/bookings/BookingCard.tsx](file:///c:/Booking%20Systems/apps/web/components/bookings/BookingCard.tsx)
- [ ] T025 [US3] Build `BookingsList` component with tabs (Upcoming vs Past) and pagination in [components/bookings/BookingsList.tsx](file:///c:/Booking%20Systems/apps/web/components/bookings/BookingsList.tsx)
- [ ] T026 [US3] Implement list page route and add My Bookings to top navigation layout in [bookings/page.tsx](file:///c:/Booking%20Systems/apps/web/app/bookings/page.tsx)

**Checkpoint**: Users can navigate to, browse, and filter their entire flight booking history.

---

## Phase 7: E2E Testing & Verification

**Purpose**: Automate validation of API endpoints and UI journeys, update codebase docs.

- [ ] T027 [P] Implement backend API E2E tests covering detail, list, ownership, and pipeline in [booking.e2e-spec.ts](file:///c:/Booking%20Systems/apps/api/test/booking.e2e-spec.ts)
- [ ] T028 [P] Implement Playwright UI E2E tests covering loading escalation, detail states, lists, and retry actions in [bookings.spec.ts](file:///c:/Booking%20Systems/apps/web/tests/bookings.spec.ts)
- [ ] T029 Update system documentation in [progress-checker.md](file:///c:/Booking%20Systems/context/progress-checker.md) and [architecture.md](file:///c:/Booking%20Systems/context/architecture.md)

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
- Booking service database queries (T007) and controller/DTO setup (T008, T009) can run in parallel.
- Component skeletons (T020, T021) in Phase 5 can be built in parallel.
- Playwright tests (T028) and backend Jest tests (T027) can be written in parallel.

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
