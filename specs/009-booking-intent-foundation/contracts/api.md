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
  "duffelOfferId": "off_mock_123",
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
- `flightOfferId`: UUID of the `FlightOffer` record from search results. Used to look up the cached offer data (origin, destination, dates, cabin class, passenger counts).
- `duffelOfferId`: The Duffel-side offer ID for re-pricing via `offers.get()`.
- `passengers[]`: Array of passenger objects. Count must match the flight offer's `adults + children + infants`.
- `passengers[].useProfile`: If `true` for the first ADULT passenger, backend pre-fills missing fields from the user's `TravelerProfile`. Ignored for non-primary passengers.
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
  "expiresAt": "2026-07-10T11:00:00Z",
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
**Note**: Passport data is NOT included in the response. It's stored encrypted server-side and only returned on the detail endpoint for the owning user.
**Error Responses**:
|
 Status 
|
 Code 
|
 Condition 
|
|
--------
|
------
|
-----------
|
|
 400 
|
`VALIDATION_ERROR`
|
 Invalid passenger data, infants > adults, total > 9 
|
|
 400 
|
`PASSENGER_COUNT_MISMATCH`
|
 Passenger array count ≠ flight offer's declared breakdown 
|
|
 401 
|
`UNAUTHORIZED`
|
 Missing or invalid JWT 
|
|
 404 
|
`OFFER_NOT_FOUND`
|
`flightOfferId`
 not found in database 
|
|
 410 
|
`OFFER_EXPIRED`
|
 Duffel offer no longer available 
|
|
 502 
|
`UPSTREAM_UNAVAILABLE`
|
 Duffel API unreachable 
|
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
  "expiresAt": "2026-07-10T11:00:00Z",
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
**Note**: Passport data IS included here (decrypted) because this endpoint is owner-only.
**Error Responses**:
|
 Status 
|
 Code 
|
 Condition 
|
|
--------
|
------
|
-----------
|
|
 401 
|
`UNAUTHORIZED`
|
 Missing or invalid JWT 
|
|
 403 
|
`FORBIDDEN`
|
 User does not own this intent 
|
|
 404 
|
`NOT_FOUND`
|
 Intent ID not found 
|
|
 410 
|
`INTENT_EXPIRED`
|
 Intent status is 
`EXPIRED`
|
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
  "missingFields": []
}
```
**Error Responses**:
|
 Status 
|
 Code 
|
 Condition 
|
|
--------
|
------
|
-----------
|
|
 401 
|
`UNAUTHORIZED`
|
 Missing or invalid JWT 
|