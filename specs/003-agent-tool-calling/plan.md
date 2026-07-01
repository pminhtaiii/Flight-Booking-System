# Implementation Plan: Agent Tool-Calling & Data Access

**Branch**: `003-agent-tool-calling` | **Date**: 2026-07-01 | **Spec**: [spec.md](file:///c:/Booking%20Systems/specs/003-agent-tool-calling/spec.md)

**Input**: Feature specification from `/specs/003-agent-tool-calling/spec.md`

## Summary

Build two interconnected components that transform the AI chatbot from a generic LLM wrapper into a domain-capable travel assistant:

1. **NestJS Agent Gateway Module** (`apps/api/src/agent-gateway/`) — a dedicated data access boundary in the NestJS backend that exposes PII-stripped, read-only data endpoints for the Python agent. Authenticates via service API key + HMAC-SHA256 signed claim tokens. Serves as the structural PII boundary and single audit chokepoint for all agent data access.

2. **LangGraph Tool-Calling State Machine** (`apps/agent/src/agent/graph/`) — replaces the bare `ChatOpenAI` streaming loop with a LangGraph state graph that can invoke tools (flight search, user preferences, booking status) through the agent gateway. Includes a dormant human-in-the-loop confirmation gate for future write operations.

Three read-only tools at launch: `search_flights`, `get_user_preferences`, `list_user_bookings`. All tools route through the gateway's PII stripping layer. Every tool call is audit-logged with userId, tool name, timestamp, and response size.

## Technical Context

**Language/Version**: TypeScript 5.x (NestJS backend) & Python 3.11+ (FastAPI agent)

**Primary Dependencies**:
- NestJS: `@nestjs/common`, `@nestjs/passport`, `Prisma Client`, `class-validator`, Node.js `crypto`
- Python: `langchain-core`, `langgraph`, `langchain-openai`, `httpx`, `hmac`/`hashlib` (stdlib), `pydantic`

**Storage**: PostgreSQL via Prisma ORM — schema additions required (TravelerProfile, Booking, BookingStatus)

**Testing**: Jest E2E (gateway endpoints), pytest + pytest-asyncio (tools, graph, claim tokens)

**Target Platform**: Linux server, single-instance deployment

**Project Type**: Web service monorepo (`apps/api` + `apps/agent` + `apps/web`)

**Performance Goals**: <10s end-to-end per tool-calling query (SC-001)

**Constraints**: 2,000 Amadeus API calls/month, single-instance, max 5 tool iterations/turn, top 5 flight results per search

**Scale/Scope**: Single-instance, 1–5 bookings per user, no pagination for booking queries

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Gate | Principle | Status | Notes |
|------|-----------|--------|-------|
| G1 | I. Flight-First Architecture | ✅ PASS | All 3 tools are read-only. No impact on booking pipeline. |
| G2 | II. Deterministic Transaction Boundary | ✅ PASS | Tools are advisory only. No write operations. Confirmation gate dormant. |
| G3 | III. API Budget Discipline | ⚠️ CONDITIONAL | Agent-initiated searches consume Amadeus quota. Mitigated: see below. |
| G4 | IV. Observability & Operational Visibility | ✅ PASS | Audit logging for every tool call (FR-014). LangSmith tracing. Structured logs. |
| G5 | V. Incremental Delivery | ✅ PASS | Shippable increment. Each tool independently testable and deployable. |

**G3 Conditional Pass Justification**: Agent-initiated flight searches go through the same `CacheService` (Redis) and rate limiting infrastructure as direct frontend searches. The gateway's `/flights/search` endpoint checks Redis cache first, respects rate limits, and increments the API budget counter — identical treatment to the deterministic search path. This enforces Principle III rather than violating it.

## Project Structure

### Documentation (this feature)

```text
specs/003-agent-tool-calling/
├── plan.md              # This file
├── research.md          # Phase 0 — resolved unknowns and design decisions
├── data-model.md        # Phase 1 — entity definitions and relationships
├── quickstart.md        # Phase 1 — validation guide
├── contracts/           # Phase 1 — interface contracts
│   ├── agent-gateway-api.md   # Gateway REST API endpoints
│   ├── tool-schemas.md        # LangChain tool function schemas
│   ├── sse-protocol.md        # Extended SSE event types
│   └── auth-protocol.md       # Claim token + API key auth protocol
└── tasks.md             # Phase 2 output (via /speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
apps/api/
├── prisma/
│   └── schema.prisma                    # MODIFY — add TravelerProfile, Booking, BookingStatus
├── src/
│   ├── app.module.ts                    # MODIFY — register AgentGatewayModule
│   └── agent-gateway/                   # NEW MODULE
│       ├── agent-gateway.module.ts
│       ├── agent-gateway.controller.ts  # 3 gateway endpoints
│       ├── agent-gateway.service.ts     # Data access orchestration + PII stripping
│       ├── amadeus/
│       │   ├── amadeus.service.ts       # Amadeus Flight Offers Search client
│       │   └── amadeus.types.ts         # Amadeus API response/request types
│       ├── auth/
│       │   ├── agent-api-key.guard.ts   # X-Agent-API-Key header validation
│       │   ├── claim-token.guard.ts     # X-User-Claim header validation + TTL
│       │   ├── claim-token.service.ts   # HMAC-SHA256 verify + user active status check
│       │   └── claim-token.types.ts     # ClaimPayload interface
│       └── dto/
│           ├── flight-search-query.dto.ts
│           ├── flight-result.dto.ts
│           ├── user-preferences.dto.ts
│           └── user-bookings.dto.ts
└── test/
    └── agent-gateway.e2e-spec.ts        # NEW — gateway E2E tests

apps/agent/
├── src/agent/
│   ├── config.py                        # MODIFY — add 4 new env vars
│   ├── agents/
│   │   └── chat_agent.py                # MODIFY — LangGraph integration, tool binding
│   ├── auth/                            # NEW — claim token minting
│   │   ├── __init__.py
│   │   └── claim_token.py
│   ├── graph/                           # NEW — LangGraph state machine
│   │   ├── __init__.py
│   │   ├── state.py                     # AgentState TypedDict
│   │   ├── graph.py                     # StateGraph builder (agent → router → tool/confirm)
│   │   ├── nodes.py                     # Node functions
│   │   └── router.py                    # Read/write tool routing + iteration cap
│   ├── sanitization/                    # NEW — PII scrubbing for storage
│   │   ├── __init__.py
│   │   └── pii_scrubber.py
│   ├── streaming/
│   │   └── sse.py                       # MODIFY — LangGraph producer, new SSE events
│   └── tools/                           # EXTEND
│       ├── __init__.py
│       ├── nestjs_client.py             # MODIFY — shared httpx client, gateway methods
│       ├── base.py                      # NEW — base gateway tool with auth headers
│       ├── search_flights.py            # NEW — search_flights tool
│       ├── get_preferences.py           # NEW — get_user_preferences tool
│       ├── list_bookings.py             # NEW — list_user_bookings tool
│       └── registry.py                  # NEW — tool registry with confirmation flags
└── tests/
    ├── conftest.py                      # MODIFY — add gateway mock fixtures
    ├── test_claim_token.py              # NEW
    ├── test_tools.py                    # NEW
    ├── test_graph.py                    # NEW
    └── test_pii_scrubber.py             # NEW
```

**Structure Decision**: Follows existing monorepo convention. The Agent Gateway is a new NestJS module within `apps/api/src/`. Python changes extend the existing `apps/agent/` service. No new top-level packages or workspace entries needed.

## Complexity Tracking

| Aspect | Why Needed | Simpler Alternative Rejected Because |
|--------|-----------|-------------------------------------|
| HMAC claim tokens instead of forwarding JWT | Principle II — user JWT must not cross the FastAPI boundary. Claim token contains only `userId` + `issuedAt`. | Forwarding user JWT leaks the full session to the gateway and couples agent auth to user auth lifecycle. |
| LangGraph state machine instead of simple tool loop | Confirmation gate for future write ops requires graph suspension (`interrupt_before`). LangGraph provides this natively. | A manual while-loop cannot suspend and resume mid-execution for human-in-the-loop confirmation. |
| Prisma schema additions (TravelerProfile, Booking) | Gateway needs real data to serve. These models are foundational for the entire system. | Mock/hardcoded data makes tools useless for real validation and defers essential schema work. |
| Integrated gateway services (not proxy-to-standalone) | No standalone flight/booking/profile NestJS services exist yet. Building them is out of scope for this feature. | Building 3 full standalone NestJS modules doubles scope without agent-specific value. |

---

## Phase Breakdown

This feature is organized into **6 progressive phases**, each independently testable and deployable. Each phase builds on the data models and service foundation established in previous phases.

### Phase 1: Database Schema & Mock Seed Data (Data Layer)

**Covers**: FR-015, FR-003, FR-004, SC-002, SC-009

**Scope**:
- Modify `apps/api/prisma/schema.prisma` to add:
  - `TravelerProfile` model (with name, nationality, passport details, preferences, saved payment cards)
  - `Booking` model and `BookingStatus` enum
- Run Prisma migrations to update the PostgreSQL database.
- Create a mock data seeding script to populate users with traveler profiles, saved preferences, and mock bookings to facilitate gateway testing.
- Verify schema structure via Prisma Studio or database query checks.

**Output**: Relational schema established and populated with mock traveler and booking data, ready for API queries.

---

### Phase 2: Agent Gateway REST Endpoints & Authentication (Gateway Foundation)

**Covers**: FR-006, FR-007, FR-008, FR-015, SC-005

**Scope**:
- Create NestJS `AgentGatewayModule` under `apps/api/src/agent-gateway/`.
- Implement `agent-api-key.guard.ts` (validate `X-Agent-API-Key` header) and `claim-token.guard.ts`/`claim-token.service.ts` (validate HMAC-SHA256 signature in `X-User-Claim` header).
- Build the 3 gateway controller endpoints:
  - `GET /agent-gateway/flights/search`
  - `GET /agent-gateway/users/preferences`
  - `GET /agent-gateway/users/bookings`
- Ensure all endpoints verify that the user claim token is valid, unexpired, and belongs to an active user.
- Write NestJS Jest E2E tests validating signature authorization, key-matching, and unauthorized endpoint rejections.

**Output**: Secure gateway REST API that validates claim tokens and service keys before routing data requests.

---

### Phase 3: PII Stripping, Caching & Auditing (Gateway Polish)

**Covers**: FR-005, FR-014, SC-002, SC-006, SC-009

**Scope**:
- Implement PII stripping in `AgentGatewayService` (guarantee no passport numbers, raw payment card details, PNR codes, or e-ticket numbers are returned in gateway responses).
- Integrate the flight search endpoint with the Amadeus client wrapper, Redis `CacheService`, and rate limiting.
- Implement structured auditing in `AgentGatewayService` using the existing NestJS `AuditService` to log user, tool name, timestamp, and response size.
- Write E2E tests verifying PII is completely stripped from responses and audit logs are correctly written.

**Output**: Fully compliant gateway that logs tool calls, caches Amadeus results, and strips sensitive PII before responses leave the NestJS boundary.

---

### Phase 4: Python Client, Auth Headers & PII Scrubber (Agent Foundation)

**Covers**: FR-019, FR-020, SC-010

**Scope**:
- Implement HMAC-SHA256 claim token generation in Python under `apps/agent/src/agent/auth/claim_token.py`.
- Extend `nestjs_client.py` in `apps/agent/src/agent/tools/` to dynamically attach API keys and signed user claim tokens to outgoing requests.
- Implement `pii_scrubber.py` under `apps/agent/src/agent/sanitization/` to scrub regex-matched PII (passports, credit cards, PNRs) from chat messages before they are persisted or logged.
- Write pytest unit tests for token generation, API request headers, and regex PII scrubbing.

**Output**: Python agent foundation capable of making authenticated gateway requests and scrubbing PII from messages before persistence.

---

### Phase 5: LangGraph State Machine & Read-Only Tools (Agent Core)

**Covers**: FR-001, FR-002, FR-003, FR-004, FR-009, FR-010, FR-012, FR-018, SC-001, SC-003, SC-004, SC-007

**Scope**:
- Implement LangGraph orchestration under `apps/agent/src/agent/graph/`:
  - `state.py` (TypedDict state object)
  - `nodes.py` (node executors for LLM, tools, and confirmation)
  - `router.py` (conditional router for tool choices and iteration caps)
  - `graph.py` (compiled state graph replacing simple LLM chat loop)
- Define base tool class and implement tools:
  - `search_flights` (caps results at top 5)
  - `get_user_preferences`
  - `list_user_bookings`
- Write pytest integration tests verifying the compiled graph, tool calling, iteration capping, and fallback behavior for unavailable data.

**Output**: LangGraph-driven agent service capable of calling tools to answer user questions about flights, preferences, and bookings.

---

### Phase 6: Human-in-the-Loop Gate & SSE Streaming Status (Agent Polish & Integration)

**Covers**: FR-011, FR-013, FR-016, SC-008

**Scope**:
- Implement graph suspension using LangGraph interrupts (`interrupt_before`) for tools requiring confirmation (ready/dormant for future write operations).
- Extend the SSE streaming generator in `apps/agent/src/agent/streaming/sse.py` to yield `tool_call` status events (e.g. "Searching flights...") and tool results.
- Write integration tests verifying SSE streams, graph suspension/resume/abort on mock write tools, and correct error-handling on gateway timeouts.

**Output**: Fully responsive, streaming agent with interactive confirmation gates for transactional safety.
