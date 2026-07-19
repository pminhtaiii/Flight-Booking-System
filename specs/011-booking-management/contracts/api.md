# API Contracts: Bookings Management & Confirmation

**Feature**: 011-booking-management | **Date**: 2026-07-19

## Backend API Endpoints (NestJS — port 3001)

### POST /api/payments/confirm (MODIFIED)

Modification to existing endpoint: accepts `bookingId` from client and creates Booking record as first pipeline step.

**Request Body** (additions to existing):
```json
{
  "bookingIntentId": "uuid",
  "bookingId": "uuid-v4-client-generated",
  "...existing fields..."
}
```

**Validation**:
- `bookingId` must be valid UUID v4 format → 400 if invalid
- `bookingId` must not exist for a different user → 403 if cross-user
- `bookingId` same user + same intent → idempotency replay

**Response** (unchanged — same as current):
```json
{
  "success": true,
  "bookingId": "uuid",
  "paymentId": "uuid",
  "pnrReference": "ABC123",
  "status": "CONFIRMED"
}
```

**Error Response** (failure):
```json
{
  "success": false,
  "bookingId": "uuid",
  "status": "FAILED",
  "failureReason": "OFFER_EXPIRED | PRICE_CHANGED | BOOKING_TIMEOUT | CAPTURE_FAILED | SYSTEM_ERROR",
  "message": "Human-readable failure explanation"
}
```

**Idempotency / Collision Replay Response** (when existing booking is still `PROCESSING`):
If a request is received and a `Booking` for the `bookingIntentId` already exists in `PROCESSING` status (e.g. concurrent submit or page reload), the server returns a 200 OK with the existing canonical `bookingId` to allow the client to redirect or poll safely:
```json
{
  "success": true,
  "bookingId": "canonical-existing-booking-uuid",
  "paymentId": null,
  "pnrReference": null,
  "status": "PROCESSING"
}
```

---

### GET /api/bookings

List all bookings for the authenticated user.

**Query Parameters**:
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| tab | `upcoming` \| `past` | `upcoming` | Which tab to query |
| page | number | 1 | Page number (1-indexed) |
| limit | number | 20 | Items per page (max 50) |

**Response**:
```json
{
  "bookings": [
    {
      "id": "uuid",
      "status": "CONFIRMED",
      "failureReason": null,
      "pnrReference": "ABC123",
      "totalAmount": 45000,
      "currency": "GBP",
      "departureAt": "2026-08-15T10:30:00Z",
      "flightSnapshot": {
        "segments": [
          {
            "airline": { "name": "British Airways", "iataCode": "BA" },
            "flightNumber": "BA123",
            "departureAirport": { "iataCode": "LHR", "name": "Heathrow", "city": "London" },
            "arrivalAirport": { "iataCode": "JFK", "name": "John F. Kennedy", "city": "New York" },
            "departureAt": "2026-08-15T10:30:00Z",
            "arrivalAt": "2026-08-15T13:45:00Z",
            "duration": "PT7H15M"
          }
        ],
        "totalDuration": "PT7H15M",
        "stops": 0,
        "cabinClass": "economy"
      },
      "createdAt": "2026-07-19T09:00:00Z"
    },
    {
      "id": "uuid-processing",
      "status": "PROCESSING",
      "failureReason": null,
      "pnrReference": null,
      "totalAmount": 45000,
      "currency": "GBP",
      "departureAt": null,
      "flightSnapshot": null,
      "createdAt": "2026-07-19T09:30:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 2,
    "totalPages": 1
  }
}
```

**Booking State Field Rules (Important for UI Handlers)**:
- **`PROCESSING` State Bookings**: Fields `flightSnapshot`, `pnrReference`, and `departureAt` are returned as `null` since the booking pipeline is running and flight details have not been finalized. The frontend `BookingCard` component MUST conditionally handle these null fields (e.g., display a "Processing details..." loading state instead of airline logos or dates, and hide/suppress the PNR field) to prevent page-render crashes.
- **`FAILED` State Bookings**: Depending on when the failure occurred, `flightSnapshot` and `departureAt` may be `null` (e.g., if it failed during Stripe authorization before Duffel reservation) or populated (e.g. if it failed during capture `CAPTURE_FAILED`). The frontend MUST handle both scenarios.
- **`CONFIRMED`/`COMPLETED` State Bookings**: All flight, departure, and PNR details will be fully populated.

**Auth**: Required (JWT Bearer token)

---

### GET /api/bookings/:bookingId

Get full booking detail for a specific booking.

**Path Parameters**:
- `bookingId` — UUID of the booking

**Response**:
```json
{
  "id": "uuid",
  "status": "CONFIRMED",
  "failureReason": null,
  "pnrReference": "ABC123",
  "duffelOrderId": "ord_abc123",
  "totalAmount": 45000,
  "currency": "GBP",
  "departureAt": "2026-08-15T10:30:00Z",
  "flightSnapshot": { "...full snapshot..." },
  "passengerSnapshot": { "...passenger details..." },
  "payment": {
    "id": "uuid",
    "status": "SUCCEEDED",
    "stripePaymentIntentId": "pi_xxx"
  }, // Note: "payment" is null if the pipeline failed before a Payment record was created
  "bookingIntent": {
    "id": "uuid",
    "offerId": "off_xxx"
  },
  "createdAt": "2026-07-19T09:00:00Z",
  "updatedAt": "2026-07-19T09:00:30Z"
}
```

**Edge Case (Null Payment)**:
If the booking fails before a Payment record is created (e.g., Stripe authorization fails at the top of the pipeline), `payment` is returned as `null` in the API response. The frontend MUST handle this case and render the charge message: "No charge was made to your card."

**Auth**: Required (JWT Bearer token). Returns 403 if booking belongs to a different user.
**Error**: Returns 404 if booking does not exist.

---

## Frontend Routes (Next.js — port 3000)

### /bookings

My Bookings list page with two tabs: Upcoming and Past.

**Data fetching**: Server Component calling `GET /api/bookings?tab={active_tab}`.

### /bookings/[bookingId]

Booking detail page. Renders differently based on:
- `status` field → PROCESSING / CONFIRMED / FAILED / COMPLETED
- `?confirmed=true` query param → celebration banner on first visit after payment
- `failureReason` field → context-aware retry button
- `payment.status` field → charge status message (independent from failureReason)

**Data fetching**: Server Component calling `GET /api/bookings/:bookingId`.

### Checkout page modifications (existing)

- Accept `bookingId` generation (UUID v4) in component state
- Send `bookingId` with confirm request
- 4-phase loading escalation component
- Redirect to `/bookings/[bookingId]?confirmed=true` on success
- Redirect to `/bookings/[bookingId]` on failure
