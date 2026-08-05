# Phase 0 Research: Agent Tool-Calling & Data Access

**Feature**: 003-agent-tool-calling | **Date**: 2026-07-01 | **Status**: Complete

**Input**: [spec.md](file:///c:/Booking%20Systems/specs/003-agent-tool-calling/spec.md), [prd.md](file:///c:/Booking%20Systems/specs/003-agent-tool-calling/prd.md), [plan.md](file:///c:/Booking%20Systems/specs/003-agent-tool-calling/plan.md), [grilling decisions](file:///c:/Booking%20Systems/research/agent-tool-calling-architecture.md)

**Purpose**: Resolve every technical unknown surfaced during implementation planning. Each finding below was a blocking question — now answered with a concrete decision, rationale, and rejected alternatives.

---

## Findings

### 1. Missing Backend Services — Gateway Contains Integrated Data Access

**Question**: The spec (Assumption #2) assumes NestJS has functional services for flight search, user profiles, and booking management. Do these services exist?

**Finding**: They do not. The NestJS backend (`apps/api/src/`) contains only: `auth`, `chat`, `audit`, `health`, `cache`, and `prisma` modules. There are no standalone `flights`, `bookings`, or `profiles` modules. The spec's assumption that the gateway "proxies to existing services" is incorrect — there is nothing to proxy to.

**Decision**: The Agent Gateway module (`apps/api/src/agent-gateway/`) contains integrated data access logic. It calls the Amadeus API directly for flight search (via an embedded `AmadeusService`), and queries Prisma directly for traveler preferences and bookings. The gateway IS the data access boundary — not a proxy layer.

**Rationale**: Building 3 standalone NestJS modules (FlightsModule, BookingsModule, ProfilesModule) with their own controllers, services, and DTOs would double the implementation scope of this feature without adding agent-specific value. Those modules serve the frontend — the agent only needs a PII-stripped, read-only view. The gateway's data access layer is intentionally thin (query + DTO projection) and can be extracted into standalone services in a future feature when the frontend needs them.

**Alternatives considered**:
- **(a) Build 3 full standalone NestJS services first, then proxy through gateway** — Rejected. Doubles scope. The frontend doesn't need these services yet (chat UI is a separate feature). Building them now creates unused code and defers the actual agent feature.
- **(b) Use mock/hardcoded data in the gateway** — Rejected. Makes tools useless for real validation. Users can't test "find flights to Tokyo" with fake data. Defers the Amadeus integration to an undefined future phase, which violates Principle V (incremental delivery of real value).

---

### 2. Missing Prisma Models — Add TravelerProfile and Booking

**Question**: Do the TravelerProfile and Booking database models exist for the gateway to query?

**Finding**: They do not. The current Prisma schema (`apps/api/prisma/schema.prisma`) defines only: `User`, `AuditLog`, `ChatSession`, `ChatMessage`. There are no models for traveler preferences, bookings, or booking status. The gateway's `get_user_preferences` and `list_user_bookings` tools have no data source.

**Decision**: Add `TravelerProfile` and `Booking` models (with a `BookingStatus` enum) to the Prisma schema as part of this feature. The `TravelerProfile` model stores travel preferences (seat, airline, class, dietary) plus PII fields (passport number, passport expiry) that the gateway DTOs structurally exclude. The `Booking` model stores booking details with PII fields (PNR code, e-ticket number, payment reference) similarly excluded from gateway responses.

**Rationale**: These are foundational models that every future feature (booking flow, user dashboard, admin panel) will reuse. The shared types package (`packages/shared/`) already exists for cross-app type sharing. Adding these models now is incremental schema work (~50 lines of Prisma) that unblocks real tool functionality. Deferring them means deferring the entire feature.

**Alternatives considered**:
- **(a) In-memory mock data in the gateway service** — Rejected. Not persisted across restarts. Can't be seeded for E2E tests via Prisma. Defers essential schema decisions.
- **(b) Add models in a separate, prerequisite feature** — Rejected. Creates a blocking dependency chain for no practical benefit. The models are simple and directly consumed by this feature's gateway.

---

### 3. Amadeus API Integration — Minimal AmadeusService in Gateway

**Question**: How does the gateway access real flight data? No Amadeus client exists in the codebase.

**Finding**: The NestJS backend has no Amadeus API client. Environment variables `AMADEUS_API_KEY` and `AMADEUS_API_SECRET` exist as placeholders in `.env.example` but are unused. The Amadeus Self-Service API uses OAuth2 Client Credentials flow for authentication, and the relevant endpoint is [Flight Offers Search v2](https://developers.amadeus.com/self-service/category/flights/api-doc/flight-offers-search/api-reference) (`GET /v2/shopping/flight-offers`).

**Decision**: Build a minimal `AmadeusService` within the agent-gateway module (`apps/api/src/agent-gateway/amadeus/amadeus.service.ts`). This service handles:
1. **OAuth2 token acquisition**: `POST /v1/security/oauth2/token` with client credentials → access token (~30min TTL).
2. **Token caching**: Store the access token in-memory with expiry tracking. Refresh proactively before expiry. The existing `CacheService` (Redis) is used for caching flight search results, not for the OAuth token itself (short-lived, single-instance).
3. **Flight search**: `GET /v2/shopping/flight-offers` with origin, destination, date, passengers → parse response → return top 5 results ranked by the API's default order.
4. **Test environment**: Use `https://test.api.amadeus.com` base URL for development and testing. Production URL: `https://api.amadeus.com`.

**Rationale**: A standalone, fully-featured Amadeus SDK integration is overkill for a single endpoint (flight search). The gateway only needs flight offers search — not pricing, booking, or ancillary APIs. An embedded service with ~100 lines of HTTP client code is the minimum viable integration.

**Alternatives considered**:
- **(a) Use `amadeus` npm SDK** — Rejected. The official Node.js SDK adds a dependency for a single API call. It also abstracts away the HTTP layer, making it harder to integrate with our existing `CacheService` for response caching and rate limiting.
- **(b) Build a standalone FlightsModule with full Amadeus SDK** — Rejected. Same as Finding 1 — doubles scope. The agent only needs search results.
- **(c) Defer Amadeus integration and use mock flight data** — Rejected. Same as Finding 1(b) — makes the flagship tool useless for real validation.

---

### 4. LangGraph Integration — StateGraph with 3 Nodes

**Question**: How should the LangGraph state machine be structured? The current `chat_agent.py` uses bare `model.astream()` with no graph or tool orchestration.

**Finding**: The current Python agent (`apps/agent/src/agent/agents/chat_agent.py`) creates a `ChatOpenAI` instance and calls `model.astream()` directly in the SSE producer function. There is no LangGraph dependency, no state graph, no tool binding. The streaming loop in `sse.py` iterates over raw model chunks and emits SSE events.

**Decision**: Replace the bare streaming loop with a LangGraph `StateGraph` with 3 nodes:

```
START → agent_node → should_continue (conditional edge)
  ├── tool calls (read-only)  → tool_node → agent_node  (loop)
  ├── tool calls (write)      → confirm_node → (suspend) → agent_node
  └── no tool calls (final)   → END
```

- **`agent_node`**: Invokes `ChatOpenAI` with bound tools. Uses `model.bind_tools(tools)` to attach function schemas. Returns `AIMessage` with optional `tool_calls`.
- **`tool_node`**: Uses `ToolNode` from `langgraph.prebuilt` to execute tool calls. Returns `ToolMessage` results back to the message list.
- **`confirm_node`**: For tools with `requires_confirmation: True`, emits a `confirmation_required` SSE event with the proposed action details, then suspends the graph via `interrupt_before`. Dormant for all 3 launch tools (all read-only).

**AgentState** (`TypedDict`):
```python
class AgentState(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]
    iteration_count: int
    pending_confirmation: Optional[dict]
```

**Streaming**: The SSE producer function calls `graph.astream_events(input, config, version="v2")` and maps LangGraph events to SSE event types:
- `on_chat_model_stream` → SSE `token` events
- `on_tool_start` → SSE `tool_call` events
- `on_tool_end` → SSE `tool_result` events

**Checkpointing**: `MemorySaver` for single-instance deployment (in-memory). Sufficient for the current single-instance constraint. Persistent checkpointing (PostgreSQL/Redis) deferred to horizontal scaling phase.

**Iteration cap**: `max_iterations` (default 5, configurable via `AGENT_MAX_ITERATIONS` env var). The `should_continue` conditional edge checks `state["iteration_count"]` and routes to END if exceeded, with the agent summarizing what it has so far.

**Rationale**: `AgentExecutor` (the simpler LangChain option) cannot suspend mid-loop for human-in-the-loop confirmation. LangGraph's `interrupt_before` mechanism is the only way to implement the confirmation gate without building a custom suspension system. Building with LangGraph now avoids a full rewrite when write tools are added in future phases.

**Alternatives considered**:
- **(a) `AgentExecutor` with a simple tool loop** — Rejected. No support for `interrupt_before` / graph suspension. Would require a full rewrite when write tools are added.
- **(b) Custom while-loop with manual state management** — Rejected. Reinvents LangGraph poorly. No checkpointing, no suspend/resume, no streaming event hooks.
- **(c) LangGraph with more granular nodes (separate node per tool)** — Rejected. Over-engineering. `ToolNode` from `langgraph.prebuilt` handles all tool execution generically. The router handles read/write classification.

---

### 5. Claim Token Implementation — HMAC-SHA256 via Python stdlib

**Question**: What crypto primitives are needed for claim token minting? Do we need a third-party JWT/token library?

**Finding**: Python's standard library provides everything needed: `hmac` (HMAC computation), `hashlib` (SHA-256), `json` (payload serialization), `base64` (URL-safe encoding). No third-party library is required.

**Decision**: Implement claim tokens using Python stdlib only. Token format:

```
{base64url(payload)}.{base64url(signature)}
```

Where:
- `payload` = JSON: `{"userId": "<uuid>", "iat": <unix_timestamp>}`
- `signature` = HMAC-SHA256(`base64url(payload)`, `CLAIM_TOKEN_SECRET`)

**Minting (Python agent side)**:
1. JWT middleware extracts `userId` from validated user JWT.
2. `mint_claim_token(user_id, secret)` → produces the token string.
3. Token attached as `X-User-Claim` header on every gateway request.

**Validation (NestJS gateway side)**:
1. Split token on `.` → `[encoded_payload, encoded_signature]`.
2. Recompute HMAC-SHA256 of `encoded_payload` with `CLAIM_TOKEN_SECRET`.
3. Constant-time compare recomputed signature with `encoded_signature`.
4. Decode payload → check `iat + CLAIM_TOKEN_TTL_SECONDS > now`.
5. Extract `userId` → verify user is active via Prisma query.

**Default TTL**: 300 seconds (5 minutes). Configurable via `CLAIM_TOKEN_TTL_SECONDS` environment variable. This accommodates typical multi-tool conversations (2–3 minutes) with margin.

**Rationale**: The claim token is intentionally NOT a JWT. It carries only `userId` and `iat` — no claims, no expiry field, no issuer. A full JWT library (PyJWT, jose) adds unnecessary dependency and complexity for a two-field payload. The HMAC-SHA256 signature provides tamper-proof integrity without the overhead of asymmetric cryptography.

**Alternatives considered**:
- **(a) Use PyJWT to mint standard JWTs** — Rejected. Adds a dependency for a two-field token. JWT headers, registered claims, and library configuration are unnecessary overhead.
- **(b) Forward the user's original JWT to the gateway** — Rejected (per grilling Decision 6). User JWTs expire during long conversations, causing mid-stream 401 errors.
- **(c) Unsigned userId header (trust-the-edge)** — Rejected. No cryptographic guarantee. An attacker who reaches the gateway directly could forge any userId.

---

### 6. PII Field Enumeration — Structural Exclusion via DTOs

**Question**: Which specific database fields constitute PII that must never appear in gateway responses, and how is exclusion enforced?

**Finding**: The following fields must NEVER appear in any agent gateway response:

| Model | PII Fields |
|-------|-----------|
| `TravelerProfile` | `passportNumber`, `passportExpiry` |
| `Booking` | `pnrCode`, `eTicketNumber`, `paymentReference` |
| `User` | `password` (hashed) |
| *(future)* | Any payment card fields (number, CVV, expiry, billing address) |

**Decision**: PII exclusion is **structural, not runtime**. Gateway response DTOs (`flight-result.dto.ts`, `user-preferences.dto.ts`, `user-bookings.dto.ts`) simply do not include PII fields. The Prisma `select` clause in the gateway service explicitly enumerates the fields to return — PII fields are never queried from the database in gateway operations.

Implementation chain:
1. **Prisma query**: `prisma.travelerProfile.findUnique({ select: { seatPreference: true, airlinePreference: true, ... } })` — PII fields not in `select`.
2. **DTO mapping**: Service maps Prisma result to a DTO class. DTO class has no PII properties.
3. **Controller response**: Returns DTO. NestJS serialization cannot leak fields that don't exist on the DTO.

This is a three-layer structural guarantee: the data is not queried, not mapped, and not serializable.

**Rationale**: Runtime filtering (e.g., a `stripPII()` function that deletes fields from a full response) is fragile — new PII fields added to the model could be missed by the filter. Structural exclusion means the gateway literally cannot return PII because it never has it. This is the strongest possible guarantee and aligns with the grilling session's "structural, not behavioral" principle (Decision 2).

**Alternatives considered**:
- **(a) Runtime PII stripping function** — Rejected. Requires maintaining a deny-list of field names. New fields are not stripped by default — fails open. One missed field is a data breach.
- **(b) Prisma middleware to redact PII globally** — Rejected. Over-broad. Frontend endpoints legitimately need some PII fields (e.g., user profile page showing masked passport). Gateway-specific exclusion is more precise.

---

### 7. PII Scrubbing for User Messages — Regex-Based Pre-Persistence Scrubber

**Question**: How should PII in user-typed messages (e.g., "my passport is A12345678") be detected and scrubbed before storage?

**Finding**: FR-019 requires PII scrubbing before persistence. FR-020 explicitly allows raw input to flow to the LLM for intent parsing. The scrubber sits between the LLM processing and the storage/logging layer.

**Decision**: Build a regex-based PII scrubber (`apps/agent/src/agent/sanitization/pii_scrubber.py`) that detects and replaces the following patterns in user message text before persistence:

| PII Type | Detection Method | Replacement |
|----------|-----------------|-------------|
| Passport numbers | Regex: 1–2 uppercase letters + 6–9 digits (e.g., `A12345678`, `AB1234567`) | `[PASSPORT REDACTED]` |
| Credit card numbers | Regex: 13–19 digit sequences (with optional spaces/dashes) + Luhn checksum validation | `[CARD REDACTED]` |
| Email addresses | Regex: standard email pattern | `[EMAIL REDACTED]` |
| Phone numbers | Regex: international format patterns (e.g., `+84 xxx`, `(xxx) xxx-xxxx`) | `[PHONE REDACTED]` |

**Application points**:
- Before persisting `ChatMessage` to database (conversation history)
- Before writing to any log or trace output
- NOT applied to the in-flight message sent to the LLM (per FR-020)

**Rationale**: Regex-based detection is sufficient for known PII formats. It's fast (~microseconds per message), deterministic, and doesn't require an ML model or external service. False positives (e.g., a flight number that looks like a passport number) are acceptable — over-redaction in storage is safer than under-redaction.

**Alternatives considered**:
- **(a) ML-based NER for PII detection (e.g., spaCy, Presidio)** — Rejected for MVP. Adds significant dependency weight, inference latency, and complexity. Regex covers the required PII types (FR-019) with sufficient accuracy. Can be upgraded later if false negative rates are unacceptable.
- **(b) No scrubbing — rely on prompt instructions to prevent PII in responses** — Rejected. This only prevents PII in *outputs*. User *inputs* containing PII would still be persisted verbatim, violating FR-019.
- **(c) Scrub before LLM processing** — Rejected. Violates FR-020. The LLM needs raw input for intent parsing (e.g., "book for passport A12345678" — the agent needs to understand the booking intent even if the passport number is redacted in storage).

---

### 8. SSE Protocol Extension — 3 New Event Types

**Question**: How should tool-calling events be communicated to the frontend via the existing SSE stream?

**Finding**: The current SSE protocol (`apps/agent/src/agent/streaming/sse.py`) emits 3 event types: `token` (streaming text chunks), `done` (stream complete), `error` (failure). There is no mechanism to signal tool invocation, tool completion, or confirmation requests.

**Decision**: Add 3 new SSE event types alongside the existing ones:

| Event Type | Payload | Emitted When |
|------------|---------|-------------|
| `tool_call` | `{"type": "tool_call", "tool": "<name>", "params": {<sanitized>}}` | Agent invokes a tool. Params are sanitized (no PII). |
| `tool_result` | `{"type": "tool_result", "tool": "<name>", "summary": "<brief>"}` | Tool returns successfully. Summary is human-readable (e.g., "Found 5 flights"). |
| `confirmation_required` | `{"type": "confirmation_required", "action": "<description>", "details": {<proposed>}}` | A write tool requires user approval before execution. |

**Event sequence for a tool-calling turn**:
```
← token: "Let me search for flights..."
← tool_call: {"tool": "search_flights", "params": {"origin": "HAN", "destination": "TYO", "date": "2026-07-15"}}
← tool_result: {"tool": "search_flights", "summary": "Found 5 flights from Hanoi to Tokyo"}
← token: "Here are the available flights..."
← token: "1. Vietnam Airlines VN..."
← done
```

**Implementation**: The SSE producer function maps LangGraph `astream_events` to SSE events:
- `on_tool_start` event → emit SSE `tool_call`
- `on_tool_end` event → emit SSE `tool_result`
- Confirmation gate suspension → emit SSE `confirmation_required`

Existing `token`, `done`, and `error` events remain unchanged. The frontend can safely ignore unknown event types (forward compatibility).

**Rationale**: Explicit tool-call events enable the frontend to show contextual loading states ("Searching flights…", "Checking your bookings…") instead of a generic spinner. The `confirmation_required` event is the client-side half of the human-in-the-loop gate — without it, the frontend has no way to render a confirmation dialog.

**Alternatives considered**:
- **(a) Embed tool status in `token` events as special text markers** — Rejected. Mixes data and control channels. The frontend would need to parse token text for markers, which is fragile and breaks if the LLM naturally generates similar text.
- **(b) Use a separate WebSocket channel for tool events** — Rejected. Adds protocol complexity. The SSE stream is already the real-time channel — multiplexing event types on it is simpler and maintains the single-connection model.

---

### 9. httpx Client Refactoring — Shared AsyncClient with Connection Pooling

**Question**: The current `nestjs_client.py` creates a new `httpx.AsyncClient` per request. With tool calls (potentially 2–3 per turn), this creates unnecessary connection overhead. How should this be refactored?

**Finding**: The current implementation (`apps/agent/src/agent/tools/nestjs_client.py`) instantiates `httpx.AsyncClient()` inside each request function as a context manager. Each invocation opens a new TCP connection, performs TLS handshake (if HTTPS), sends the request, and tears down the connection. For a single tool call per turn, this is acceptable. For multi-tool turns (e.g., `get_user_preferences` + `search_flights`), this wastes ~50–100ms per redundant connection setup.

**Decision**: Create a shared `httpx.AsyncClient` instance with connection pooling, initialized during FastAPI application lifespan:

```python
# In FastAPI lifespan
@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.http_client = httpx.AsyncClient(
        base_url=settings.NESTJS_API_URL,
        timeout=httpx.Timeout(10.0),
        limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
    )
    yield
    await app.state.http_client.aclose()
```

The shared client is injected into tool functions via FastAPI's dependency injection or passed through the LangGraph state config. All gateway calls reuse pooled connections.

**Rationale**: Connection pooling eliminates redundant TCP/TLS handshakes for consecutive tool calls within the same turn. The `lifespan` pattern ensures the client is properly initialized on startup and closed on shutdown — no leaked connections. The `max_connections=20` limit prevents connection exhaustion under concurrent user load.

**Alternatives considered**:
- **(a) Keep per-request clients** — Rejected. Acceptable for single-call turns, but multi-tool turns (the common case for this feature) pay unnecessary latency. The PRD explicitly flags this as a refactoring target.
- **(b) Module-level global client** — Rejected. Not properly lifecycle-managed. The client would not be closed on shutdown, potentially leaking connections. The FastAPI lifespan pattern is the idiomatic solution.

---

## Summary of Decisions

| # | Unknown | Decision | Impact |
|---|---------|----------|--------|
| 1 | Missing backend services | Gateway has integrated data access (Amadeus + Prisma direct) | No proxy layer needed |
| 2 | Missing Prisma models | Add TravelerProfile, Booking, BookingStatus to schema | ~50 lines Prisma, migration required |
| 3 | No Amadeus client | Minimal AmadeusService in gateway module | OAuth2 + single endpoint, ~100 lines |
| 4 | No LangGraph integration | StateGraph with 3 nodes + MemorySaver | Replaces bare model.astream() |
| 5 | Claim token crypto | Python stdlib hmac/hashlib, no PyJWT | Zero new dependencies |
| 6 | PII field list | Structural exclusion via Prisma select + DTOs | Three-layer guarantee |
| 7 | User message PII | Regex scrubber, pre-persistence only | 4 PII patterns, ~microsecond perf |
| 8 | SSE tool events | 3 new event types (tool_call, tool_result, confirmation_required) | Backward compatible |
| 9 | httpx connection reuse | Shared AsyncClient in FastAPI lifespan | Eliminates redundant TCP/TLS |

**Status**: All 9 unknowns resolved. No open questions remain. Ready for Phase 1 design contracts.
