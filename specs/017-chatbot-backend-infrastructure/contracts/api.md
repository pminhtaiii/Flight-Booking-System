# API and Event Contracts: Chatbot Backend Infrastructure

All JSON objects are strict: unknown properties are rejected unless explicitly stated. All timestamps are UTC ISO 8601. All authenticated responses use `Cache-Control: no-store, private` where credentials, user state, or handoff state is present.

## Authentication Boundaries

### Browser → FastAPI

```http
Authorization: Bearer <existing user JWT>
Content-Type: application/json
Accept: text/event-stream
X-Trace-Id: <optional validated identifier>
X-Correlation-Id: <optional validated identifier>
Origin: <allowlisted web origin>
```

NestJS-issued chat tokens contain required `sub`, `iss`, `aud`, `jti`, and expiry claims while preserving legacy `id` during migration. FastAPI verifies the full profile, then calls the service-authenticated chat-access check with the derived identity/JTI so NestJS can reject inactive users and revoked sessions before quota or model-backed work. CORS allows configured origins only, methods `POST, OPTIONS`, and headers `Authorization, Content-Type, Accept, X-Trace-Id, X-Correlation-Id`; `allow_credentials=false`, wildcard origin is forbidden, disallowed origins receive explicit 403, and allowlisted auth/error responses retain correct CORS headers. The browser never sends service API keys or user-claim tokens.

### FastAPI deterministic/read client → NestJS Agent Gateway

```http
X-Agent-API-Key: <service secret>
X-User-Claim: <short-lived HMAC claim>
X-Trace-Id: <trace>
X-Correlation-Id: <chat session correlation>
```

This existing boundary supersedes raw user JWT forwarding to ordinary chat endpoints. Service-authenticated chat-access, session/memory/completed-turn/summary, read-tool, selection-attestation, and deterministic handoff endpoints use the same guards, but handoff creation is never registered as an LLM tool. Completed-turn/summary writes also carry the current session fencing token and reject stale owners.

### Checkout browser/server → NestJS

Existing user JWT guard. Handoff token is sent only in a POST body, never as a NestJS path/query parameter.

### Service-authenticated chat persistence

The Agent Gateway exposes these strict API-key plus user-claim endpoints:

- `POST /api/agent-gateway/chat/access/check`: body `{sub,jti,exp}`; verifies active user and NestJS revocation state and returns only `{allowed:true}` or stable 401/403.
- `POST /api/agent-gateway/chat/sessions`: creates a claimed-user session or validates an optional owned session ID.
- `GET /api/agent-gateway/chat/sessions/:sessionId/memory`: returns the authorized decrypted summary/recent-window projection.
- `POST /api/agent-gateway/chat/sessions/:sessionId/turns`: persists one USER/AGENT completed turn with `fencingToken` and rejects stale ownership.
- `POST /api/agent-gateway/chat/sessions/:sessionId/summaries`: persists one SUMMARY with `fencingToken` and rejects stale ownership.

Browser-facing chat message creation always overwrites sender/type to `USER/STANDARD`; only the service-authenticated gateway accepts `AGENT` or `SUMMARY`. Every stored content value is encrypted with record-bound AES-256-GCM before Prisma persistence, and every gateway read decrypts only after owner/session authorization. These endpoints never accept or require the raw browser JWT.

## FastAPI Streaming Contract

### POST `/chat/stream`

Request:

```json
{
  "message": "I want to book Flight 2",
  "sessionId": "uuid-or-null"
}
```

Rules:

- `message`: required non-empty string within configured maximum.
- `sessionId`: optional UUID. If absent, FastAPI creates a session through NestJS and returns it in `done`.
- Confirmation/resume fields from the old fake booking flow are not accepted by the new contract.
- Order before inference: JWT → origin/input shape → burst/daily quota → session ownership/lease → input guardrail → memory/snapshot load → Router/specialist graph.

Synchronous pre-stream failures:

| Status | Code                           | Meaning                                                                           |
| ------ | ------------------------------ | --------------------------------------------------------------------------------- |
| 400    | CHAT_REQUEST_INVALID           | Malformed body or unsupported old confirmation field                              |
| 401    | UNAUTHORIZED                   | Missing/invalid/expired JWT, required claim absent, revoked JTI, or inactive user |
| 403    | ORIGIN_NOT_ALLOWED             | Browser origin rejected                                                           |
| 404    | CHAT_SESSION_NOT_FOUND         | Owned session lookup fails; does not reveal foreign existence                     |
| 409    | CHAT_SESSION_BUSY              | Session queue/lease timeout or depth exceeded                                     |
| 429    | CHAT_BURST_LIMIT_EXCEEDED      | Burst limit reached                                                               |
| 429    | CHAT_DAILY_QUOTA_EXCEEDED      | Daily budget exhausted before inference                                           |
| 503    | CHAT_CONTROL_PLANE_UNAVAILABLE | Redis required for quota/lock/snapshot unavailable                                |

### Named SSE events retained

- `token`
- `tool_call`
- `tool_result`
- `flight_results`
- `ACTION_REQUIRED`
- `done`
- `error`

`confirmation_required` is retired with the fake booking tool. During flag rollback, old servers may still emit it; new clients ignore unknown legacy events safely.

### `ACTION_HANDOFF` event

Wire form:

```text
event: ACTION_HANDOFF
data: {"version":1,"action":"begin_checkout","handoffToken":"chk_handoff_v1_...","expiresAt":"2026-08-05T12:15:00.000Z","display":{"airline":"VN","origin":"SGN","destination":"NRT","departureAt":"2026-09-20T02:00:00.000Z","arrivalAt":"2026-09-20T08:30:00.000Z","price":"420.00","currency":"USD"}}
```

Strict JSON schema semantics:

```json
{
  "version": 1,
  "action": "begin_checkout",
  "handoffToken": "chk_handoff_v1_<opaque>",
  "expiresAt": "ISO-8601 UTC",
  "display": {
    "airline": "string",
    "origin": "IATA",
    "destination": "IATA",
    "departureAt": "ISO-8601",
    "arrivalAt": "ISO-8601",
    "price": "decimal string",
    "currency": "ISO-4217"
  }
}
```

Forbidden anywhere in payload: `url`, `href`, `target`, `offerId`, `flightOfferId`, `duffelOfferId`, `sessionId`, `userId`, raw provider payload, passenger/contact/passport/payment data, arbitrary metadata.

Client behavior:

1. Parse with an exact Zod schema.
2. Reject unknown version/action/extra keys or expired token.
3. Render `CheckoutHandoffCard` from display metadata.
4. On click, POST `{handoffToken}` with CSRF/origin protection to the same-origin `/checkout/handoff` bootstrap route.
5. The bootstrap route validates the strict token shape, sets a short-lived `HttpOnly; Secure; SameSite=Strict` cookie, and returns a 303 redirect to clean `/checkout/passengers`.
6. Never store the token in localStorage/sessionStorage, readable cookies, analytics, logs, URLs, referrers, or return URLs; bootstrap request bodies are explicitly redacted from access/APM logging.

### Event ordering

For a successful checkout turn:

```text
tool_call(signal_checkout_intent)
tool_result(signal_checkout_intent; safe summary only)
ACTION_HANDOFF
done
```

No LLM token is required after deterministic token creation. If safe explanatory text is generated before the signal, it passes through output guardrails. A token created before client disconnect is recoverable through deterministic idempotent retry.

## Trusted Agent Gateway Contracts

All endpoints use service API key plus user claim and propagate trace/correlation identifiers.

### POST `/api/agent-gateway/v2/flights/search` (opt-in attested search)

The legacy `GET /api/agent-gateway/flights/search` remains display-only and unchanged throughout rollback; it never returns local/provider IDs or attestations. The new graph opts into this service-only POST after its stripping consumer is deployed.

Request combines the existing validated search criteria with:

```json
{
  "chatSessionId": "owned-session-uuid",
  "proposedSnapshotVersion": 3,
  "search": {
    "origin": "SGN",
    "destination": "NRT",
    "departureDate": "2026-09-20",
    "adults": 1
  }
}
```

NestJS verifies the claimed user owns an active session and that the proposed version is a bounded positive integer; the agent separately enforces monotonic `current + 1` against its owner/session Redis snapshot before accepting the response. The trusted response to the new Python consumer is:

```json
{
  "selectionAttestation": "sel_v1_signed-opaque",
  "snapshotVersion": 3,
  "snapshotExpiresAt": "2026-08-05T12:15:00.000Z",
  "results": [
    {
      "flightOfferId": "local-uuid",
      "duffelOfferId": "provider-id",
      "offerExpiresAt": "2026-08-05T12:15:00.000Z",
      "airline": "VN",
      "flightNumber": "VN300",
      "departureAirport": "SGN",
      "arrivalAirport": "NRT",
      "departureTime": "2026-09-20T02:00:00.000Z",
      "arrivalTime": "2026-09-20T08:30:00.000Z",
      "duration": 330,
      "stops": 0,
      "price": "420.00",
      "currency": "USD",
      "fareClass": "economy",
      "baggageAllowance": "1 checked bag"
    }
  ]
}
```

The full response is trusted service-to-service data, not the LLM/browser contract. The HMAC-signed selection attestation binds claimed user, owned ChatSession, ordered local/provider offer identifiers, snapshot version, and expiry. Python stores it only in the Redis snapshot and strips it before ToolMessage/SSE emission. The gateway returns only persisted exact-matched FlightOffer rows. Deployment order is consumer/parser first, versioned POST second, feature enable last; the legacy GET shape never gains sensitive fields.

### GET `/api/agent-gateway/users/bookings/summaries`

Response:

```json
{
  "bookings": [
    {
      "bookingReference": "bkref_opaque-uuid",
      "airline": "VN",
      "origin": "SGN",
      "destination": "NRT",
      "departureTime": "2026-09-20T02:00:00.000Z",
      "arrivalTime": "2026-09-20T08:30:00.000Z",
      "status": "CONFIRMED",
      "durationMinutes": 330,
      "stops": 0
    }
  ]
}
```

### GET `/api/agent-gateway/users/bookings/:bookingReference`

The reference must match the strict `bkref_` format and belong to the claimed user.

Response:

```json
{
  "bookingReference": "bkref_opaque-uuid",
  "airline": "VN",
  "origin": "SGN",
  "destination": "NRT",
  "departureTime": "2026-09-20T02:00:00.000Z",
  "arrivalTime": "2026-09-20T08:30:00.000Z",
  "status": "CONFIRMED",
  "durationMinutes": 330,
  "stops": 0,
  "flightNumber": "VN300",
  "baggageAllowance": "1 checked bag",
  "changeable": true,
  "refundable": false
}
```

404 uses `BOOKING_REFERENCE_NOT_FOUND` for missing, foreign, or stale references.

Both booking endpoints query only `BookingAgentProjection`. Tests fail if gateway code loads Booking `flightSnapshot`, `passengerSnapshot`, PNR, payment, or provider payload columns.

### POST `/api/agent-gateway/handoffs`

Deterministic-node-only endpoint; it must not appear in any tool registry or LLM prompt.

Request:

```json
{
  "selectionAttestation": "sel_v1_signed-opaque",
  "selectedOfferIndex": 2,
  "snapshotFingerprint": "opaque-fingerprint"
}
```

Validation:

- Verify the attestation signature, expiry, claimed user, owned active ChatSession, snapshot version, and ordered offer set.
- Resolve the selected index from the attested ordered set; local FlightOffer exists and its Duffel ID matches exactly.
- Stored offer is within configured freshness.
- The deterministic agent has already resolved the index from its owner/session-scoped Redis snapshot; NestJS independently verifies the attestation and derives the idempotency hash from attestation digest plus selected index. Caller-supplied IDs and idempotency keys are rejected.
- `FEATURE_FLAG_CHAT_HANDOFF_ISSUE` is enabled at both agent node and NestJS endpoint. `ACCEPT` alone is insufficient for creation.
- No Duffel, readiness, intent, payment, or booking call occurs.

201 new / 200 idempotent active response:

```json
{
  "handoffToken": "chk_handoff_v1_opaque",
  "expiresAt": "2026-08-05T12:15:00.000Z",
  "display": {
    "airline": "VN",
    "origin": "SGN",
    "destination": "NRT",
    "departureAt": "2026-09-20T02:00:00.000Z",
    "arrivalAt": "2026-09-20T08:30:00.000Z",
    "price": "420.00",
    "currency": "USD"
  }
}
```

Errors:

| Status  | Code                                             |
| ------- | ------------------------------------------------ |
| 400     | HANDOFF_REQUEST_INVALID                          |
| 401/403 | Existing service-auth errors                     |
| 404     | CHAT_SESSION_NOT_FOUND or FLIGHT_OFFER_NOT_FOUND |
| 409     | HANDOFF_SNAPSHOT_MISMATCH                        |
| 409     | HANDOFF_ATTESTATION_INVALID                      |
| 410     | HANDOFF_OFFER_STALE                              |
| 503     | CHAT_HANDOFF_ISSUANCE_DISABLED                   |

## User Checkout Handoff Contracts

### POST `/checkout/handoff` (same-origin web bootstrap)

Browser request body contains only `handoffToken`. The route requires an authenticated checkout session plus accepted Origin/CSRF token, forwards the credential only through a redacted server-to-server POST, sets a short-lived `HttpOnly; Secure; SameSite=Strict` handoff cookie, and redirects to `/checkout/passengers`. It never writes the token to a URL or readable storage.

### POST `/api/bookings/handoffs/resolve`

User JWT protected.

Request:

```json
{
  "handoffToken": "chk_handoff_v1_opaque"
}
```

200 response:

```json
{
  "status": "ACTIVE",
  "expiresAt": "2026-08-05T12:15:00.000Z",
  "offer": {
    "airline": "VN",
    "origin": "SGN",
    "destination": "NRT",
    "departureAt": "2026-09-20T02:00:00.000Z",
    "arrivalAt": "2026-09-20T08:30:00.000Z",
    "price": "420.00",
    "currency": "USD",
    "adults": 1,
    "children": 0,
    "infants": 0
  }
}
```

The local/Duffel offer IDs and session ID are never returned. NestJS finds by token hash plus authenticated user, then validates the stored ChatSession relation and ownership internally. Client-supplied `chatSessionId` is rejected as an extra property. Response is no-store. Resolve is repeatable while ACTIVE and does not mutate consumed state; CLAIMED returns a stable in-progress response.

Errors:

| Status | Code                     | Side effects                     |
| ------ | ------------------------ | -------------------------------- |
| 400    | HANDOFF_TOKEN_INVALID    | none                             |
| 404    | HANDOFF_NOT_FOUND        | none; used for foreign owner too |
| 409    | HANDOFF_IN_PROGRESS      | none                             |
| 409    | HANDOFF_ALREADY_CONSUMED | none                             |
| 410    | HANDOFF_EXPIRED          | none                             |
| 410    | HANDOFF_OFFER_STALE      | none; client offers fresh search |
| 503    | CHAT_HANDOFF_DISABLED    | none                             |

### POST `/api/bookings/intents/readiness` additive source

Existing request remains supported. Chat checkout may use:

```json
{
  "handoffToken": "chk_handoff_v1_opaque",
  "passengers": [
    {
      "offerPassengerId": "server-projected-passenger-id",
      "passengerType": "ADULT",
      "source": {
        "type": "traveler_profile",
        "travelerProfileId": "owned-profile-id"
      }
    }
  ]
}
```

Rules:

- `handoffToken` and `flightOfferId` are mutually exclusive.
- Handoff resolution derives the stored owned ChatSession and FlightOffer internally and remains read-only/unconsumed.
- Existing metadata-only response and `ACTION_REQUIRED` behavior remain.

### POST `/api/bookings/intents` additive source and consume

Chat checkout request carries the same server-read `handoffToken` plus canonical passenger sources and expected profile revisions; `chatSessionId` is not accepted.

Claim/external-validation/finalization sequence:

1. In a short transaction, resolve ACTIVE ChatHandoff by hash plus authenticated owner, validate its stored active/non-deleted ChatSession, and CAS it to CLAIMED with an internal random claim-token hash, expiry, and later recovery boundary. Concurrent losers return before supplier access.
2. The claim owner runs a compare-and-refresh watchdog. Each supplier call uses a hard timeout such that supplier deadline plus finalization margin is strictly less than remaining claim TTL. Refresh loss cancels work; no takeover is allowed until the uncertainty buffer passes.
3. The claim winner runs authoritative readiness/source resolution and required Duffel validation outside a database transaction.
4. On validation failure, release only the matching unexpired claim; after process/refresh failure, wait for `claimRecoverAfter`. Never consume it.
5. In a final transaction, verify the in-memory claim token, unexpired claim lease, active/non-deleted stored ChatSession, user ownership, readiness revisions, and offer state; create BookingIntent/passenger snapshots and set consumed linkage while clearing claim fields.
6. Commit; only afterward may existing deterministic payment/booking execution continue.

If claim or final CAS updates zero rows, return `409 HANDOFF_IN_PROGRESS`, `409 HANDOFF_ALREADY_CONSUMED`, or `410 HANDOFF_EXPIRED` after safe re-read. Losing/replayed requests make zero Duffel/payment calls. Existing non-handoff and singular compatibility contracts remain.

## Feature Flag Ownership

- `CHAT_HANDOFF_ISSUE=false`: agent never invokes create; NestJS create independently rejects direct service-auth calls. No new credential is minted.
- `CHAT_HANDOFF_ACCEPT=false`: resolve/readiness/consume reject existing credentials according to rollback policy; create remains independently controlled by `ISSUE`.
- Production validation rejects `ISSUE=true` with `ACCEPT=false`.

## Error and Privacy Contract

All errors exposed to browser/LLM use stable code plus human-safe message. Raw exception text, URL, token, hash, offer ID, PNR, and PII are forbidden.

Required trace/audit metadata allowlist:

```text
operation
status
reasonCode
latencyMs
intent
confidenceBucket
snapshotVersion
selectedOfferIndex
counts
traceId
correlationId
```

Even allowlisted identifiers must be sanitized to bounded character sets. User/session/record identifiers stay in protected audit columns rather than free-form metadata.
