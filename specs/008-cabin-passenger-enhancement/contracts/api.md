# API Contract Changes: Cabin Class & Passenger Type Enhancement

**Feature**: 008-cabin-passenger-enhancement
**Date**: 2026-07-09
**Base contract**: `specs/006-flight-search-service/contracts/api.md`

This document describes **changes** to the existing flight search API contract. All unlisted fields remain unchanged.

---

## POST /api/flights/search — Request Changes

### Updated Request Body

```json
{
  "origin": "SGN",
  "destination": "NRT",
  "departureDate": "2026-07-20",
  "returnDate": "2026-07-27",
  "adults": 2,
  "children": 1,
  "infants": 0,
  "cabinClass": "business"
}
```

### Field Changes

| Field | Change | Type | Required | Validation |
|-------|--------|------|----------|------------|
| ~~passengers~~ | REMOVED | — | — | Replaced by adults/children/infants |
| adults | NEW | integer | Yes | 1–9, must be ≥ infants |
| children | NEW | integer | No | 0–8, default 0 |
| infants | NEW | integer | No | 0–4, default 0, must be ≤ adults |
| cabinClass | NEW | string | No | One of: `economy`, `premium_economy`, `business`, `first`. Default: `economy` |

**Cross-field validation**: `adults + children + infants ≤ 9`

---

## POST /api/flights/search — Response Changes

### Updated Result Object

```json
{
  "results": [
    {
      "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "airline": "Vietnam Airlines",
      "flightNumber": "VN300",
      "departureAirport": "SGN",
      "arrivalAirport": "NRT",
      "departureTime": "2026-07-20T23:30:00",
      "arrivalTime": "2026-07-21T07:00:00",
      "duration": 330,
      "stops": 0,
      "price": 2450.00,
      "currency": "USD",
      "fareClass": "Business",
      "baggageAllowance": "2 checked bag(s)",
      "requestedCabinClass": "business",
      "cabinClassMatch": "full",
      "cabinMismatchDetails": null,
      "segments": [
        {
          "carrierCode": "VN",
          "flightNumber": "300",
          "operatingCarrier": "Vietnam Airlines",
          "departureAirport": "SGN",
          "departureTerminal": "T2",
          "departureTime": "2026-07-20T23:30:00",
          "arrivalAirport": "NRT",
          "arrivalTerminal": "T1",
          "arrivalTime": "2026-07-21T07:00:00",
          "duration": 330,
          "aircraft": "A350",
          "cabinClass": "business"
        }
      ],
      "returnSegments": null
    }
  ],
  "meta": {
    "totalResults": 8,
    "searchHash": "abc123...",
    "cached": false,
    "requestedCabinClass": "business"
  }
}
```

### New/Changed Fields

| Field | Change | Description |
|-------|--------|-------------|
| results[].requestedCabinClass | NEW | The cabin class the user requested |
| results[].cabinClassMatch | NEW | `"full"` \| `"mixed"` \| `"downgraded"` |
| results[].cabinMismatchDetails | NEW | Array of mismatch details or `null` if `full` |
| results[].segments[].cabinClass | NEW | Actual cabin class for this specific segment |
| meta.requestedCabinClass | NEW | Echo of the requested cabin class |

### Cabin Mismatch Detail Object

```json
{
  "segmentIndex": 0,
  "leg": "outbound",
  "expected": "business",
  "actual": "economy",
  "route": "SGN → HAN"
}
```

| Field | Type | Description |
|-------|------|-------------|
| segmentIndex | integer | 0-based index within the leg's segments array |
| leg | string | `"outbound"` or `"return"` |
| expected | string | The cabin class the user requested |
| actual | string | The cabin class Duffel returned for this segment |
| route | string | Human-readable `"ORIGIN → DESTINATION"` for the mismatched segment |

### Classification Algorithm

```
1. Collect all segments from all slices (outbound + return)
2. Find the segment with the longest duration
3. If longestSegment.cabinClass ≠ requestedCabinClass → "downgraded"
4. Else if ANY segment.cabinClass ≠ requestedCabinClass → "mixed"
5. Else → "full"
```

---

## GET /api/flights/:id — Response Changes

### Updated Detail Response

Inherits the same new fields as the search result:

| Field | Change | Description |
|-------|--------|-------------|
| requestedCabinClass | NEW | The cabin class from the original search |
| cabinClassMatch | NEW | Computed from live re-priced offer segments |
| cabinMismatchDetails | NEW | Per-segment details or null |
| segments[].cabinClass | NEW | Per-segment cabin class |

### Updated 410 Gone Recovery Object

```json
{
  "statusCode": 410,
  "message": "This flight offer has expired...",
  "code": "OFFER_EXPIRED",
  "recovery": {
    "origin": "SGN",
    "destination": "NRT",
    "departureDate": "2026-07-20",
    "returnDate": "2026-07-27",
    "adults": 2,
    "children": 1,
    "infants": 0,
    "cabinClass": "business"
  }
}
```

| Field | Change | Description |
|-------|--------|-------------|
| recovery.~~passengers~~ | REMOVED | Replaced by breakdown |
| recovery.adults | NEW | Adult count from original search |
| recovery.children | NEW | Child count from original search |
| recovery.infants | NEW | Infant count from original search |
| recovery.cabinClass | NEW | Cabin class from original search |

---

## Error Responses — New Validation Errors

| Condition | Status | Message |
|-----------|--------|---------|
| infants > adults | 400 | "Number of infants cannot exceed number of adults" |
| adults + children + infants > 9 | 400 | "Maximum 9 passengers per search" |
| adults < 1 | 400 | "At least 1 adult passenger is required" |
| Invalid cabinClass value | 400 | "cabinClass must be one of: economy, premium_economy, business, first" |
