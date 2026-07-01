# Quickstart: Agent Tool-Calling & Data Access — Validation Guide

**Feature**: 003-agent-tool-calling | **Phase**: 1 — Design & Contracts | **Spec**: [spec.md](file:///c:/Booking%20Systems/specs/003-agent-tool-calling/spec.md) | **Plan**: [plan.md](file:///c:/Booking%20Systems/specs/003-agent-tool-calling/plan.md)

> This document is a **validation/run guide** — it describes how to verify the feature works end-to-end. It does NOT contain implementation code, migration bodies, or full test suites. Refer to contract and data-model docs for schemas.

---

## Prerequisites

| Dependency     | Version   | Purpose                                |
|----------------|-----------|----------------------------------------|
| Node.js        | 18+       | NestJS API runtime                     |
| Python         | 3.11+     | FastAPI agent runtime                  |
| PostgreSQL     | 15+       | Primary data store (Prisma)            |
| Redis          | 7+        | Cache layer (flight search, rate limiting) |
| pnpm           | 8+        | NestJS monorepo package manager        |
| uv             | 0.2+      | Python agent dependency manager        |

Ensure both `apps/api` and `apps/agent` dependencies are installed before proceeding:

```bash
# NestJS workspace
cd apps/api && pnpm install

# Python agent
cd apps/agent && uv sync
```

---

## Environment Setup

Add these variables to the existing `.env` files. **Do not replace** existing variables — append only.

### `apps/api/.env`

```dotenv
# --- Feature 003: Agent Gateway Auth ---
AGENT_SERVICE_API_KEY=<shared-api-key-for-agent-to-gateway-auth>
CLAIM_TOKEN_SECRET=<shared-hmac-secret-for-claim-tokens>
CLAIM_TOKEN_TTL_SECONDS=300

# --- Feature 003: Amadeus Flight Search ---
AMADEUS_API_KEY=<amadeus-self-service-api-key>
AMADEUS_API_SECRET=<amadeus-self-service-api-secret>
AMADEUS_BASE_URL=https://test.api.amadeus.com
```

### `apps/agent/.env`

```dotenv
# --- Feature 003: Agent ↔ Gateway Connection ---
AGENT_GATEWAY_URL=http://localhost:3001/api/agent-gateway
AGENT_SERVICE_API_KEY=<must-match-the-api-value-above>
CLAIM_TOKEN_SECRET=<must-match-the-api-value-above>
CLAIM_TOKEN_TTL_SECONDS=300
AGENT_MAX_ITERATIONS=5
```

> [!IMPORTANT]
> `AGENT_SERVICE_API_KEY` and `CLAIM_TOKEN_SECRET` must be **identical** across both `.env` files. Mismatched values will cause 401 errors on every gateway request.

---

## Database Migration

### 1. Apply schema additions

The Prisma schema includes new `TravelerProfile` and `Booking` models (with `BookingStatus` enum). See [data-model.md](file:///c:/Booking%20Systems/specs/003-agent-tool-calling/data-model.md) for entity definitions.

```bash
cd apps/api
npx prisma migrate dev --name agent-tool-calling-models
```

### 2. Seed test data

Create a test user with the following data for validation scenarios:

- **User**: A registered, active user (existing auth system)
- **TravelerProfile**: Linked to the user, with preferences:
  - Seat preference: `window`
  - Preferred airline: `Vietnam Airlines`
  - Travel class: `business`
  - Dietary needs: `vegetarian`
- **Bookings**: 2–3 active booking records with:
  - Future departure dates
  - Destination, airline, flight number, status (`CONFIRMED`)
  - PII fields populated (passport, PNR, e-ticket) to verify stripping

> [!TIP]
> Use a Prisma seed script or manual SQL insert. The exact seed mechanism is implementation-dependent — what matters is that the data exists before running validation scenarios.

---

## Start Services

```bash
# Terminal 1 — NestJS API (port 3001)
cd apps/api && pnpm run start:dev

# Terminal 2 — Python Agent (port 3002)
cd apps/agent && uv run uvicorn src.agent.main:app --port 3002 --reload
```

Verify both services are healthy before proceeding:
- API: `GET http://localhost:3001/api/health`
- Agent: `GET http://localhost:3002/health`

---

## Validation Scenarios

Each scenario targets specific spec requirements. Cross-references use FR/SC codes from [spec.md](file:///c:/Booking%20Systems/specs/003-agent-tool-calling/spec.md).

### Scenario 1: Flight Search via Chat

**Covers**: FR-001, FR-002, FR-018, FR-011, SC-001, SC-009

**Steps**:
1. Send `POST` to agent `/chat/stream` with an authenticated user session.
2. Message body: `"find flights from HAN to NRT on 2026-08-01"`

**Verify**:
- [ ] SSE stream contains a `tool_call` event with tool name `search_flights`
- [ ] SSE stream contains a `tool_result` event after the tool completes
- [ ] SSE stream contains `token` events with the agent's natural-language flight summary
- [ ] Response includes **at most 5 flights**, each with: airline name, flight number, departure/arrival times, duration, stops, price, fare class, baggage allowance
- [ ] No PII (passport, payment, PNR, e-ticket) appears anywhere in the response
- [ ] End-to-end latency is under 10 seconds

---

### Scenario 2: User Preferences Retrieval

**Covers**: FR-003, FR-005, SC-002

**Steps**:
1. Ensure the test user has a `TravelerProfile` with preferences set (see seed data above).
2. Send: `"what are my travel preferences?"`

**Verify**:
- [ ] Response includes seat preference, travel class, preferred airline, and dietary needs
- [ ] No passport number, payment card, or billing details appear in the response
- [ ] The agent uses the `get_user_preferences` tool (visible in SSE `tool_call` event)

---

### Scenario 3: Booking Status Check

**Covers**: FR-004, FR-005, SC-002

**Steps**:
1. Ensure the test user has active `Booking` records with future dates.
2. Send: `"when is my next flight?"`

**Verify**:
- [ ] Response includes booking details: destination, dates, airline, flight info, booking status
- [ ] No PNR code, e-ticket number, or payment reference appears in the response
- [ ] The agent uses the `list_user_bookings` tool (visible in SSE `tool_call` event)

---

### Scenario 4: Follow-up Without Redundant Tool Call

**Covers**: FR-009, SC-004

**Steps**:
1. Complete Scenario 1 first (flight search results are in conversation context).
2. In the **same session**, send: `"which of those flights has the fewest stops?"`

**Verify**:
- [ ] Agent answers the question correctly using the flight data already in context
- [ ] **No new `tool_call` event** appears in the SSE stream — the agent answers from memory
- [ ] Response references specific flights from the earlier search results

---

### Scenario 5: PII Protection

**Covers**: FR-005, FR-019, FR-020, SC-002, SC-010

**Steps**:
1. Send: `"show me my full profile including passport"`

**Verify**:
- [ ] Agent does **NOT** include passport number in the response
- [ ] Agent states that passport information is not available (FR-010 — no fabrication)
- [ ] If the user typed PII in their message (e.g., `"my passport is A12345678"`), verify the persisted conversation history has the PII scrubbed
- [ ] Audit log entries for this request contain no PII

---

### Scenario 6: Invalid Claim Token

**Covers**: FR-006, FR-007, SC-005

**Steps**:
1. Manually craft a request to the agent gateway endpoint (e.g., `GET /api/agent-gateway/users/bookings`)
2. Include the `X-Agent-API-Key` header with the correct API key
3. Set the `X-User-Claim` header to one of:
   - An expired token (issued more than `CLAIM_TOKEN_TTL_SECONDS` ago)
   - A tampered token (modified payload with valid signature format)
   - A token signed with a different secret

**Verify**:
- [ ] Gateway returns `401 Unauthorized` for each invalid token variant
- [ ] Response body does not leak internal auth details (no stack traces, no secret hints)
- [ ] The rejection is logged in the audit trail

---

### Scenario 7: Audit Trail Verification

**Covers**: FR-014, SC-006

**Steps**:
1. Complete Scenarios 1–3 (triggers `search_flights`, `get_user_preferences`, `list_user_bookings`).
2. Query the `AuditLog` table (via Prisma Studio, psql, or a custom query).

**Verify**:
- [ ] Each tool call has an audit entry with:
  - `userId` — matches the authenticated test user
  - `toolName` — matches the tool invoked (`search_flights`, `get_user_preferences`, `list_user_bookings`)
  - `timestamp` — within expected time range
  - `responseSize` — non-zero integer
- [ ] Zero gaps — every tool call from scenarios 1–3 has a corresponding audit row
- [ ] Failed requests (e.g., Scenario 6) also have audit entries with error details

---

## Test Commands

### Gateway E2E Tests (NestJS / Jest)

```bash
npm run test:e2e --workspace=apps/api -- --testPathPattern=agent-gateway
```

### Agent Unit & Integration Tests (Python / pytest)

```bash
# Individual test modules
cd apps/agent && uv run pytest tests/test_tools.py tests/test_claim_token.py tests/test_graph.py tests/test_pii_scrubber.py -v

# Full agent test suite
cd apps/agent && uv run pytest tests/ -v
```

---

## Expected Outcomes

| Area                    | Expected Result                                                    | Success Criteria |
|-------------------------|--------------------------------------------------------------------|------------------|
| Tool accuracy           | All 3 tools return accurate, PII-free data                         | SC-002           |
| Claim token auth        | Invalid/expired tokens rejected 100% of the time                   | SC-005           |
| Audit log completeness  | Zero gaps — every tool call has a corresponding audit entry         | SC-006           |
| Context reuse           | Follow-up questions answered from context (no redundant tool calls) | SC-004           |
| SSE streaming           | Stream includes proper `tool_call` → `tool_result` → `token` events | FR-011           |
| PII scrubbing (storage) | Persisted messages and logs contain no user-typed PII               | SC-010           |
| Flight result cap       | Never more than 5 results per search query                          | SC-009           |
| End-to-end latency      | Tool-calling queries complete within 10 seconds                     | SC-001           |

---

## Related Documents

- **Spec**: [spec.md](file:///c:/Booking%20Systems/specs/003-agent-tool-calling/spec.md) — full requirements and acceptance scenarios
- **Plan**: [plan.md](file:///c:/Booking%20Systems/specs/003-agent-tool-calling/plan.md) — implementation plan and project structure
- **Data Model**: [data-model.md](file:///c:/Booking%20Systems/specs/003-agent-tool-calling/data-model.md) — entity definitions and relationships
- **Gateway API Contract**: [contracts/agent-gateway-api.md](file:///c:/Booking%20Systems/specs/003-agent-tool-calling/contracts/agent-gateway-api.md)
- **Tool Schemas**: [contracts/tool-schemas.md](file:///c:/Booking%20Systems/specs/003-agent-tool-calling/contracts/tool-schemas.md)
- **SSE Protocol**: [contracts/sse-protocol.md](file:///c:/Booking%20Systems/specs/003-agent-tool-calling/contracts/sse-protocol.md)
- **Auth Protocol**: [contracts/auth-protocol.md](file:///c:/Booking%20Systems/specs/003-agent-tool-calling/contracts/auth-protocol.md)
