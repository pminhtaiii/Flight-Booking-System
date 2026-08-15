# Feature 017 Phase 10C: Deterministic Graph Nodes & SSE Action Emission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the deterministic Python handoff client and graph execution nodes (`validate_handoff` and `create_handoff_token_node`) and the streaming `ACTION_HANDOFF` SSE action contract with turn persistence, strictly preventing LLM access to token creation tools and guaranteeing raw credential isolation.

**Architecture:** Extend `NestJSClient` with `create_handoff_token`, refine deterministic graph nodes `validate_handoff` (with bounds and snapshot expiry validation) and `create_handoff_token_node` in LangGraph, and ensure `sse.py` emits the versioned `ACTION_HANDOFF` SSE event in exact order (`token` -> `tool_call` -> `tool_result` -> `ACTION_HANDOFF` -> `done`) and persists completed turns without token leakage.

**Tech Stack:** Python 3.11, FastAPI, LangGraph, LangChain Core, Pydantic, HTTPX, Pytest.

**Spec:** `specs/017-chatbot-backend-infrastructure/spec.md` (FR-027, FR-028, FR-029, FR-037) and `specs/017-chatbot-backend-infrastructure/plan.md` (Phase 6 / Work Packages 6E & 6F).

## Global Constraints

- The LLM tool registry MUST NEVER include `create_handoff_token`, `validate_handoff`, or any network write tool.
- Raw handoff tokens MUST exist ONLY in the specific `handoffToken` / `token` field of the `ACTION_HANDOFF` event payload.
- Raw tokens MUST NEVER be streamed in message text, included in assistant thoughts, or written to conversation history tables.
- All logs and telemetry MUST redact token values, provider offer IDs, and traveler PII.
- Only verified attestation and 1-indexed offer position are sent to NestJS; caller-supplied session IDs or idempotency parameters are strictly omitted.

---

### Task 1: Deterministic Handoff Client (`apps/agent/src/agent/tools/nestjs_client.py`)

**Files:**
- Modify: `apps/agent/src/agent/tools/nestjs_client.py`
- Test: `apps/agent/tests/test_nestjs_client.py`

**Interfaces:**
- `create_handoff_token(attestation: str, selected_offer_index: int, fingerprint: Optional[str] = None, trace_id: Optional[str] = None, correlation_id: Optional[str] = None) -> dict`
- Propagates `X-Agent-API-Key`, `X-User-Claim`, `X-Trace-Id`, `X-Correlation-Id`, `X-Fencing-Token`.
- Sends payload: `{"selectionAttestationHash": attestation, "selectedOfferIndex": selected_offer_index}` (plus optional `snapshotFingerprint`).
- Omits caller-supplied session IDs and idempotency keys.
- Alias `create_handoff` maintained for compatibility.

- [ ] **Step 1: Write failing unit test for `create_handoff_token` in `test_nestjs_client.py`**
- [ ] **Step 2: Implement `create_handoff_token` in `nestjs_client.py`**
- [ ] **Step 3: Run `uv run pytest tests/test_nestjs_client.py` to verify pass**

---

### Task 2: Deterministic Graph Nodes & State Validation (`apps/agent/src/agent/graph/nodes.py` & `graph.py`)

**Files:**
- Modify: `apps/agent/src/agent/graph/nodes.py`
- Modify: `apps/agent/src/agent/graph/graph.py`
- Test: `apps/agent/tests/test_handoff_nodes.py`

**Interfaces:**
- `validate_handoff(state: AgentState, config: RunnableConfig) -> dict`:
  - Validates `signal` exists and `offer_index` is positive int.
  - Validates `trusted_snapshot` exists with `version` and `attestation`.
  - Validates `offer_index` is within `results` range (`1 <= idx <= len(results)`).
  - Validates snapshot timestamp is not expired against current UTC time.
  - Returns `{}` on success, `{"action": {"error": "<safe message>"}}` on failure.
- `create_handoff_token(state: AgentState, config: RunnableConfig) -> dict` (and alias `create_handoff_token_node`):
  - Gated by `FEATURE_FLAG_CHAT_HANDOFF_ISSUE`.
  - Calls `client.create_handoff_token(...)`.
  - Maps allowlisted display metadata only (`airline`, `flightNumber`, `origin`, `destination`, `departureAt`, `arrivalAt`, `price`, `currency`).
  - Redacts upstream exceptions to safe message.
  - Returns `{"action": {"action": "begin_checkout", "handoffToken": token, "expiresAt": expires_at, "display": display}}`.
- Tool inventory assertion in `test_handoff_nodes.py`:
  - Asserts `create_handoff_token` / `validate_handoff` are not in `_GENERAL_TOOLS`, `_TRAVEL_TOOLS`, or `_CHECKOUT_TOOLS`.

- [ ] **Step 1: Write failing tests in `test_handoff_nodes.py` for out-of-bounds index, snapshot expiry, safe error degradation, and tool registry inventory**
- [ ] **Step 2: Update `validate_handoff` and `create_handoff_token` in `nodes.py` and `graph.py`**
- [ ] **Step 3: Run `uv run pytest tests/test_handoff_nodes.py` to verify pass**

---

### Task 3: Streaming SSE Action Contract & Privacy Isolation (`apps/agent/src/agent/streaming/sse.py`)

**Files:**
- Modify: `apps/agent/src/agent/streaming/sse.py`
- Test: `apps/agent/tests/test_sse_integration.py`

**Interfaces:**
- `on_chain_end` for `create_handoff_token`:
  - Validates active session lock fence.
  - Emits `ACTION_HANDOFF` SSE event with payload:
    ```json
    {
      "version": 1,
      "action": "begin_checkout",
      "handoffToken": "<raw token>",
      "expiresAt": "<ISO-8601>",
      "display": { ... }
    }
    ```
  - Emits in correct sequence: tool calls/results -> `ACTION_HANDOFF` -> `done`.
  - Ensures raw handoff token is NOT in `partial_response` and NEVER stored in conversation message content or summaries.
  - Sets `force_persistence = True` so the completed turn is persisted to NestJS via Agent Gateway.

- [ ] **Step 1: Write failing integration tests in `test_sse_integration.py` verifying exact event ordering, negative privacy assertion for persisted message text/logs, and fence expiration handling**
- [ ] **Step 2: Refine `sse.py` handling for `create_handoff_token` / `create_handoff_token_node`**
- [ ] **Step 3: Run `uv run pytest tests/test_sse_integration.py` to verify pass**

---

### Task 4: Regression Verification & Documentation Update

**Files:**
- Modify: `context/progress-checker.md`
- Modify: `specs/017-chatbot-backend-infrastructure/tasks.md`

- [ ] **Step 1: Run full pytest suite in `apps/agent`**
- [ ] **Step 2: Run Jest / E2E suites in `apps/api`**
- [ ] **Step 3: Execute Code Review subagents (Standards & Spec)**
- [ ] **Step 4: Update task status and documentation**
