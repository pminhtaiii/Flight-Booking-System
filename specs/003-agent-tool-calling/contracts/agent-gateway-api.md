# Contract: Agent Gateway REST API

**Feature**: 003 — Agent Tool-Calling & Data Access
**Phase**: 1 — Design Contracts
**Date**: 2026-07-01

---

## Overview

The Agent Gateway exposes 3 read-only REST endpoints under `/api/agent-gateway/`. All endpoints require dual-layer authentication (service API key + user claim token). All responses are PII-stripped — no passport, payment, PNR, or e-ticket data is ever returned.

**Base URL**: `{NESTJS_BASE_URL}/api/agent-gateway`

**Common Headers** (required on all endpoints):

| Header           | Type   | Required | Description                                          |
|------------------|--------|----------|------------------------------------------------------|
| `X-Agent-API-Key`| string | ✅       | Static shared secret for service-to-service auth     |
| `X-User-Claim`   | string | ✅       | HMAC-SHA256 signed claim token identifying the user  |

**Common Error Responses**:

| Status | Code                    | When                                                   |
|--------|-------------------------|--------------------------------------------------------|
| 401    | `INVALID_API_KEY`       | `X-Agent-API-Key` missing or does not match            |
| 401    | `INVALID_CLAIM_TOKEN`   | `X-User-Claim` missing, malformed, tampered, or expired|
| 403    | `USER_INACTIVE`         | Authenticated user's account is inactive or deleted    |

---

## 1. Search Flights

**`GET /api/agent-gateway/flights/search`**

Search for flights via Amadeus. Returns a maximum of 5 PII-free results in the data provider's default ranking order.

**Maps to**: FR-001, FR-002, FR-005, FR-018

### Query Parameters

| Param        | Type    | Required | Constraints                  | Example      |
|--------------|---------|----------|------------------------------|--------------|
| `origin`     | string  | ✅       | 3-char IATA airport code     | `HAN`        |
| `destination`| string  | ✅       | 3-char IATA airport code     | `NRT`        |
| `date`       | string  | ✅       | `YYYY-MM-DD`, must be future | `2026-07-15` |
| `passengers` | integer | ✅       | 1–9                         | `2`          |

### Success Response — `200 OK`

Returns an array of **max 5** `FlightResult` objects.

```json
{
  "results": [
    {
      "airline": "string",
      "flightNumber": "string",
      "departureAirport": "string (IATA)",
      "arrivalAirport": "string (IATA)",
      "departureTime": "string (ISO 8601)",
      "arrivalTime": "string (ISO 8601)",
      "duration": "string (e.g. PT7H30M)",
      "stops": "integer",
      "price": "number",
      "currency": "string (ISO 4217)",
      "fareClass": "string",
      "baggageAllowance": "string"
    }
  ]
}
```

**PII exclusion**: No passport data, no payment data, no PNR codes in response.

### Error Responses

| Status | Code                 | When                                         |
|--------|----------------------|----------------------------------------------|
| 400    | `VALIDATION_ERROR`   | Missing/invalid params (bad IATA, bad date, passengers out of range) |
| 401    | `INVALID_API_KEY`    | See common errors                            |
| 401    | `INVALID_CLAIM_TOKEN`| See common errors                            |
| 403    | `USER_INACTIVE`      | See common errors                            |
| 429    | `RATE_LIMIT_EXCEEDED`| Too many requests — Amadeus budget protection|
| 502    | `UPSTREAM_UNAVAILABLE`| Amadeus API unreachable or returned error   |

### Example

**Request**:

```http
GET /api/agent-gateway/flights/search?origin=HAN&destination=NRT&date=2026-07-15&passengers=2 HTTP/1.1
Host: localhost:3000
X-Agent-API-Key: sk-agent-abc123def456
X-User-Claim: eyJ1c2VySWQiOiI1NTBl...signature
```

**Response** (`200 OK`):

```json
{
  "results": [
    {
      "airline": "Vietnam Airlines",
      "flightNumber": "VN310",
      "departureAirport": "HAN",
      "arrivalAirport": "NRT",
      "departureTime": "2026-07-15T08:30:00+07:00",
      "arrivalTime": "2026-07-15T15:00:00+09:00",
      "duration": "PT5H30M",
      "stops": 0,
      "price": 452.00,
      "currency": "USD",
      "fareClass": "Economy",
      "baggageAllowance": "23kg checked + 7kg carry-on"
    },
    {
      "airline": "ANA",
      "flightNumber": "NH858",
      "departureAirport": "HAN",
      "arrivalAirport": "NRT",
      "departureTime": "2026-07-15T10:15:00+07:00",
      "arrivalTime": "2026-07-15T17:45:00+09:00",
      "duration": "PT6H30M",
      "stops": 1,
      "price": 389.00,
      "currency": "USD",
      "fareClass": "Economy",
      "baggageAllowance": "23kg checked + 7kg carry-on"
    }
  ]
}
```

---

## 2. Get User Preferences

**`GET /api/agent-gateway/users/preferences`**

Retrieve the authenticated user's saved travel preferences. No query parameters — scoped entirely to the user identified by the claim token.

**Maps to**: FR-003, FR-005

### Query Parameters

None. User identity is derived from `X-User-Claim`.

### Success Response — `200 OK`

```json
{
  "seatPreference": "string | null",
  "classPreference": "string | null",
  "preferredAirlines": ["string"],
  "blacklistedAirlines": ["string"],
  "dietaryNeeds": "string | null"
}
```

**PII exclusion**: No passport number, no payment methods, no personal identifiers in response.

### Error Responses

| Status | Code                 | When                                         |
|--------|----------------------|----------------------------------------------|
| 401    | `INVALID_API_KEY`    | See common errors                            |
| 401    | `INVALID_CLAIM_TOKEN`| See common errors                            |
| 403    | `USER_INACTIVE`      | See common errors                            |
| 404    | `PROFILE_NOT_FOUND`  | User has no traveler profile on file         |

### Example

**Request**:

```http
GET /api/agent-gateway/users/preferences HTTP/1.1
Host: localhost:3000
X-Agent-API-Key: sk-agent-abc123def456
X-User-Claim: eyJ1c2VySWQiOiI1NTBl...signature
```

**Response** (`200 OK`):

```json
{
  "seatPreference": "window",
  "classPreference": "business",
  "preferredAirlines": ["Vietnam Airlines", "ANA"],
  "blacklistedAirlines": [],
  "dietaryNeeds": "vegetarian"
}
```

**Response** (`404 Not Found`):

```json
{
  "statusCode": 404,
  "code": "PROFILE_NOT_FOUND",
  "message": "No traveler profile exists for this user"
}
```

---

## 3. List User Bookings

**`GET /api/agent-gateway/users/bookings`**

Retrieve the authenticated user's active bookings. No query parameters — scoped entirely to the user identified by the claim token. No pagination required (assumption: 1–5 bookings per user).

**Maps to**: FR-004, FR-005

### Query Parameters

None. User identity is derived from `X-User-Claim`.

### Success Response — `200 OK`

Returns an array of `BookingResult` objects.

```json
{
  "bookings": [
    {
      "id": "string (UUID)",
      "airline": "string",
      "flightNumber": "string",
      "origin": "string (IATA)",
      "destination": "string (IATA)",
      "departureTime": "string (ISO 8601)",
      "arrivalTime": "string (ISO 8601)",
      "duration": "string (e.g. PT5H30M)",
      "stops": "integer",
      "fareClass": "string",
      "price": "number",
      "currency": "string (ISO 4217)",
      "passengers": "integer",
      "baggageAllowance": "string",
      "status": "string (CONFIRMED | PENDING | CANCELLED)"
    }
  ]
}
```

**PII exclusion**: No `pnrCode`, no `eTicketNumber`, no `paymentReference` in response.

### Error Responses

| Status | Code                 | When                                         |
|--------|----------------------|----------------------------------------------|
| 401    | `INVALID_API_KEY`    | See common errors                            |
| 401    | `INVALID_CLAIM_TOKEN`| See common errors                            |
| 403    | `USER_INACTIVE`      | See common errors                            |

### Example

**Request**:

```http
GET /api/agent-gateway/users/bookings HTTP/1.1
Host: localhost:3000
X-Agent-API-Key: sk-agent-abc123def456
X-User-Claim: eyJ1c2VySWQiOiI1NTBl...signature
```

**Response** (`200 OK`):

```json
{
  "bookings": [
    {
      "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "airline": "Vietnam Airlines",
      "flightNumber": "VN310",
      "origin": "HAN",
      "destination": "NRT",
      "departureTime": "2026-07-15T08:30:00+07:00",
      "arrivalTime": "2026-07-15T15:00:00+09:00",
      "duration": "PT5H30M",
      "stops": 0,
      "fareClass": "Business",
      "price": 1250.00,
      "currency": "USD",
      "passengers": 1,
      "baggageAllowance": "32kg checked + 7kg carry-on",
      "status": "CONFIRMED"
    },
    {
      "id": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
      "airline": "ANA",
      "flightNumber": "NH856",
      "origin": "NRT",
      "destination": "HAN",
      "departureTime": "2026-07-22T11:00:00+09:00",
      "arrivalTime": "2026-07-22T14:30:00+07:00",
      "duration": "PT5H30M",
      "stops": 0,
      "fareClass": "Business",
      "price": 1180.00,
      "currency": "USD",
      "passengers": 1,
      "baggageAllowance": "32kg checked + 7kg carry-on",
      "status": "CONFIRMED"
    }
  ]
}
```

---

## Cross-Cutting Concerns

### PII Fields — Never Returned by Any Endpoint

These fields exist in the database but are **structurally excluded** from all gateway responses:

| Field              | Source Table     | Why Excluded              |
|--------------------|-----------------|---------------------------|
| `passportNumber`   | TravelerProfile | Personal identification   |
| `paymentMethods`   | User            | Financial data            |
| `pnrCode`          | Booking         | Booking system identifier |
| `eTicketNumber`    | Booking         | Ticket identifier         |
| `paymentReference` | Booking         | Financial transaction ref |

### Audit Logging

Every gateway request (success or failure) produces an audit log entry:

```json
{
  "userId": "string (UUID)",
  "tool": "string (flights/search | users/preferences | users/bookings)",
  "timestamp": "string (ISO 8601)",
  "responseSize": "integer (bytes)",
  "statusCode": "integer",
  "error": "string | null"
}
```

**Maps to**: FR-014

### Rate Limiting

The `/flights/search` endpoint respects the existing Amadeus API budget (2,000 calls/month). Requests exceeding the rate limit return `429 RATE_LIMIT_EXCEEDED`.
