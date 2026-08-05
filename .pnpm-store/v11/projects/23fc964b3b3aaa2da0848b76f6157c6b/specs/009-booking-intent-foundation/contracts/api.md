# API Contracts: Booking Intent Foundation
**Feature**: 009-booking-intent-foundation
**Date**: 2026-07-10

---

## Endpoints

### POST /bookings/intent

Creates a new booking intent with validated passenger details and Duffel-confirmed pricing.

**Auth**: JWT required (Bearer token)

**Request Body**:
```json
{
  "flightOfferId": "uuid-of-flight-offer",
  "passengers": [
    {
      "type": "ADULT",
      "givenName": "John",
      "familyName": "Doe",
      "dateOfBirth": "1990-05-15",
      "gender": "male",
      "nationality": "US",
      "passportNumber": "X12345678",
      "passportExpiry": "2030-01-01",
      "useProfile": true
    },
    {
      "type": "CHILD",
      "givenName": "Jane",
      "familyName": "Doe",
      "dateOfBirth": "2018-03-20",
      "gender": "female",
      "nationality": "US",
      "passportNumber": null,
      "passportExpiry": null,
      "useProfile": false
    }
  ]
}
```

**Field details**:
- `flightOfferId`: UUID of the `FlightOffer` record from search results. Used to look up the cached offer data (origin, destination, dates, cabin class, passenger counts) **and** the Duffel offer ID for re-pricing.
- `duffelOfferId` is **not** a request field. The server derives it from the `FlightOffer` row identified by `flightOfferId` and calls `offers.get()` with that value. This guarantees the offer that gets re-priced (and later charged, in Feature B) is always the one the user actually selected — a client cannot redirect re-pricing to a different Duffel offer by supplying an arbitrary ID.
- `passengers[]`: Array of passenger objects. Count must match the flight offer's `adults + children + infants`. Submission order is preserved and stored (`BookingIntentPassenger.position`).
- `passengers[].useProfile`: If `true` for a passenger, backend pre-fills missing fields from the user's `TravelerProfile`. Only one passenger per request may have `useProfile: true`.
- `passengers[].passportNumber` / `passportExpiry`: optional for every passenger type. Passport is not currently required by this feature (see [spec.md](../spec.md) → User Story 1).

**Success Response (201)**:
```json
{
  "intentId": "uuid-of-booking-intent",
  "status": "PENDING",
  "originalPrice": 125.50,
  "confirmedPrice": 130.00,
  "priceChanged": true,
  "currency": "USD",
  "pricedAt": "2026-07-10T10:30:00Z",
  "intentExpiresAt": "2026-07-10T11:00:00Z",
  "offerExpiresAt": "2026-07-10T10:45:00Z",
  "passengers": [
    {
      "id": "uuid",
      "type": "ADULT",
      "givenName": "John",
      "familyName": "Doe",
      "dateOfBirth": "1990-05-15",
      "gender": "male",
      "nationality": "US",
      "preFilledFromProfile": true
    },
    {
      "id": "uuid",
      "type": "CHILD",
      "givenName": "Jane",
      "familyName": "Doe",
      "dateOfBirth": "2018-03-20",
      "gender": "female",
      "nationality": "US",
      "preFilledFromProfile": false
    }
  ],
  "flight": {
    "origin": "SGN",
    "destination": "NRT",
    "departureDate": "2026-08-15",
    "returnDate": null,
    "cabinClass": "economy"
  }
}
```

`intentExpiresAt` is when this `PENDING` intent will be soft-expired by the Phase 1 cron (`createdAt` + TTL). `offerExpiresAt` is Duffel's own expiration time for the underlying offer, when Duffel provides one — it can be earlier than `intentExpiresAt` and is informational only (nullable).

**Note**: Passport data is NOT included in this response. It's stored encrypted server-side and only returned on the detail endpoint, for the owning user.

**Error Responses**:

| Status | Code | Condition |
|--------|------|-----------|
| 400 | `VALIDATION_ERROR` | Invalid passenger data, infants > adults, total > 9 |
| 400 | `PASSENGER_COUNT_MISMATCH` | Passenger array count ≠ flight offer's declared breakdown |
| 401 | `UNAUTHORIZED` | Missing or invalid JWT |
| 404 | `OFFER_NOT_FOUND` | `flightOfferId` not found in database |
| 410 | `OFFER_EXPIRED` | Duffel offer no longer available |
| 502 | `UPSTREAM_UNAVAILABLE` | Duffel API unreachable |

---

### GET /bookings/intent/:id

Retrieves a booking intent with full passenger details and pricing snapshot.

**Auth**: JWT required (Bearer token). User must own the intent.

**Path Params**:
- `id`: UUID of the booking intent

**Success Response (200)**:
```json
{
  "intentId": "uuid",
  "status": "PENDING",
  "originalPrice": 125.50,
  "confirmedPrice": 130.00,
  "priceChanged": true,
  "currency": "USD",
  "pricedAt": "2026-07-10T10:30:00Z",
  "intentExpiresAt": "2026-07-10T11:00:00Z",
  "offerExpiresAt": "2026-07-10T10:45:00Z",
  "createdAt": "2026-07-10T10:30:00Z",
  "passengers": [
    {
      "id": "uuid",
      "type": "ADULT",
      "givenName": "John",
      "familyName": "Doe",
      "dateOfBirth": "1990-05-15",
      "gender": "male",
      "nationality": "US",
      "passportNumber": "X12345678",
      "passportExpiry": "2030-01-01",
      "preFilledFromProfile": true
    }
  ],
  "flight": {
    "origin": "SGN",
    "destination": "NRT",
    "departureDate": "2026-08-15",
    "returnDate": null,
    "cabinClass": "economy",
    "adults": 1,
    "children": 0,
    "infants": 0
  }
}
```

**Note**: Passport data IS included here (decrypted) because this endpoint is owner-only. Passenger order matches `BookingIntentPassenger.position`.

**Error Responses**:

| Status | Code | Condition |
|--------|------|-----------|
| 401 | `UNAUTHORIZED` | Missing or invalid JWT |
| 403 | `FORBIDDEN` | User does not own this intent |
| 404 | `NOT_FOUND` | Intent ID not found |
| 410 | `INTENT_EXPIRED` | Intent status is `EXPIRED` |

---

### GET /bookings/intent/prefill

Returns the logged-in user's `TravelerProfile` data formatted for pre-filling the primary passenger form.

**Auth**: JWT required (Bearer token)

**Success Response (200)**:
```json
{
  "hasProfile": true,
  "passenger": {
    "givenName": "John",
    "familyName": "Doe",
    "dateOfBirth": null,
    "gender": null,
    "nationality": "US",
    "passportNumber": "X12345678",
    "passportExpiry": "2030-01-01",
    "seatPreference": "window",
    "classPreference": "economy"
  },
  "missingFields": ["dateOfBirth", "gender"]
}
```

If no profile exists:
```json
{
  "hasProfile": false,
  "passenger": null,
  "missingFields": [
    "type",
    "givenName",
    "familyName",
    "dateOfBirth",
    "gender"
  ]
}
```

**Error Responses**:

| Status | Code | Condition |
|--------|------|-----------|
| 401 | `UNAUTHORIZED` | Missing or invalid JWT |