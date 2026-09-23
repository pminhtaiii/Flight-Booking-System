# Research: Agent Boundary Simplification

## Agent-chat ownership

**Decision**: Move the agent controller/access service to `agent-gateway/agent-chat/` behind `AgentChatModule`.

**Rationale**: The routes and both guards are edge concerns. This removes the core chat module's dependency on gateway authentication and matches existing gateway locality. Controller guard declaration retains `AgentApiKeyGuard` followed by `ClaimTokenGuard`, and `ClaimTokenGuard` explicitly retains its existing `/access/check` bypass (validating `{ sub }` via the access service with API key only), while session routes enforce `X-User-Claim`.

**Alternatives**: Keeping a module in `chat/` leaves ownership scattered; leaving the current wiring preserves the inversion.

## Chat crypto ownership

**Decision**: Move `ChatMessageCryptoService` intact to `common/` and export it from `ChatMessageCryptoModule`.

**Rationale**: Chat and attested flight search share this cohesive service; relocation removes the latter's dependency on the whole chat module without changing crypto.

**Alternatives**: A generic AES wrapper is unused abstraction; merging with `EncryptionService` would conflate distinct keys, rotation, serialization, and consumers.

## Fixed guardrail sequences

**Decision**: `GuardrailGateway()` constructs fixed production input/tool tuples. A keyword-only private test seam can inject tuples, but `assert_layer_order` applies the same exact type/order, unique-key, and prerequisite-before-dependent rules and raises during construction.

**Rationale**: The layer inventory is static and has no plugin/configuration path. Fixed order is directly auditable; invalid composition never becomes a recoverable unhealthy instance. `is_healthy()` is limited to runtime readiness after successful construction. One idempotent main-module factory/get-or-create path prevents module-load/lifespan double construction.

**Alternatives**: A stripped registry retains indirection; DAG sorting solves a dynamic ordering problem the service does not have.

## Gateway-owned output streaming

**Decision**: Make `GuardrailGateway.stream_output(context, *, config, session_id)` a factory for an async context-managed per-turn stream-session facade. One facade owns one pipeline across all three runner branches, exposes `process_token()`, a one-shot `flush()`, and an idempotent non-flushing `close()`; `__aexit__` always calls `close()`. Move `OutputGuardrailBlockedError` to stable `guardrails.base` so runner depends on no internal delegate.

**Rationale**: A one-shot async iterator cannot preserve a single buffer across non-contiguous branches. Separating flush from idempotent close preserves `_finalize_cleanup` and all normal/block/early/error paths: persist approved partial response, close without releasing buffered data, then release the lease. Repeated close calls are harmless; block exceptions retain `partial_response`.

**Alternatives**: Absorbing all buffering creates a god object; direct runner construction preserves a bypass.

## Tool output and PII priority

**Decision**: Inline tool-output orchestration in canonical `validate_tool_result` and express the schema/PII overlap rule with a named PII scanner applied to the original raw tool result, including schema-invalid extra fields.

**Rationale**: This removes positional magic and preserves `GUARDRAIL_TOOL_PII` priority when both rules block.

**Alternatives**: Keeping the wrapper with named dependencies remains a pass-through abstraction without its own lifecycle.

## Stateless PII utility and SSE ingress

**Decision**: Move `deterministic_pii_match`, `_is_output_guardrail_disabled`, and `approved_model_content()` together to `guardrails/pii.py`; `output_pipeline.py` imports both matcher and predicate and retains `payload_free_config`. Keep the SSE length defense but remove the duplicate ingress PII pre-check.

**Rationale**: Co-locating the predicate and matcher preserves every disabled-config shape without duplicate definitions or a `pii.py` → `output_pipeline.py` cycle. At ingress, after length and gateway health checks, SSE calls `validate_input` once before Redis/quota. PII returns the exact legacy event immediately with zero Redis/quota calls; the stored decision/data is passed to `ChatController` to prevent revalidation. An unhealthy gateway still returns its existing 503 first; with a healthy gateway, PII wins over Redis/quota failure.

**Test matrix**: Direct matcher cases; `approved_model_content` enabled/default and all legacy disabled shapes; output-pipeline streaming-disabled and cross-token cases through imported matcher/predicate; static no-duplicate/import-cycle census and lint; SSE spy assertions for one gateway call, zero Redis/quota calls on PII, one exact event, 503 precedence when gateway is unhealthy, and PII precedence over Redis failure when healthy.

**Alternatives**: A universal gateway utility increases coupling; keeping both PII paths risks divergent event formats and detection.

## Resolved constraints

- No public HTTP/SSE, auth, encryption/AAD, persistent schema, external API, layer behavior/order, PII-priority, or fail-closed change.
- No post-validation normalization; `normalization.py` remains detector-internal.
- `tool_schemas.py` is deleted only if a targeted import check proves it unused.
