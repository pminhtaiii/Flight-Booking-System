# Implementation Plan - Phase 9D: Signed Flight Search Attestation & Snapshot Isolation

**Goal**: Implement the opt-in versioned search endpoint `POST /api/agent-gateway/v2/flights/search`, HMAC-SHA256 selection attestation generation and verification, Redis-backed `TrustedSearchSnapshot` isolation, and strict identifier-free LLM projections.

## User Review Required

- Legacy `GET /api/agent-gateway/flights/search` remains 100% unchanged and unenriched for rollback safety.
- Raw provider/Duffel offer IDs and signed attestations are stored strictly in Redis (`chat:snapshot:{userId}:{sessionId}`) with TTL bounded by offer freshness.
- LLM tool responses and browser SSE projections receive strictly 1-indexed identifier-free projections.

## Proposed Changes

### NestJS Backend (`apps/api`)

1. `apps/api/src/agent-gateway/selection-attestation.service.ts`:
   - Bind `userId`, `sessionId`, `version`, `issuedAt`, `expiresAt`, and ordered `offers` (`[{ flightOfferId, duffelOfferId }]`).
   - Format: `sel_v1_<base64url(payload)>.<hex_signature>`.
   - Provide constant-time HMAC verification (`crypto.timingSafeEqual`), expiration validation, and deterministic `UnauthorizedException` errors.

2. `apps/api/src/agent-gateway/selection-attestation.service.spec.ts`:
   - Unit tests for signing, verification, tampering, expiration, timing safety, and missing configuration.

3. `apps/api/src/agent-gateway/dto/attested-flight-search.dto.ts` & `apps/api/src/agent-gateway/dto/flight-search-query.dto.ts`:
   - Handle aliases (`proposedVersion`, `departureDate`, `passengers`, `cabinClass`).

4. `apps/api/src/agent-gateway/agent-gateway.controller.ts` & `apps/api/src/agent-gateway/agent-gateway.service.ts`:
   - Session ownership validation (404 on unowned or non-existent session).
   - Return trusted envelope with signed attestation and local/provider offer IDs.
   - Keep legacy GET endpoint display-only.

5. `apps/api/test/agent-gateway.e2e-spec.ts`:
   - E2E tests for `POST /v2/flights/search` and legacy `GET /flights/search`.

### Python Agent (`apps/agent`)

1. `apps/agent/src/agent/tools/nestjs_client.py`:
   - Add `search_flights_v2` alias / method.

2. `apps/agent/src/agent/tools/search_flights.py`:
   - Read existing snapshot to determine monotonic version.
   - Store full `TrustedSearchSnapshot` to Redis with TTL.
   - Format string for LLM with stripped identifiers.

3. `apps/agent/tests/test_search_snapshot.py`:
   - Test snapshot overwrite, monotonic version increment, TTL expiry, repository isolation, and negative assertions verifying no sensitive IDs appear in LLM text.

## Verification Commands

- `pnpm --filter @api/backend test -- src/agent-gateway/selection-attestation.service.spec.ts --runInBand`
- `pnpm --filter @api/backend test:e2e -- test/agent-gateway.e2e-spec.ts`
- `cd apps/agent && uv run pytest tests/test_search_snapshot.py -v`
