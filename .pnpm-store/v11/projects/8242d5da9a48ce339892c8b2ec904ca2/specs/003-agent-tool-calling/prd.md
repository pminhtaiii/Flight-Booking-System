# PRD: Agent Tool-Calling Service & NestJS Agent Gateway

> **Date**: 2026-07-01
> **Phase**: Next (after Chatbot Agent Service Phase 7)
> **Depends on**: Chatbot Agent Service (Phases 1–7), existing NestJS services (auth, chat)

---

## Problem Statement

The AI chatbot agent service is fully built (JWT auth, guardrails, SSE streaming, LangChain completion, memory management, concurrency queue) but the agent is a pure conversationalist — it cannot access any backend data. Users cannot ask "search flights to Tokyo next week" or "when is my next flight?" because the agent has no tools to call. Without tool-calling capability, the chatbot is a generic LLM wrapper with no domain value.

Additionally, there is no structural boundary preventing PII (passport numbers, payment details, e-ticket numbers) from entering the LLM context window. The architecture document states "all agent data access goes through the agent-gateway, which strips PII and enforces scoped access" — but this gateway does not exist yet.

---

## Solution

Build two interconnected components:

1. **NestJS Agent Gateway Module** (`src/agent-gateway/`) — a dedicated API surface in the NestJS backend that exposes PII-stripped, read-only data endpoints for the Python agent. This is the structural PII boundary.

2. **LangGraph Tool-Calling Agent** — replace the bare `ChatOpenAI` completion in the Python agent with a LangGraph state machine that can invoke tools (search flights, get user preferences, list bookings) through the agent gateway, with a built-in human-in-the-loop confirmation gate for future write operations.

The agent authenticates to the gateway using a service-to-service API key and cryptographically signed user claim tokens — no user JWTs are forwarded past the FastAPI edge.

---

## User Stories

1. As a traveler, I want to ask the chatbot "find me flights from Hanoi to Tokyo next Friday" so that I can search without navigating the search UI.
2. As a traveler, I want the chatbot to know my seat and airline preferences so that it can personalize its recommendations without me repeating them.
3. As a traveler, I want to ask "when is my next flight?" so that I can get booking information conversationally.
4. As a traveler, I want the chatbot to tell me it doesn't know something rather than inventing flight details, so that I can trust its answers.
5. As a traveler, I want the chatbot to answer follow-up questions about search results from context rather than searching again, so that conversations feel fast and don't waste API calls.
6. As a traveler, I want my passport number, payment details, and PNR to never appear in chatbot responses, so that my sensitive data is protected.
7. As a traveler, I want a smooth SSE streaming experience where tool calls happen mid-stream and results appear naturally in the conversation, so that the interaction feels seamless.
8. As a traveler, I want the chatbot to ask for my confirmation before performing any action that affects my bookings or money, so that I stay in control.
9. As a system operator, I want every tool call logged in LangSmith with the userId and tool name, so that I can audit what data the agent accessed.
10. As a system operator, I want the agent gateway to be the only path the agent uses to access backend data, so that I have a single chokepoint to audit and restrict.
11. As a system operator, I want the claim token TTL to be configurable per deployment, so that I can tune the security/usability tradeoff without code changes.
12. As a system operator, I want the agent gateway to independently verify user active status, so that banned or deleted users cannot be queried by the agent.
13. As a developer, I want new tools to be addable by defining a tool schema, a gateway endpoint, and a `requires_confirmation` flag, so that the system scales without architectural changes.
14. As a developer, I want the LangGraph graph to be testable at each node in isolation, so that I can verify routing, tool execution, and confirmation logic independently.

---

## Implementation Decisions

### Agent Gateway (NestJS Side)

- New NestJS module at `src/agent-gateway/` with its own controller, service, and DTOs.
- Authentication via a shared `AGENT_SERVICE_API_KEY` header — not the user's JWT.
- User identity verified via HMAC-SHA256 signed claim tokens. The gateway validates the signature and checks the timestamp against a configurable TTL (`CLAIM_TOKEN_TTL_SECONDS`). The claim payload contains only `userId` and `issuedAt` — no active status or profile data.
- The gateway checks `user.active` status against the database independently — this is not embedded in the claim token.
- Three gateway endpoints at launch:
  - `GET /agent-gateway/flights/search` — proxies to flight search service, returns PII-stripped results (airline, flight number, times, duration, stops, price, fare class, baggage).
  - `GET /agent-gateway/users/preferences` — returns traveler preferences only (seat pref, airline pref, class pref, dietary needs). No passport, no payment methods, no personal identifiers.
  - `GET /agent-gateway/users/bookings` — returns booking list with flight details and status. No PNR, no e-ticket numbers, no payment references.
- All gateway requests are audit-logged with userId, tool name, timestamp, and response size.

### Claim Token Minting (Python Agent Side)

- When FastAPI middleware validates the user's JWT, it extracts `userId` and mints a claim token signed with `CLAIM_TOKEN_SECRET` (shared between agent and gateway).
- The token is HMAC-SHA256 signed, containing `userId` and `issuedAt` as a JSON payload.
- The token is attached to every gateway request as a header (e.g., `X-User-Claim`).
- The `CLAIM_TOKEN_TTL_SECONDS` environment variable controls the maximum age. Not hardcoded.

### LangGraph State Machine (Python Agent Side)

- Replace the bare `ChatOpenAI` streaming loop in `sse.py` with a LangGraph graph.
- Graph nodes: `agent_node` (LLM with bound tools), `tool_node` (executes read-only tools), `confirm_node` (suspends for user confirmation on write tools).
- Router logic: each tool has a `requires_confirmation` metadata flag. Read tools (`False`) route directly to `tool_node`. Write tools (`True`) route to `confirm_node` which sends an SSE `confirmation_required` event and suspends the graph via `interrupt_before`.
- All three launch tools are read-only (`requires_confirmation: False`). The confirmation path is architecturally ready but dormant.
- `max_iterations` cap (configurable, default 5) prevents runaway tool-calling loops.
- Checkpointing enabled for graph state persistence (in-memory for development, persistent backend for production).

### Tool Definitions

- Three LangChain tools defined with OpenAI-compatible function schemas:
  - `search_flights(origin, destination, date, passengers)` → calls gateway search endpoint.
  - `get_user_preferences()` → calls gateway preferences endpoint (no parameters — scoped to authenticated user).
  - `list_user_bookings()` → calls gateway bookings endpoint (no parameters — scoped to authenticated user).
- Each tool wraps an httpx call to the corresponding agent gateway endpoint.
- Tool responses are formatted as structured text for the LLM context (not raw JSON dumps).

### Closed-World System Prompt

- The agent's system prompt enumerates exactly what fields each tool returns.
- Instruction: if data is already in conversation context, answer from context — no redundant tool calls.
- Instruction: if the user asks about data not in the enumerated field list, say plainly that the detail is unavailable. No guessing.

### SSE Event Protocol Extension

- New SSE event type: `tool_call` — emitted when the agent invokes a tool, includes tool name and sanitized parameters (for UI feedback like "Searching flights...").
- New SSE event type: `tool_result` — emitted when a tool returns, includes a brief summary (for UI feedback like "Found 12 flights").
- New SSE event type: `confirmation_required` — emitted when a write tool needs user approval, includes proposed action details.
- Existing events (`token`, `done`, `error`) remain unchanged.

---

## Testing Decisions

### Testing Seam

The primary testing seam is the **agent gateway boundary**. This is where we verify:
- PII stripping: gateway responses never contain passport, payment, PNR, or e-ticket data.
- Scope enforcement: the gateway only serves read-only data for the authenticated user.
- Claim token validation: invalid/expired/tampered tokens are rejected.

This is the highest seam available — it's structural (a network boundary) and already exists as an architectural invariant.

### Gateway E2E Tests (NestJS — Jest)

- Prior art: existing tests in `apps/api/test/` (e.g., `health.e2e-spec.ts`).
- Test valid claim tokens return correct PII-stripped data.
- Test invalid/expired/tampered claim tokens return 401.
- Test that gateway responses never contain PII fields (passport, payment method, PNR, e-ticket).
- Test that gateway scopes all queries to the authenticated userId — no cross-user data leakage.

### Tool Integration Tests (Python — pytest)

- Prior art: existing tests in `apps/agent/tests/` (e.g., `test_streaming.py`).
- Test each tool invocation against a mocked gateway endpoint.
- Test the LangGraph state machine routing: read tools route to `tool_node`, write tools route to `confirm_node`.
- Test `max_iterations` cap prevents runaway loops.
- Test claim token minting produces valid HMAC-SHA256 signatures.
- Test the closed-world prompt: verify the agent does not hallucinate data outside its tool schema (requires LLM integration test).

### Claim Token Unit Tests

- Test minting produces correct HMAC-SHA256 signature.
- Test validation rejects tampered payloads.
- Test validation rejects expired tokens (beyond TTL).
- Test TTL is configurable via environment variable.

---

## Out of Scope

- **Write operations**: No booking, payment, or cancellation tools. The confirmation gate (`confirm_node`) is architecturally ready but no write tools are implemented in this phase.
- **Chat UI**: The frontend chat interface is a separate phase. Design decisions are already captured in the sketch-findings skill.
- **Flight status tracking**: Requires AviationStack integration which is not yet built.
- **Hotel and restaurant tools**: Backend services for these don't exist yet.
- **Horizontal scaling / multi-instance checkpointing**: Single-instance deployment for v1. LangGraph checkpointing uses in-memory storage.
- **Tool result caching**: No Redis caching of tool results in this phase. Each tool call hits the gateway fresh.

---

## Further Notes

- The `nestjs_client.py` currently creates a new `httpx.AsyncClient` per request. When adding tool calls (potentially multiple per turn), this should be refactored to use a shared client with connection pooling.
- The existing `sse.py` streaming handler (~220 lines) will need significant restructuring to integrate the LangGraph graph in place of the bare `model.astream()` loop. The producer function should delegate to the graph runner.
- Environment variables to add: `AGENT_SERVICE_API_KEY`, `CLAIM_TOKEN_SECRET`, `CLAIM_TOKEN_TTL_SECONDS`, `AGENT_MAX_ITERATIONS`.
- The grilling session decisions are recorded in full at `research/agent-tool-calling-architecture.md`.
