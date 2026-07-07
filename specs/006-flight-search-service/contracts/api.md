# API Contract: Flight Search

**Feature**: 006-flight-search-service
**Date**: 2026-07-07
**Provider**: Duffel API (`@duffel/api` SDK)

---

## POST /api/flights/search

Search for available flights.

### Authentication

Required. Bearer JWT token in `Authorization` header.

### Request Body

```json
{
  "origin": "HAN",
  "destination": "SGN",
  "departureDate": "2026-07-15",
  "returnDate": "2026-07-20",
  "passengers": 2
}
```

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| origin | string | Yes | 3-character uppercase IATA code, must exist in airports database |
| destination | string | Yes | 3-character uppercase IATA code, must exist in airports database, must differ from origin |
| departureDate | string | Yes | YYYY-MM-DD format, must be a future date |
| returnDate | string | No | YYYY-MM-DD format, must be a future date, must be ≥ departureDate |
| passengers | integer | Yes | 1–9 inclusive |

### Success Response (200 OK)

```json
{
  "results": [
    {
      "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "airline": "Vietnam Airlines",
      "flightNumber": "VN123",
      "departureAirport": "HAN",
      "arrivalAirport": "SGN",
      "departureTime": "2026-07-15T08:00:00",
      "arrivalTime": "2026-07-15T10:10:00",
      "duration": 130,
      "stops": 0,
      "price": 125.50,
      "currency": "USD",
      "fareClass": "Economy",
      "baggageAllowance": "1 checked bag(s)",
      "segments": [
        {
          "carrierCode": "VN",
          "flightNumber": "123",
          "operatingCarrier": "Vietnam Airlines",
          "departureAirport": "HAN",
          "departureTerminal": "T1",
          "departureTime": "2026-07-15T08:00:00",
          "arrivalAirport": "SGN",
          "arrivalTerminal": "T2",
          "arrivalTime": "2026-07-15T10:10:00",
          "duration": 130,
          "aircraft": "A321"
        }
      ],
      "returnSegments": null
    }
  ],
  "meta": {
    "totalResults": 15,
    "searchHash": "abc123def456...",
    "cached": false
  }
}
```

| Field | Description |
|-------|-------------|
| results[].id | Internal UUID (from `flight_offers` table). Used in `GET /api/flights/:id` |
| results[].airline | Human-readable airline name (title case) |
| results[].flightNumber | Combined carrier code + number (e.g., "VN123") |
| results[].segments | Array of outbound flight segments with full detail |
| results[].returnSegments | Array of return segments (null for one-way) |
| results[].segments[].operatingCarrier | Operating airline name (Duffel provides this natively) |
| results[].duration | Total duration in minutes |
| results[].stops | Number of stops (segments.length - 1) |
| results[].price | Total price as decimal |
| results[].currency | ISO 4217 currency code |
| results[].fareClass | Cabin class (economy, business, etc.) or null |
| results[].baggageAllowance | Human-readable baggage description or null |
| meta.totalResults | Count of results returned |
| meta.searchHash | SHA-256 of the search query (for debugging/tracing) |
| meta.cached | Whether the result came from cache |

### Error Responses

| Status | Code | Description |
|--------|------|-------------|
| 400 | VALIDATION_ERROR | Invalid input (missing fields, invalid IATA code, past date, etc.) |
| 401 | UNAUTHORIZED | Missing or invalid JWT token |
| 429 | RATE_LIMIT_EXCEEDED | Monthly API budget exhausted |
| 502 | UPSTREAM_UNAVAILABLE | Duffel API is down or timed out |

Error body format:
```json
{
  "statusCode": 429,
  "message": "Flight search capacity temporarily reached. Please try again later.",
  "code": "RATE_LIMIT_EXCEEDED"
}
```

---

## GET /api/flights/:id

Get flight offer details with live re-confirmed pricing.

### Authentication

Required. Bearer JWT token in `Authorization` header.

### Path Parameters

| Param | Type | Description |
|-------|------|-------------|
| id | UUID | Internal flight offer ID (from search results `results[].id`) |

### Success Response (200 OK)

```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "airline": "Vietnam Airlines",
  "flightNumber": "VN123",
  "departureAirport": "HAN",
  "arrivalAirport": "SGN",
  "departureTime": "2026-07-15T08:00:00",
  "arrivalTime": "2026-07-15T10:10:00",
  "duration": 130,
  "stops": 0,
  "originalPrice": 125.50,
  "confirmedPrice": 127.00,
  "priceChanged": true,
  "currency": "USD",
  "fareClass": "Economy",
  "baggageAllowance": "1 checked bag(s)",
  "segments": [
    {
      "carrierCode": "VN",
      "flightNumber": "123",
      "operatingCarrier": "Vietnam Airlines",
      "departureAirport": "HAN",
      "departureTerminal": "T1",
      "departureTime": "2026-07-15T08:00:00",
      "arrivalAirport": "SGN",
      "arrivalTerminal": "T2",
      "arrivalTime": "2026-07-15T10:10:00",
      "duration": 130,
      "aircraft": "A321"
    }
  ],
  "returnSegments": null,
  "expiresAt": "2026-07-15T06:00:00Z",
  "conditions": {
    "refundable": false,
    "changeable": true,
    "changeBeforeDeparture": {
      "allowed": true,
      "penaltyAmount": "50.00",
      "penaltyCurrency": "USD"
    }
  }
}
```

| Field | Description |
|-------|-------------|
| originalPrice | Price from the original search result |
| confirmedPrice | Live re-confirmed price from Duffel `GET /air/offers/{id}` |
| priceChanged | Boolean flag indicating if the price differs from the original |
| expiresAt | ISO 8601 timestamp when the offer expires on Duffel's side |
| conditions | Fare conditions (refundable, changeable) — Duffel provides this natively |

### Error Responses

| Status | Code | Description |
|--------|------|-------------|
| 400 | VALIDATION_ERROR | Invalid UUID format |
| 401 | UNAUTHORIZED | Missing or invalid JWT token |
| 404 | NOT_FOUND | UUID has never existed |
| 410 | OFFER_EXPIRED | Offer existed but has been purged from both cache and database |
| 502 | UPSTREAM_UNAVAILABLE | Duffel API is down or timed out |

#### 410 Gone Response (Expired Offer)

```json
{
  "statusCode": 410,
  "message": "This flight offer has expired. Use the search parameters below to find current availability.",
  "code": "OFFER_EXPIRED",
  "recovery": {
    "origin": "HAN",
    "destination": "SGN",
    "departureDate": "2026-07-15",
    "returnDate": "2026-07-20",
    "passengers": 2
  }
}
```

The `recovery` object contains the original search parameters from `search_history`, enabling the frontend to pre-fill the search form for one-click re-search.
