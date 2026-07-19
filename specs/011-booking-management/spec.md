# Feature Specification: Bookings Management & Confirmation

**Feature Branch**: `011-booking-management`

**Created**: 2026-07-19

**Status**: Ready

**Input**: Grilling session decisions from [research/booking-management-decisions.md](../../research/booking-management-decisions.md)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Post-Payment Confirmation (Priority: P1)

After completing a Stripe payment, the user sees a real-time processing animation on the checkout page while the pipeline runs (authorize → Duffel PNR → capture). Upon success, they are redirected to their booking detail page showing a confirmation banner with their PNR reference, flight details, and passenger summary.

**Why this priority**: This is the immediate post-payment experience. Without it, users pay and see nothing — destroying trust. This is the bridge between the Stripe payment feature (Feature 10) and the rest of the booking lifecycle.

**Independent Test**: Can be tested by completing a payment and verifying the redirect to `/bookings/[bookingId]?confirmed=true` renders the success state with PNR and flight data.

**Acceptance Scenarios**:

1. **Given** a user completes Stripe payment, **When** the confirm pipeline succeeds, **Then** the user is redirected to `/bookings/[bookingId]?confirmed=true` with a success banner displaying PNR reference, flight details snapshot, and passenger summary.
2. **Given** a user is on the checkout page, **When** they click "Confirm Payment", **Then** a 4-phase loading escalation is displayed: confident stepper (0–10s) → reassurance (10–20s) → escape hatch link (20s+) → auto-redirect (45s+).
3. **Given** a user clicks "Confirm Payment", **When** the confirm button is clicked, **Then** the button is disabled immediately and a `beforeunload` warning is registered to prevent accidental navigation.
4. **Given** a user visits `/bookings/[bookingId]` without the `?confirmed=true` param, **When** the booking is confirmed, **Then** the normal booking detail view is shown (no celebration banner).

---

### User Story 2 - Pipeline Failure Handling (Priority: P1)

When the payment pipeline fails (Duffel timeout, offer expired, capture failure), the user is redirected to the booking detail page showing a clear failure state with an explanation of what went wrong, a charge status derived from the actual payment state, and a context-aware retry button.

**Why this priority**: Equal to confirmation — failure handling is not optional. Without it, failed bookings are invisible and users don't know their money's status.

**Independent Test**: Can be tested by simulating pipeline failures and verifying the failure state renders with correct `failureReason`, correct `Payment.status`-derived charge message, and appropriate retry destination.

**Acceptance Scenarios**:

1. **Given** the Duffel offer has expired during the pipeline, **When** the pipeline fails with `OFFER_EXPIRED`, **Then** the booking detail page shows "This flight offer has expired" with a "Search Again" button linking to search results with pre-filled route params.
2. **Given** the Duffel PNR creation times out, **When** the pipeline fails with `BOOKING_TIMEOUT`, **Then** the booking detail page shows the timeout message and the charge status message is derived from `Payment.status` (not assumed from failure category).
3. **Given** Stripe capture fails after PNR creation, **When** the pipeline fails with `CAPTURE_FAILED`, **Then** the booking detail page shows a "Contact Support" action (since PNR exists but money state is ambiguous).
4. **Given** `Payment.status` is `AUTHORIZED` (void failed), **When** the failure page renders, **Then** the charge message says "A hold was placed on your card — we're working to release it" — NOT "No charge was made."

---

### User Story 3 - My Bookings List Page (Priority: P1)

The user navigates to `/bookings` and sees a tabbed list of their bookings organized into "Upcoming" and "Past" tabs. Each row shows the destination, dates, airline, PNR reference, and a status badge. Failed bookings appear in the Upcoming tab with a "Failed" badge and retry action.

**Why this priority**: Equal to confirmation — users need a central place to find all their bookings. This is the primary navigation target after booking.

**Independent Test**: Can be tested by creating bookings in various states and verifying the list renders correctly with proper tab assignment, sorting, and status badges.

**Acceptance Scenarios**:

1. **Given** a user has confirmed bookings with future flight dates, **When** they visit `/bookings`, **Then** those bookings appear in the "Upcoming" tab sorted by departure date (soonest first).
2. **Given** a user has bookings with past flight dates, **When** they visit `/bookings`, **Then** those bookings appear in the "Past" tab.
3. **Given** a user has a failed booking, **When** they view the "Upcoming" tab, **Then** the failed booking appears with a "Failed" badge and a context-aware retry button.
4. **Given** a user has a `PROCESSING` booking, **When** they view the "Upcoming" tab, **Then** the booking appears with a "Processing" badge.
5. **Given** a user has no bookings, **When** they visit `/bookings`, **Then** an empty state is shown with a "Search Flights" call-to-action.

---

### User Story 4 - Booking Detail Page (Priority: P1)

The user clicks on a booking from the list and sees the full booking detail page showing: flight details from the snapshot (airline, times, airports, duration, stops, fare class, baggage), passenger details, PNR reference, booking status, and payment summary.

**Why this priority**: The detail page is the single source of truth for a booking. It serves triple duty: confirmation view, failure view, and reference view.

**Independent Test**: Can be tested by navigating to `/bookings/[bookingId]` for bookings in various states and verifying the correct data and state-specific UI renders.

**Acceptance Scenarios**:

1. **Given** a confirmed booking exists, **When** the user visits `/bookings/[bookingId]`, **Then** the page displays flight snapshot data (airline, flight number, departure/arrival, duration, stops), passenger details, PNR reference, and payment summary.
2. **Given** the booking has a `PROCESSING` status, **When** the user visits the detail page, **Then** a processing indicator is shown with the message "Your booking is being processed."
3. **Given** the booking has a `FAILED` status with `failureReason: OFFER_EXPIRED`, **When** the user visits the detail page, **Then** the failure explanation and "Search Again" retry button are displayed.

---

### User Story 5 - Booking Record Creation & Client UUID (Priority: P1)

When the user clicks "Confirm Payment" on the checkout page, the client generates a UUID v4 as the bookingId, sends it with the confirm request, and the server creates a `Booking(status: PROCESSING)` as the first step of the pipeline — before any Stripe or Duffel calls.

**Why this priority**: This is the backend foundation that enables all other stories. The client-generated UUID ensures the escape hatch URL is available immediately.

**Independent Test**: Can be tested by sending a confirm request with a client-generated UUID and verifying the Booking record is created with `PROCESSING` status before the pipeline runs.

**Acceptance Scenarios**:

1. **Given** a valid confirm request with a client-generated UUID, **When** the server receives it, **Then** a Booking record is created with `status: PROCESSING` before Stripe authorization begins.
2. **Given** a confirm request with a UUID that belongs to a different user, **When** the server validates it, **Then** a 403 Forbidden is returned.
3. **Given** a confirm request with the same UUID from the same user, **When** the server validates it, **Then** it's treated as an idempotency replay.
4. **Given** a confirm request with an invalid UUID format, **When** the server validates it, **Then** a 400 Bad Request is returned.

---

### User Story 6 - Flight Data Snapshot (Priority: P2)

When a booking is confirmed, the complete flight details are stored as a snapshot on the Booking record. The booking detail page reads entirely from the local database with zero Duffel API calls.

**Why this priority**: Required for the detail page to function without external dependencies, but can be built after the core booking record structure.

**Independent Test**: Can be tested by creating a booking, verifying the snapshot is persisted, and loading the detail page without Duffel being available.

**Acceptance Scenarios**:

1. **Given** the confirm pipeline creates a PNR successfully, **When** the Booking is updated to `CONFIRMED`, **Then** the flight snapshot (airline, times, airports, segments, fare class, baggage) is stored on the Booking record.
2. **Given** a confirmed booking exists with a flight snapshot, **When** the detail page loads, **Then** zero calls are made to the Duffel API.

---

### Edge Cases

- What happens when the client-generated UUID is a valid UUID but already exists for a different user? → 403 Forbidden.
- What happens when the pipeline fails but the void/cancellation of the authorization also fails? → Charge message reads live `Payment.status`, showing "A hold was placed on your card" instead of falsely claiming "No charge was made."
- What happens when a user visits a bookingId that doesn't exist? → 404 page.
- What happens when the checkout loading escalation reaches Phase 4 (45s) but the pipeline is still running? → Auto-redirect to `/bookings/[bookingId]`; pipeline continues server-side; detail page shows current DB state.
- What happens when a user has a `PROCESSING` booking and revisits the detail page? → Shows processing state. When the pipeline completes, refreshing the page shows final state.
- How does the Upcoming/Past boundary work? → Based on the flight departure date compared to current time.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST create a `Booking` record with `status: PROCESSING` at the start of the confirm pipeline, before any Stripe or Duffel API calls.
- **FR-002**: System MUST accept a client-generated UUID v4 as the Booking primary key, with server-side validation (format, uniqueness, ownership).
- **FR-003**: System MUST store a complete flight data snapshot on the Booking record during PNR creation — the detail page MUST NOT depend on Duffel at render time.
- **FR-004**: System MUST render the booking detail page in three states: PROCESSING (with progress indicator), CONFIRMED (with success banner when `?confirmed=true`), and FAILED (with failure explanation and context-aware retry).
- **FR-005**: System MUST derive charge status messages from `Payment.status` (live DB read), NOT from `Booking.failureReason`. If the payment record does not exist (null `paymentId` due to early failure), the system MUST render: "No charge was made to your card."
- **FR-006**: System MUST implement a 4-phase loading escalation on the checkout page: confident stepper (0–10s), reassurance (10–20s), escape hatch (20s+), auto-redirect (45s+).
- **FR-007**: System MUST display bookings in two tabs: Upcoming (future or null flight dates for confirmed, failed, or processing status) and Past (past flight dates for completed, confirmed, or failed status).
- **FR-008**: System MUST map each `failureReason` to a specific retry destination: `OFFER_EXPIRED`/`PRICE_CHANGED` → search results, `BOOKING_TIMEOUT`/`SYSTEM_ERROR` → flight detail, `CAPTURE_FAILED` → contact support.
- **FR-009**: System MUST disable the confirm button immediately on click and register a `beforeunload` warning during pipeline execution.
- **FR-010**: System MUST sort Upcoming bookings by departure date (soonest first) and Past bookings by departure date (most recent first).
- **FR-011**: System MUST automatically clean up stale `PROCESSING` bookings (older than 15 minutes) using a hybrid strategy (read-time reactive update plus background cron sweep every 15 minutes) following strict reconciliation rules:
  - If Stripe payment is captured (`SUCCEEDED`) and PNR is successfully created/recovered, transition the booking to `CONFIRMED`.
  - If Stripe payment is captured but PNR creation failed, transition the booking to `FAILED` with `failureReason: CAPTURE_FAILED` and trigger an automated refund.
  - If Stripe payment is not captured (or no payment exists), transition to `FAILED` with `failureReason: SYSTEM_ERROR`.
  - Concurrency Guard: All status transitions MUST be guarded by a conditional database update (filtering by expected status `PROCESSING`). The downstream refund or void operation MUST only be executed if the update query affected exactly `1` row, preventing double refund transactions.

### Key Entities

- **Booking**: Post-commitment booking record with status lifecycle (`PROCESSING → CONFIRMED | FAILED | COMPLETED`), linked to BookingIntent and Payment. Stores flight snapshot and failure metadata.
- **BookingStatus enum**: `PROCESSING`, `CONFIRMED`, `FAILED`, `COMPLETED`.
- **BookingFailureReason enum**: `OFFER_EXPIRED`, `PRICE_CHANGED`, `BOOKING_TIMEOUT`, `CAPTURE_FAILED`, `SYSTEM_ERROR`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users are redirected to the booking detail page with confirmation state within 1 second of pipeline completion.
- **SC-002**: The booking detail page loads from the local database snapshot in under 200ms (no external API calls).
- **SC-003**: Failed bookings display the correct failure reason and charge status derived independently from `Payment.status`.
- **SC-004**: The 4-phase loading escalation transitions smoothly through all phases during slow pipelines (>10s).
- **SC-005**: The My Bookings list page correctly categorizes bookings into Upcoming and Past tabs based on flight departure date.
- **SC-006**: Client-generated UUID validation rejects malformed UUIDs and blocks cross-user ID injection with 403.

## Assumptions

- Feature 10 (Stripe Payment System) Phase 8 (Refund System) is complete or near-complete before Feature 11 implementation begins.
- The `BookingIntent` and `Payment` entities from Features 9 and 10 exist and are stable.
- Cancellation actions (cancel button, refund request) are explicitly out of scope — deferred to a dedicated Cancellation feature.
- Email/SMS notifications for booking confirmation are out of scope — deferred to a dedicated Notification feature.
- E-Ticket PDF generation is out of scope — handled by Feature 12.
- No real-time SSE progress updates — Approach A (synchronous + loading animation) is used.
