# Research: AI Chatbot Agent Service

**Date**: 2026-06-29 | **Spec**: [spec.md](specs/002-chatbot-agent-service/spec.md)

---

## Decision 1: Python Framework

**Choice**: FastAPI (Python 3.11+)

**Rationale**: Confirmed from grilling session. FastAPI provides async-first HTTP with native SSE streaming via `sse-starlette`. First-class Pydantic validation, dependency injection, and middleware support. The async model aligns with LLM streaming requirements.

**Alternatives considered**:
- Flask — no native async, SSE support is hacky
- Django — too heavy for a single-purpose agent service
- Starlette (raw) — FastAPI adds routing, validation, DI on top

---

## Decision 2: SSE Streaming Implementation

**Choice**: `sse-starlette` library with `EventSourceResponse`

**Rationale**: Purpose-built for FastAPI/Starlette. Provides a clean async generator interface that maps directly to LangChain's `.astream()` method. Supports custom event types (`token`, `done`, `error`) for structured client consumption.

**Event protocol**:
- `event: token` — incremental response token
- `event: done` — response complete
- `event: error` — error occurred (user-friendly message only)

**Alternatives considered**:
- Raw Starlette `StreamingResponse` — no SSE event framing
- WebSocket — more complex, SSE is sufficient for server→client streaming

---

## Decision 3: JWT Validation in Python

**Choice**: `PyJWT` library with HS256 algorithm, shared `JWT_SECRET` (matching NestJS `JWT_SECRET`)

**Rationale**: The NestJS API service issues its own standard HS256-signed JWTs (via `@nestjs/jwt`) during login/registration, rather than relying on JWE-encrypted NextAuth session tokens directly. The Python agent shares the same `JWT_SECRET` environment variable with NestJS and validates these NestJS-signed JWTs in FastAPI middleware. The token payload contains `id` (user ID) and `email`. The raw token is preserved in request state for forwarding to NestJS API calls.

**Alternatives considered**:
- decrypting NextAuth JWE tokens — extremely complex in Python and duplicates NestJS decryption logic
- Service-to-service API keys — adds complexity, user context validation is required anyway

---

## Decision 4: Input Guardrails Library

**Choice**: Abstract guardrail interface with LlamaFirewall as primary implementation

**Rationale**: The spec requires guardrails (FR-004, FR-012). LlamaFirewall (Meta) is the intended library. However, availability may vary, so the guardrail layer is built behind a protocol/interface (`GuardrailService`) allowing the implementation to be swapped (LlamaFirewall → NeMo Guardrails → custom regex) without changing the rest of the service.

**Fail-closed behavior**: When the guardrail service is unavailable, all messages are blocked (FR-012).

**Alternatives considered**:
- NeMo Guardrails (NVIDIA) — more mature, available on PyPI, viable fallback
- Rebuff — lightweight but less comprehensive
- Custom regex — baseline pattern matching, lowest capability

---

## Decision 5: LangChain Python Agent Setup

**Choice**: `langchain-openai` with `ChatOpenAI` pointing to Mimo's OpenAI-compatible endpoint

**Rationale**: Same pattern as the existing TypeScript agent setup in `library-docs.md`, but in Python. `ChatOpenAI` accepts `base_url` parameter for custom endpoints. `streaming=True` enables token-by-token streaming. Tool calling via `@tool` decorator and `create_tool_calling_agent`.

**Temperature**: `0.7` for conversational responses (per library-docs.md guidance).

---

## Decision 6: Python Project in Monorepo

**Choice**: `apps/agent/` directory with `pyproject.toml`, independent of pnpm workspace

**Rationale**: pnpm workspace only manages Node.js packages. The Python service lives as a peer directory (`apps/agent/`) with its own `pyproject.toml`, `requirements.txt`, and `.venv/`. Root `package.json` includes convenience scripts (`agent:dev`, `agent:test`, `agent:install`) that shell into the Python project.

**Virtual environment**: `uv` or `venv` in `apps/agent/.venv/` — added to `.gitignore`.

---

## Decision 7: LangSmith Tracing

**Choice**: Environment variable activation (zero-code instrumentation)

**Rationale**: LangChain's Python SDK auto-detects `LANGCHAIN_TRACING_V2=true` and sends traces to LangSmith. No code changes needed. Traces include LLM calls, tool calls, chain execution, token usage, and latency.

**Environment variables**:
- `LANGCHAIN_TRACING_V2=true`
- `LANGCHAIN_API_KEY` — LangSmith API key
- `LANGCHAIN_PROJECT=flight-booking-agent`
- `LANGCHAIN_ENDPOINT=https://api.smith.langchain.com`

---

## Decision 8: Chat Data Persistence

**Choice**: NestJS REST endpoints, Python agent forwards user JWT

**Rationale**: Confirmed from grilling session Decision 5. NestJS owns all chat data in PostgreSQL. Python agent calls NestJS REST endpoints to create/read sessions and messages. The user's JWT is forwarded in the Authorization header. NestJS's existing `JwtAuthGuard` validates these requests transparently — no new auth mechanism needed.

**Specialized endpoint**: `/api/chat/sessions/:sessionId/memory` returns the most recent summary + last N messages, ready for LLM context assembly.

---

## Decision 9: Conversation Memory Strategy

**Choice**: Manual sliding window + summary with async post-response summarization

**Rationale**: Confirmed from grilling session Decision 6 and spec FR-006. After the agent completes a response, the system checks if older messages exceed the token budget. If so, summarization runs asynchronously before the next message is processed. Summary is stored as a `ChatMessage` with `type: SUMMARY`. Fallback: if summarization fails, truncate to most recent N messages (FR-014).

**Timing**: Summarization NEVER runs during active streaming (spec requirement).

---

## Decision 10: Concurrent Message Handling

**Choice**: Per-conversation message queue with max depth limit

**Rationale**: From spec FR-013 and clarification session. One message processed at a time per conversation. Additional messages queued in arrival order. Max queue depth enforced — excess messages rejected with error. Implementation: in-memory `asyncio.Queue` per conversation ID, keyed by session ID.
