# Implementation Plan: Bookings Management & Confirmation

**Branch**: `011-booking-management` | **Date**: 2026-07-19 | **Spec**: [spec.md](./spec.md)
**Input**: Grilling session decisions from [research/booking-management-decisions.md](../../research/booking-management-decisions.md)

> **Context**: Feature 10 (Stripe Payment System) built the payment pipeline with authorize-then-capture, FSM lifecycle, webhooks, and idempotency. This feature adds the post-payment experience: Booking record creation, confirmation/failure states, flight data snapshots, the My Bookings list page, the booking detail page, and the checkout loading escalation.

## Summary

Build the complete post-payment booking management experience. The system creates a `Booking` record at the start of the confirm pipeline (using a client-generated UUID), stores flight data snapshots, renders three booking states (PROCESSING, CONFIRMED, FAILED) on a detail page, implements context-aware failure handling with retry routing, provides a tabbed My Bookings list page (Upcoming/Past), and adds a 4-phase checkout loading escalation for transparency during pipeline execution.

## Technical Context

**Language/Version**: TypeScript / Node.js + Python 3.11
**Primary Dependencies**: NestJS, Next.js (App Router), Prisma, Stripe SDK, Duffel SDK
**Storage**: PostgreSQL (1 new model + 2 new enums + 3 modified models), Redis (caching)
**Testing**: Jest (backend E2E), Playwright (frontend E2E)
**Target Platform**: Web application (full-stack: backend API + frontend UI)
**Performance Goals**: Booking detail page loads from DB snapshot in <200ms. My Bookings list page renders in <500ms.
**Constraints**: Zero Duffel API calls on booking detail page. Client-generated UUID must be validated server-side. Charge messages derived from Payment.status, not failureReason.

## Constitution Check

*GATE: Passed.*

- **I. Flight-First Architecture**: ✅ Booking management IS the core flight booking lifecycle — the natural completion of the search → book → confirm flow.
- **II. Deterministic Transaction Boundary**: ✅ Entire feature is deterministic. No AI involvement. Booking CRUD, flight snapshots, and status rendering are all database reads/writes.
- **III. API Budget Discipline**: ✅ Zero Duffel API calls at render time. Flight data is snapshotted at booking time. Only the existing confirm pipeline call (PNR creation) touches Duffel.
- **IV. Observability & Operational Visibility**: ✅ Booking status transitions logged. Failed bookings include failureReason for diagnosis. Payment.status independently verified for charge messages.
- **V. Incremental Delivery**: ✅ Split into 7 phases. Each phase is independently testable. Phase 1–3 (schema + backend + pipeline) form the API MVP. Phase 4–6 (frontend) add the UI. Phase 7 (E2E) validates everything.

## Project Structure

### Documentation (this feature)

```text
specs/011-booking-management/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Research findings
├── data-model.md        # Schema definitions
├── quickstart.md        # Validation scenarios
├── contracts/
│   └── api.md           # API endpoint contracts
├── PRD.md               # Product requirements document
└── tasks.md             # Created by /speckit-tasks
```

### Source Code Changes

```text
apps/api/
├── prisma/
│   └── schema.prisma                         # MODIFIED: +1 model (Booking), +2 enums, +3 relation extensions
├── src/
│   ├── booking/                              # NEW: entire module
│   │   ├── booking.module.ts                 # NEW: NestJS module definition
│   │   ├── booking.controller.ts             # NEW: REST endpoints (list, detail)
│   │   ├── booking.service.ts                # NEW: booking CRUD, tab queries, status management
│   │   └── dto/
│   │       ├── booking-list-query.dto.ts     # NEW: list query params DTO
│   │       └── booking-response.dto.ts       # NEW: response DTOs (list item, detail)
│   ├── payment/
│   │   ├── payment.service.ts                # MODIFIED: create Booking(PROCESSING) as first pipeline step
│   │   └── dto/
│   │       └── confirm-payment.dto.ts        # MODIFIED: add bookingId field
│   └── app.module.ts                         # MODIFIED: register BookingModule
└── test/
    └── booking.e2e-spec.ts                   # NEW: booking management E2E tests

apps/web/
├── app/
│   ├── bookings/
│   │   ├── page.tsx                          # NEW: My Bookings list page
│   │   └── [bookingId]/
│   │       └── page.tsx                      # NEW: Booking detail page
│   └── api/
│       └── bookings/
│           └── route.ts                      # NEW: Next.js API proxy route (if needed)
├── components/
│   ├── bookings/
│   │   ├── BookingsList.tsx                  # NEW: tabbed bookings list component
│   │   ├── BookingCard.tsx                   # NEW: booking row/card component
│   │   ├── BookingDetail.tsx                 # NEW: booking detail display
│   │   ├── BookingStatusBadge.tsx            # NEW: status badge component
│   │   ├── BookingFailureState.tsx           # NEW: failure view with retry
│   │   ├── BookingConfirmationBanner.tsx     # NEW: success celebration banner
│   │   └── BookingProcessingState.tsx        # NEW: processing indicator
│   └── checkout/
│       └── CheckoutLoadingEscalation.tsx     # NEW: 4-phase loading escalation
└── tests/
    └── bookings.spec.ts                      # NEW: Playwright E2E tests

packages/shared/
└── src/
    ├── booking-status.ts                     # NEW: BookingStatus enum
    ├── booking-failure-reason.ts             # NEW: BookingFailureReason enum
    └── booking-types.ts                      # NEW: shared booking DTOs and snapshot types
```

## Implementation Phases

### Phase 1: Database Schema & Shared Types

**Scope**: Prisma schema changes, migration, shared TypeScript types.

**Deliverables**:
- Add `BookingStatus` and `BookingFailureReason` enums to Prisma schema
- Add `Booking` model with all fields (id, userId, bookingIntentId, paymentId, status, failureReason, pnrReference, duffelOrderId, flightSnapshot, passengerSnapshot, totalAmount, currency, departureAt, timestamps)
- Add relations: User.bookings, BookingIntent.booking, Payment.booking
- Add indexes: userId, userId+status, bookingIntentId, departureAt
- Run migration: `npx prisma migrate dev`
- Export shared types: `BookingStatus`, `BookingFailureReason`, `FlightSnapshot`, `PassengerSnapshot`, `BookingListItemDto`, `BookingDetailDto`

**Verification**: Migration applies cleanly. Prisma Client regenerated. Shared types compile.

---

### Phase 2: Booking Service & REST API

**Scope**: NestJS BookingModule with CRUD endpoints.

**Deliverables**:
- `BookingModule` with controller and service
- `BookingService.createBooking(userId, bookingId, bookingIntentId, ...)` — creates Booking with PROCESSING status
- `BookingService.updateToConfirmed(bookingId, pnrReference, duffelOrderId, flightSnapshot, passengerSnapshot)` — updates status + snapshots
- `BookingService.updateToFailed(bookingId, failureReason, flightSnapshot?, passengerSnapshot?, departureAt?)` — sets FAILED, reason, and optional snapshots/departure (crucial for preserving data on CAPTURE_FAILED)
- `BookingService.listBookings(userId, tab, page, limit)` — tab-filtered paginated list
- `BookingService.getBookingDetail(bookingId, userId)` — full detail with payment status join
- `GET /api/bookings` — list endpoint with tab/page/limit query params
- `GET /api/bookings/:bookingId` — detail endpoint with ownership check
- DTOs: `BookingListQueryDto`, `BookingListResponseDto`, `BookingDetailResponseDto`

**Verification**: Endpoints return correct data. Ownership check returns 403 for other users' bookings. 404 for non-existent bookings.

---

### Phase 3: Payment Pipeline Integration

**Scope**: Modify the confirm pipeline to create Booking records and validate client-generated UUIDs.

**Deliverables**:
- Modify `ConfirmPaymentDto` to accept `bookingId` (UUID v4 string)
- Add server-side UUID validation at the top of the confirm handler:
  - Format validation (must be valid UUID v4) → 400
  - Ownership check (existing booking for different user) → 403
  - Same-user idempotency replay
  - Concurrency handling: Catch unique constraint violations (Prisma error P2002) on insert to prevent TOCTOU race conditions.
    - If collision is on `id` (PK): Fall back to standard idempotency replay using the provided `bookingId`.
    - If collision is on `bookingIntentId`: Query the database for the existing Booking using `bookingIntentId`. Verify ownership (`userId` check). If ownership matches, gracefully return the existing booking (enabling the client to retrieve the correct, pre-existing `bookingId` after page reloads or escape hatch triggers). If ownership does NOT match (cross-user injection/collision), return `403 Forbidden` immediately rather than throwing a 500.
- Insert `BookingService.createBooking()` as the FIRST step of the confirm pipeline (before Stripe authorization)
- On pipeline success: call `BookingService.updateToConfirmed()` with PNR, Duffel order ID, and flight/passenger snapshots
- On pipeline failure: call `BookingService.updateToFailed()` with the appropriate `BookingFailureReason`. For `CAPTURE_FAILED` failures (which occur after Duffel PNR creation), we MUST pass the flight/passenger snapshots and departure date retrieved from Duffel so they are preserved in the DB.
- Map existing pipeline error types to `BookingFailureReason` enum values
- Include `bookingId` in the confirm response (success and failure)

**Verification**: Booking record created with PROCESSING status before Stripe call. Updated to CONFIRMED on success. Updated to FAILED with correct reason on failure. Cross-user UUID rejected with 403.

---

### Phase 4: Checkout Loading Escalation (Frontend)

**Scope**: Build the 4-phase loading component on the checkout page.

**Deliverables**:
- `CheckoutLoadingEscalation` component with 4 timed phases:
  - Phase 1 (0–10s): Animated stepper with named steps (Authorizing → Reserving → Finalizing)
  - Phase 2 (10–20s): Animation slows, reassurance message appears
  - Phase 3 (20s+): "Check My Bookings" escape hatch link to `/bookings/[bookingId]`
  - Phase 4 (45s+): Auto-redirect to `/bookings/[bookingId]`
- Client-side UUID v4 generation on "Confirm Payment" click
- UUID stored in component state (available for escape hatch URL immediately)
- Confirm button disabled on click + `beforeunload` warning registered
- `bookingId` sent in the confirm request payload
- On success response: redirect to `/bookings/[bookingId]?confirmed=true`
- On failure response: redirect to `/bookings/[bookingId]`

**Verification**: All 4 phases transition at correct timings. Escape hatch link points to correct URL. Confirm button disables on click. Redirect works on success and failure.

---

### Phase 5: Booking Detail Page (Frontend)

**Scope**: Build the booking detail page with three render states.

**Deliverables**:
- `/bookings/[bookingId]/page.tsx` — Next.js App Router page
- `BookingDetail` component rendering full flight snapshot, passenger details, PNR, payment summary
- `BookingConfirmationBanner` — success celebration UI (shown when `?confirmed=true`). The page component MUST strip the `confirmed` query parameter from the URL on mount (e.g. using `window.history.replaceState` or Next.js `router.replace` to update the URL path without triggering a server re-render) to prevent the banner from displaying again on manual page refreshes.
- `BookingProcessingState` — processing indicator with "Your booking is being processed" message
- `BookingFailureState` — failure view with:
  - Error explanation from `failureReason`
  - Charge status message derived from `Payment.status` (NOT failureReason)
  - Context-aware retry button:
    - `OFFER_EXPIRED`/`PRICE_CHANGED` → Search results with pre-filled route
    - `BOOKING_TIMEOUT`/`SYSTEM_ERROR` → Flight detail page
    - `CAPTURE_FAILED` → Contact support
- `BookingStatusBadge` — color-coded status badge component

**Verification**: Confirmed state shows flight snapshot and PNR. `?confirmed=true` shows celebration banner. Failed state shows correct error and retry button. Processing state shows indicator. Charge message reads from Payment.status.

---

### Phase 6: My Bookings List Page (Frontend)

**Scope**: Build the My Bookings list page with Upcoming/Past tabs.

**Deliverables**:
- `/bookings/page.tsx` — Next.js App Router page with tab navigation
- `BookingsList` component with tab state management (Upcoming / Past)
- `BookingCard` component for each booking row:
  - Destination city, departure/arrival dates, airline name + logo
  - PNR reference, total amount, status badge
  - Failed bookings: "Failed" badge + retry action
  - Processing bookings: "Processing" badge
- Pagination controls
- Empty state: "No bookings yet — Search Flights" CTA
- Add "My Bookings" to the top navigation bar
- Upcoming tab: sorted by departure date (soonest first), PROCESSING and FAILED at top
- Past tab: sorted by departure date (most recent first)

**Verification**: Tabs switch correctly. Bookings appear in correct tabs based on departure date. Status badges render correctly. Failed bookings show retry. Empty state renders for new users. Pagination works.

---

### Phase 7: E2E Testing & Verification

**Scope**: Backend and frontend E2E tests covering all user stories.

**Deliverables**:
- Backend E2E tests (`apps/api/test/booking.e2e-spec.ts`):
  - Booking list endpoint (tab filtering, pagination, ownership)
  - Booking detail endpoint (ownership check, 404, 403)
  - Client-generated UUID validation (format, cross-user, idempotency)
  - Pipeline integration (Booking created before Stripe call, updated on success/failure)
- Frontend Playwright tests (`apps/web/tests/bookings.spec.ts`):
  - My Bookings list page (tabs, empty state, status badges)
  - Booking detail page (confirmed state, failure state, processing state)
  - Confirmation banner (appears with `?confirmed=true`, gone without)
  - Loading escalation (phase transitions, escape hatch)
- Update `context/progress-checker.md` with Feature 11 completion status
- Update `context/architecture.md` with new booking data flow

**Verification**: All E2E tests pass. No regressions in existing tests.

## Complexity Tracking

No constitution violations. All complexity is justified by the core feature requirements.
