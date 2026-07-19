# PRD: Bookings Management & Confirmation (Feature 11)

## Problem Statement

After completing a Stripe payment in the Flight Booking System, users have no landing page to confirm their booking was successful, no way to view their booking details, and no central place to manage their bookings. The system processes real money and creates real flight reservations (PNRs), but the post-payment experience is a dead end — users pay and see nothing. This destroys trust and makes the platform feel unreliable, directly impacting customer retention and willingness to use the system for future bookings.

Additionally, when the payment pipeline fails (Duffel timeout, expired offer, capture failure), users have no visibility into what went wrong, whether they were charged, or what they should do next. The failure path is completely opaque.

## Solution

Build a complete post-payment booking management experience consisting of:

1. **Post-Payment Confirmation Flow**: After successful payment, redirect users to a booking detail page with a celebration banner showing their PNR reference, flight details, and a reassurance that their booking is confirmed. During pipeline execution, show a 4-phase loading escalation that transitions from confident animation to reassurance messaging to an escape hatch.

2. **Failure Transparency**: When the pipeline fails, redirect users to the same booking detail page rendered in a failure state — showing exactly what went wrong, whether they were charged (derived from live payment state, not assumed), and a context-aware retry button that routes to the correct page based on the failure type.

3. **My Bookings Dashboard**: A tabbed list page (Upcoming / Past) where users can see all their bookings with status badges, flight summaries, and quick actions. Failed bookings are visible with retry options. Processing bookings show their in-progress state.

## User Stories

1. As a customer who just paid for a flight, I want to see a confirmation page with my PNR reference and flight details, so that I know my booking was successful and I have a record of it.
2. As a customer waiting for my booking to be processed, I want to see a loading animation with progress steps, so that I know the system is working and not frozen.
3. As a customer whose booking is taking longer than expected, I want to see a reassurance message and an escape hatch to My Bookings, so that I'm not stuck on a spinning page with no options.
4. As a customer whose booking failed, I want to see exactly what went wrong and whether I was charged, so that I can decide whether to retry or contact support.
5. As a customer whose flight offer expired during booking, I want a "Search Again" button that pre-fills my original route, so that I don't have to re-enter everything from scratch.
6. As a customer whose Stripe capture failed after a PNR was created, I want to see a "Contact Support" action instead of a retry button, so that I don't create duplicate reservations.
7. As a customer, I want to see a list of all my upcoming bookings sorted by departure date, so that I can quickly find my next trip.
8. As a customer, I want to see my past bookings in a separate tab, so that I can reference previous trips and their details.
9. As a customer with a failed booking, I want to see it in my Upcoming tab with a "Failed" badge and retry action, so that I don't lose track of failed attempts.
10. As a customer with no bookings, I want to see a friendly empty state with a "Search Flights" call-to-action, so that I'm guided toward making my first booking.
11. As a customer, I want my booking detail page to load instantly from stored data without depending on external flight APIs, so that the page is always available and fast.
12. As a customer, I want the charge status message on a failed booking to reflect the actual state of my payment (not an assumption), so that I'm never told "No charge was made" when a hold is still active on my card.
13. As a customer clicking "Confirm Payment", I want the button to be disabled immediately so that I can't accidentally double-submit and risk duplicate charges.
14. As a customer, I want to see my booking in the "Past" tab automatically after my flight departure date passes, so that my Upcoming tab stays clean and relevant.

## Implementation Decisions

- **No separate confirmation page**: The booking detail page at `/bookings/[bookingId]?confirmed=true` renders a celebration state when the query param is present. Normal view on subsequent visits.
- **Client-generated UUID**: The frontend generates a UUID v4 as the bookingId before sending the confirm request. The server validates format, uniqueness, and ownership (403 if cross-user). This ensures the escape hatch URL is known before the HTTP response arrives.
- **Booking record created at pipeline start**: `Booking(status: PROCESSING)` is the first INSERT in the confirm handler — before any Stripe or Duffel calls. Not created at `/payments/create` (60–80% cart abandonment would pollute the table).
- **Promote BookingIntent → Booking**: BookingIntent remains a transient pre-payment entity with TTL cleanup. Booking is the durable post-commitment entity, linked back to the intent via foreign key.
- **Flight snapshot stored as JSON**: Complete flight details captured at PNR creation time and stored on the Booking record. Detail page reads entirely from the local database — zero Duffel API calls at render time.
- **`failureReason` and charge status are independent**: `Booking.failureReason` determines the retry button. `Payment.status` (live DB read) determines the charge message. Never conflated.
- **`PAYMENT_DECLINED` excluded from booking failures**: Card declines happen during Stripe Elements confirmation (client-side), before the Booking record exists. They're handled inline on the checkout page.
- **Context-aware retry routing**: `OFFER_EXPIRED`/`PRICE_CHANGED` → search results with pre-filled route, `BOOKING_TIMEOUT`/`SYSTEM_ERROR` → flight detail page, `CAPTURE_FAILED` → contact support.
- **Two tabs only**: Upcoming and Past. No Cancelled tab until the cancellation feature ships.
- **4-phase loading escalation**: Timed transitions (0–10s confident stepper, 10–20s reassurance, 20s+ escape hatch, 45s+ auto-redirect). Named steps designed for future SSE upgrade without UI rework.
- **Approach A (synchronous)**: Pipeline stays synchronous. No SSE, no Redis Pub/Sub, no background jobs. EventEmitter2 cross-instance degradation on multi-replica deployments was identified and avoided.

## Testing Decisions

Good tests verify external behavior through defined seams without testing implementation details.

The system will be tested across three primary seams:

- **Seam 1: `BookingService`** (API layer): Tests cover booking CRUD, tab-filtered queries, ownership validation, UUID format/uniqueness/ownership checks, and status transitions. External dependencies (Prisma) are mocked.
- **Seam 2: `PaymentService` confirm pipeline** (integration): Tests verify that Booking(PROCESSING) is created before Stripe calls, updated to CONFIRMED on success with flight snapshot, and updated to FAILED with correct failureReason on failure. Stripe and Duffel SDKs are mocked.
- **Seam 3: Frontend pages** (Playwright E2E): Tests cover the My Bookings list (tab switching, status badges, empty state, pagination), booking detail page (confirmed/failed/processing states, confirmation banner, retry buttons), and checkout loading escalation (phase transitions, escape hatch, redirect).

Prior art: `apps/api/test/payment.e2e-spec.ts` (backend E2E pattern), `apps/web/tests/*.spec.ts` (Playwright pattern).

## Out of Scope

- **Cancellation & refund UI**: No cancel button or refund request flow. Deferred to a dedicated Cancellation feature.
- **Email/SMS notifications**: No booking confirmation email. Deferred to a dedicated Notification feature.
- **E-Ticket PDF generation**: Handled by Feature 12.
- **Real-time SSE progress**: Approach A (synchronous + loading animation) used. SSE upgrade deferred.
- **Flight data refresh from Duffel**: Snapshot only. Optional refresh deferred to a future enhancement.
- **Cancelled tab**: Added when the cancellation feature ships.
- **AviationStack flight status tracking**: Separate future feature.

## Further Notes

- The 4-phase loading escalation's named steps (`AUTHORIZING → RESERVING → FINALIZING → CONFIRMED`) are designed so a future SSE upgrade only swaps trigger sources from timed transitions to real events — zero UI rework.
- `CAPTURE_FAILED` is the only failure where a PNR may exist while the payment state is ambiguous. This is why it routes to "Contact Support" rather than a retry action that could create duplicate reservations.
- The Upcoming/Past boundary is based on the flight `departureAt` field compared to current time. Bookings without a departure date (PROCESSING that never got a PNR) stay in Upcoming.
