# Implementation Plan: AI Chatbot Agent Service

**Branch**: `002-chatbot-agent-service` | **Date**: 2026-06-29 | **Spec**: [spec.md](specs/002-chatbot-agent-service/spec.md)

**Input**: Feature specification from [specs/002-chatbot-agent-service/spec.md](specs/002-chatbot-agent-service/spec.md)

---

## Summary

Build a standalone Python/FastAPI agent service (`apps/agent/`) that receives user questions via SSE streaming, validates authentication, applies LlamaFirewall input guardrails, orchestrates a LangChain-powered conversational agent, manages conversation memory (sliding window + summary), and persists all chat data through the existing NestJS API. The NestJS API is extended with a ChatModule providing REST endpoints for session/message CRUD and memory retrieval.

---

## Technical Context

**Language/Version**: Python 3.11+ (agent service), TypeScript strict (NestJS chat module, shared types)

**Primary Dependencies**:
- Agent: FastAPI, sse-starlette, PyJWT, LangChain, langchain-openai, LangGraph, LlamaFirewall, httpx, python-dotenv
- NestJS: Prisma (schema extension), class-validator, existing auth guards

**Storage**: PostgreSQL (existing instance) — new `ChatSession` and `ChatMessage` models via Prisma migration

**Testing**: pytest + pytest-asyncio (agent), Jest (NestJS chat E2E)

**Target Platform**: Linux server (Docker), development on Windows

**Project Type**: Microservice within monorepo (`apps/agent/`)

**Performance Goals**: First token < 3s (SC-001), guardrail latency < 500ms p95 (SC-003), health check < 1s (SC-005)

**Constraints**: Guardrails fail-closed (FR-012), 1 message at a time per conversation (FR-013), no PII in logs (FR-009)

**Scale/Scope**: Single-user concurrent sessions, no horizontal scaling for v1

---

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Justification |
|-----------|--------|---------------|
| I. Flight-First Architecture | ✅ PASS | Chatbot is supplementary — does not block, delay, or complicate the booking pipeline |
| II. Deterministic Transaction Boundary | ✅ PASS | Agent is advisory only. Read-only tools by default. No booking/payment mutations. All transactional operations remain in NestJS deterministic services |
| III. API Budget Discipline | ✅ PASS | Agent does not call Amadeus API directly. Tool calls go through NestJS services which enforce caching and budget limits |
| IV. Observability & Operational Visibility | ✅ PASS | Health check endpoint (FR-008), structured logging (FR-009), LangSmith tracing for all agent runs, security event logging |
| V. Incremental Delivery | ✅ PASS | Feature is split into 6 independently deployable phases. Each phase delivers a testable increment |

**Post-design re-check**: All principles remain satisfied. The Python service is an isolated advisory layer with no access to the transactional path.

---

## Project Structure

### Documentation (this feature)

```text
specs/002-chatbot-agent-service/
├── plan.md              # This file
├── research.md          # Phase 0 output — technology decisions
├── data-model.md        # Phase 1 output — entity models
├── quickstart.md        # Phase 1 output — validation guide
├── contracts/
│   ├── nestjs-chat-api.md   # NestJS REST API contract
│   └── agent-sse-api.md     # Python SSE streaming contract
└── tasks.md             # Phase 2 output (via /speckit-tasks)
```

### Source Code (repository root)

```text
apps/
├── api/                              # NestJS backend (existing)
│   ├── prisma/
│   │   └── schema.prisma             # [MODIFY] Add ChatSession, ChatMessage models
│   └── src/
│       ├── app.module.ts             # [MODIFY] Import ChatModule
│       └── chat/                     # [NEW] Chat data persistence module
│           ├── chat.module.ts
│           ├── chat.controller.ts
│           ├── chat.service.ts
│           └── dto/
│               ├── create-session.dto.ts
│               ├── create-message.dto.ts
│               ├── update-session.dto.ts
│               └── list-sessions-query.dto.ts
│
├── agent/                            # [NEW] Python/FastAPI agent service
│   ├── pyproject.toml
│   ├── package.json                  # Minimal — pnpm workspace adapter
│   ├── .python-version
│   ├── .env.example
│   ├── src/
│   │   └── agent/
│   │       ├── __init__.py
│   │       ├── main.py               # FastAPI app entry point
│   │       ├── config.py             # Environment config
│   │       ├── middleware/
│   │       │   └── auth.py           # JWT validation middleware
│   │       ├── guardrails/
│   │       │   ├── base.py           # GuardrailService protocol
│   │       │   └── firewall.py       # LlamaFirewall implementation
│   │       ├── agents/
│   │       │   └── chat_agent.py     # LangChain conversational agent
│   │       ├── memory/
│   │       │   └── manager.py        # Sliding window + summary memory
│   │       ├── tools/
│   │       │   └── nestjs_client.py  # NestJS API client (httpx)
│   │       ├── streaming/
│   │       │   └── sse.py            # SSE event stream handler
│   │       ├── queue/
│   │       │   └── message_queue.py  # Per-conversation message queue
│   │       └── models/
│   │           ├── requests.py       # Pydantic request models
│   │           └── responses.py      # Pydantic response models
│   └── tests/
│       ├── conftest.py
│       ├── test_auth.py
│       ├── test_guardrails.py
│       ├── test_streaming.py
│       └── test_memory.py
│
└── web/                              # Next.js frontend (existing, no changes in this spec)

packages/
└── shared/
    └── src/
        └── types/
            └── index.ts              # [MODIFY] Add ChatSession, ChatMessage types
```

**Structure Decision**: The agent service lives at `apps/agent/` as decided in the grilling session (Decision 2). It's a Python/FastAPI service co-located with `apps/api` and `apps/web` in the monorepo. pnpm workspace recognizes it via a minimal `package.json`. Python dependencies are managed by `uv` in an isolated virtual environment.

---

## Phase Breakdown

This feature is organized into **6 phases**, each independently testable and deployable. The phases are ordered by dependency — each phase builds on the previous one.

### Phase 1: Prisma Schema + NestJS ChatModule (Data Layer)

**Covers**: FR-005, FR-007, FR-003, SC-006, H6, H7

**Scope**:
- Add `ChatSession` and `ChatMessage` Prisma models (see [data-model.md](specs/002-chatbot-agent-service/data-model.md))
- Add `MessageSender` and `MessageType` enums
- Add `chatSessions` relation to existing `User` model
- Run Prisma migration
- Build `ChatModule` with controller, service, and DTOs
- Implement REST endpoints (see [nestjs-chat-api.md](specs/002-chatbot-agent-service/contracts/nestjs-chat-api.md))
- Implement batch message persistence endpoint `POST /api/chat/sessions/:sessionId/messages/batch` to save user message + agent response atomically in a transaction (H7)
- Implement structured audit logging in NestJS `ChatService` using the existing `AuditService` for session creation/deletion and message creation (H6)
- All endpoints protected by `JwtAuthGuard`, scoped to authenticated user
- E2E tests for chat CRUD operations

**Output**: Working REST API for chat data persistence, independently testable via curl/Postman.

---

### Phase 2: Python Service Scaffold + JWT Auth (Service Foundation)

**Covers**: FR-002, FR-011, FR-008, SC-002, SC-005, C1, C2, H5, M1, M2

**Scope**:
- Create `apps/agent/` directory structure
- Set up `pyproject.toml` with dependencies including `fastapi`, `sse-starlette`, `pyjwt`, `pydantic-settings`, `tiktoken`
- Create minimal `package.json` for pnpm workspace
- Implement FastAPI app entry point (`main.py`)
- Implement `config.py` using Pydantic `BaseSettings` for env validation (H5)
- Configure FastAPI CORS middleware to allow requests from the frontend origin `FRONTEND_URL` (C2)
- Implement JWT auth middleware using PyJWT with NestJS-signed HS256 tokens and shared `JWT_SECRET` (C1)
- Implement rate limiting middleware (e.g. per-user limit) (M1)
- Implement generic graceful shutdown hook (M2)
- Implement `/health` endpoint with dependency checks (LLM, NestJS API, guardrails)
- Implement NestJS API client (`nestjs_client.py`) using httpx
- Configure LangSmith tracing via environment variables
- Unit tests for auth middleware, config validation, and health endpoint
- Update root `.gitignore` for Python artifacts

**Output**: Running FastAPI service that validates JWT tokens and reports health status. NestJS API client can make authenticated requests.

---

### Phase 3: Input Guardrails (Security Layer)

**Covers**: FR-004, FR-012, FR-009, FR-015, SC-003, M6

**Scope**:
- Define `GuardrailService` protocol (abstract interface)
- Implement LlamaFirewall-based guardrail (`firewall.py`)
- Pre-load LlamaFirewall BERT model at service startup via FastAPI lifespan events to avoid cold-start latency (M6)
- Implement fail-closed behavior (FR-012): when guardrails unavailable, block all messages
- Implement max message length validation (FR-015)
- Implement structured security event logging (FR-009): blocked inputs, guardrail triggers
- No PII or raw malicious payloads in logs
- Add guardrail latency and model loading status to health check
- Unit tests for guardrail pass/block/unavailable scenarios

**Output**: Guardrail layer that blocks malicious inputs and fails closed on unavailability. Independently testable.

---

### Phase 4A: SSE Streaming & API Client Foundation

**Covers**: FR-001, H1, M2

**Scope**:
- Implement SSE streaming endpoint (`POST /chat/stream`)
- Implement SSE event protocol: `token`, `done`, `error` events with mock streaming response
- Implement NestJS API client (`nestjs_client.py`) using httpx for authenticated API requests
- Support optional `sessionId` in request body. If omitted, automatically create a new session via NestJS REST API and return the `sessionId` in the done event (H1)
- Implement graceful shutdown handling to send error events to active SSE streams on shutdown (M2)
- Unit/integration tests for the streaming and API client foundation

**Output**: Running FastAPI streaming endpoint that can stream tokens and auto-create sessions via NestJS API.

---

### Phase 4B: LangChain Agent & Mid-Stream Drop Persistence

**Covers**: FR-001, FR-010, SC-001, H3

**Scope**:
- Set up LangChain `ChatOpenAI` with Mimo endpoint (streaming=True)
- Create conversational agent with system prompt
- Handle LLM provider failures gracefully (FR-010): user-friendly error event
- Handle mid-stream connection drops / LLM failures: persist user input and partial agent response generated so far to NestJS via batch endpoint, and include `partialMessageId` in the `error` event payload (H3)
- Wire together: JWT auth → guardrails → agent → SSE stream → persistence (batch save user/agent pair on success)
- Integration tests for full streaming flow with agent completion and drop handling

**Output**: End-to-end chat: authenticated user sends message, receives streaming response from LLM agent, and messages are persisted on completion or drop.

---

### Phase 5: Conversation Memory Management

**Covers**: FR-006, FR-014, SC-004, M3, M5

**Scope**:
- Implement memory manager (`memory/manager.py`)
- Load conversation memory from NestJS `/memory` endpoint: summary + recent N messages
- Assemble LLM context: system prompt → summary → recent messages → new input
- Implement post-response token budget check using `tiktoken` library for precise token counting (M3)
- Implement async summarization trigger (between responses, not during streaming)
- Store summary as `ChatMessage` with `type: SUMMARY` via NestJS API
- Implement summarization failure fallback: truncation to recent N messages (FR-014)
- Retry summarization on next applicable turn
- Unit tests for memory assembly, budget checking, summarization trigger
- Ensure types/schemas align with NestJS API contracts as single source of truth (M5)

**Output**: Conversations maintain context across many messages. Summarization runs transparently between turns.

---

### Phase 6: Concurrent Message Queue + Conversation Management

**Covers**: FR-013, FR-007

**Scope**:
- Implement per-conversation message queue (`queue/message_queue.py`)
- Enforce one message at a time per conversation (arrival order)
- Enforce max queue depth limit; reject excess messages with error
- Implement conversation session management:
  - Creating new sessions (via NestJS API)
  - Listing sessions (via NestJS API)
  - Switching between sessions (isolated context)
- Integration tests for concurrent message rejection and session isolation

**Output**: Full concurrent safety and multi-conversation management. All spec requirements met.

---

## Complexity Tracking

No constitution violations — no complexity justification needed.

---

## Environment Variables (New)

### apps/agent/.env

| Variable | Purpose |
|----------|---------|
| `JWT_SECRET` | Shared JWT secret used by NestJS to sign standard HS256 tokens (not NEXTAUTH_SECRET) |
| `FRONTEND_URL` | Next.js frontend origin (default: `http://localhost:3000`) for CORS (C2) |
| `NESTJS_API_URL` | NestJS API base URL (e.g., `http://localhost:3001`) |
| `MIMO_API_URL` | Mimo OpenAI-compatible endpoint |
| `MIMO_API_KEY` | Mimo API key |
| `MIMO_MODEL_NAME` | Model identifier (default: `mimo`) |
| `LANGCHAIN_TRACING_V2` | Enable LangSmith tracing (`true`) |
| `LANGCHAIN_API_KEY` | LangSmith API key |
| `LANGCHAIN_PROJECT` | LangSmith project name |
| `AGENT_PORT` | Agent service port (default: `3002`) |
| `MAX_MESSAGE_LENGTH` | Max input message chars (default: `10000`) |
| `MEMORY_WINDOW_SIZE` | Recent messages to keep (default: `20`) |
| `MEMORY_TOKEN_BUDGET` | Token budget before summarization (default: `4000`) |
| `QUEUE_MAX_DEPTH` | Max queued messages per conversation (default: `3`) |

---

## Cross-References

| Artifact | Path |
|----------|------|
| Feature Spec | [spec.md](specs/002-chatbot-agent-service/spec.md) |
| Research | [research.md](specs/002-chatbot-agent-service/research.md) |
| Data Model | [data-model.md](specs/002-chatbot-agent-service/data-model.md) |
| NestJS API Contract | [contracts/nestjs-chat-api.md](specs/002-chatbot-agent-service/contracts/nestjs-chat-api.md) |
| Agent SSE Contract | [contracts/agent-sse-api.md](specs/002-chatbot-agent-service/contracts/agent-sse-api.md) |
| Quickstart | [quickstart.md](specs/002-chatbot-agent-service/quickstart.md) |
| Grilling Decisions | [research/chatbot-backend-architecture.md](research/chatbot-backend-architecture.md) |
| Constitution | [.specify/memory/constitution.md](.specify/memory/constitution.md) |
