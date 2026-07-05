# API Contract: Airports

**Feature**: 005-map-integration | **Base Path**: `/airports`

---

## Endpoints

### GET /airports/search

Search airports by name or IATA code (autocomplete).

**Query Parameters**:
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `q` | string | Yes | Search query (min 2 characters) |
| `limit` | number | No | Max results (default: 10, max: 50) |

**Response 200**:
```json
{
  "data": [
    {
      "iataCode": "NRT",
      "name": "Narita International Airport",
      "city": "Tokyo",
      "country": "JP",
      "latitude": 35.7647,
      "longitude": 140.3864,
      "type": "LARGE_AIRPORT"
    }
  ],
  "count": 1
}
```

**Response 400**: Invalid query (less than 2 characters)
```json
{ "statusCode": 400, "message": ["q must be at least 2 characters"], "error": "Bad Request" }
```

**Cache**: Redis, TTL 24 hours, key pattern `airports:search:{sha256(q+limit)}`

---

### GET /airports/:iataCode

Get a single airport by IATA code.

**Path Parameters**:
| Param | Type | Description |
|-------|------|-------------|
| `iataCode` | string(3) | IATA airport code (uppercase) |

**Response 200**:
```json
{
  "iataCode": "HAN",
  "icaoCode": "VVNB",
  "name": "Noi Bai International Airport",
  "city": "Hanoi",
  "country": "VN",
  "region": "VN-HN",
  "latitude": 21.2212,
  "longitude": 105.807,
  "elevation": 39,
  "type": "LARGE_AIRPORT",
  "timezone": "Asia/Ho_Chi_Minh"
}
```

**Response 404**: Airport not found
```json
{ "statusCode": 404, "message": "Airport with IATA code 'XYZ' not found", "error": "Not Found" }
```

**Cache**: Redis, TTL 24 hours, key pattern `airports:detail:{iataCode}`

---

### GET /airports/nearby

Find airports within a radius of a geographic point.

**Query Parameters**:
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `lat` | number | Yes | Latitude (-90 to 90) |
| `lng` | number | Yes | Longitude (-180 to 180) |
| `radius` | number | No | Radius in km (default: 100, max: 500) |
| `limit` | number | No | Max results (default: 10, max: 50) |

**Response 200**:
```json
{
  "data": [
    {
      "iataCode": "HAN",
      "name": "Noi Bai International Airport",
      "city": "Hanoi",
      "country": "VN",
      "latitude": 21.2212,
      "longitude": 105.807,
      "type": "LARGE_AIRPORT",
      "distanceKm": 12.5
    }
  ],
  "count": 1,
  "center": { "lat": 21.0285, "lng": 105.8542 },
  "radiusKm": 100
}
```

**Cache**: Redis, TTL 1 hour, key pattern `airports:nearby:{sha256(lat+lng+radius+limit)}`

---

### GET /airports/all

Get all airports (lightweight payload for map rendering).

**Query Parameters**: None

**Response 200**:
```json
{
  "data": [
    {
      "iataCode": "HAN",
      "name": "Noi Bai International Airport",
      "city": "Hanoi",
      "country": "VN",
      "latitude": 21.2212,
      "longitude": 105.807,
      "type": "LARGE_AIRPORT"
    }
  ],
  "count": 7700
}
```

**Cache**: Redis, TTL 24 hours, key pattern `airports:all`

**Notes**: This endpoint returns a large payload (~300KB gzipped). Frontend should cache this response and use it for map marker rendering.

---

## Authentication

All airport endpoints are **public** (no JWT required). Airport data is non-sensitive static information. This decision avoids unnecessary auth overhead for the map UI and allows the map to render before the user logs in (e.g., on the homepage).

## Error Format

All errors follow the standard NestJS exception format:
```json
{
  "statusCode": 400,
  "message": ["validation error details"],
  "error": "Bad Request"
}
```

## Rate Limiting

Airport endpoints share the global rate limiter (100 requests/minute per IP). No additional per-endpoint limits needed since data is served from local DB + Redis cache.
