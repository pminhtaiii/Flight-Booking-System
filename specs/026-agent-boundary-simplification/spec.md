# Feature Specification: Agent Boundary Simplification

**Feature Branch**: `codex/026-agent-boundary-simplification`
**Created**: 2026-09-23
**Status**: Draft
**Input**: Behavior-preserving internal refactor with two independently shippable slices: NestJS agent-chat/shared-crypto extraction and Python guardrail-registry collapse.

## User Scenarios & Testing

### User Story 1 - Restore the NestJS Agent Boundary (Priority: P1)

As a maintainer, I can change user chat without pulling agent-gateway authentication into the core chat module, while the agent keeps the same persistence routes and encryption behavior.

**Why this priority**: It removes an edge-to-core inversion and the broad `ChatModule` dependency used only to obtain crypto.

**Independent Test**: Build and boot the API after this slice alone; exercise every `/api/agent-gateway/chat/*` route and crypto characterization; statically prove `ChatModule` has no gateway import and attested search does not import `ChatModule`.

**Acceptance Scenarios**:

1. **Given** any existing agent-chat request, **When** handled after extraction, **Then** its route, guards, body, status, fencing behavior, and error mapping are unchanged.
2. **Given** an existing encrypted message or title, **When** decrypted after relocation, **Then** the same key, AES-256-GCM envelope, version, and record-bound AAD are used.
3. **Given** the module graph, **When** inspected, **Then** `ChatModule` exports only `ChatService`, `AgentChatModule` owns the edge adapter, and attested search imports only the crypto module.

---

### User Story 2 - Make the Guardrail Gateway Authoritative (Priority: P2)

As a security maintainer, I can verify one fixed orchestration path without a speculative registry, dead pipelines, positional layer access, or output bypasses.

**Why this priority**: Current dynamic machinery has no runtime extension consumer and does not prevent bypasses.

**Independent Test**: Implement this slice alone; run focused gateway/input/tool/output/runner/SSE/security and holdout suites; prove deleted symbols have no production references.

**Acceptance Scenarios**:

1. **Given** a production gateway, **When** it starts, **Then** it owns fixed input/tool sequences, verifies prerequisites, and refuses invalid order/types.
2. **Given** output emitted by any of the runner's three model-output branches, **When** streamed during one turn, **Then** all tokens pass through one gateway-owned stream session, which flushes once and closes on every exit while preserving holdback, blocking, and approved-prefix persistence.
3. **Given** a schema-invalid raw tool result whose extra fields contain PII, **When** `validate_tool_result` runs, **Then** the PII scanner receives the original raw result and PII response priority is preserved without positional indexing.
4. **Given** a healthy gateway and input containing PII, **When** admitted through `/chat/stream`, **Then** SSE calls `validate_input` exactly once after the length/health checks but before Redis/quota, returns the exact legacy one-event response, and performs zero Redis or quota calls.

### Edge Cases

- Empty/corrupt crypto envelopes fail closed; empty ciphertext is valid only with nonce, tag, and supported positive version.
- Missing/malformed keys, unsupported versions, and authentication failures retain current behavior with no plaintext fallback.
- Both lowercase and canonical `X-Fencing-Token` spellings remain accepted.
- Invalid contexts, absent/misordered layers, classifier/invocation errors, malformed batches, and unauthorized tools remain fail-closed with existing keys.
- Output PII split across chunks leaks zero undecided bytes; only approved prefix may persist.
- An output block raised from any model-output branch preserves `OutputGuardrailBlockedError.partial_response`; the stream session never suppresses or replaces that exception.
- Turn completion flushes exactly once; early block, cancellation, or error closes without an additional flush.
- Stream-session `close()` is idempotent and never flushes, so every runner cleanup path preserves partial-response persistence → close → lease release ordering and multiple cleanup guards cannot release buffered content.
- Test-only disabled output-guardrail behavior remains compatible.
- Accepted non-Latin input is not rewritten; normalization remains detection-only.
- Invalid production or injected test layer composition aborts construction; `is_healthy()` reports only post-construction runtime readiness and is not a recovery path for constructor failure.

## Requirements

### Functional Requirements

- **FR-001**: Move `AgentChatController`, `AgentChatAccessService`, and colocated tests to `apps/api/src/agent-gateway/agent-chat/` under `AgentChatModule`.
- **FR-002**: Preserve every `/agent-gateway/chat/*` path, guard order, body/response, status, fencing header, and `CHAT_SESSION_NOT_FOUND` mapping.
- **FR-003**: Compose/export `AgentChatModule` from `AgentGatewayModule`; `ChatModule` MUST remove both the `AgentAuthModule` source import and imports-array entry, contain no agent-gateway dependency, and export only `ChatService`.
- **FR-004**: Move `ChatMessageCryptoService` unchanged in behavior to `apps/api/src/common/` behind `ChatMessageCryptoModule`.
- **FR-005**: Preserve `CHAT_ENCRYPTION_KEY`, AES-256-GCM, 12-byte nonce, 16-byte tag, key version `1`, hex structured envelope, record-bound AAD, and strict decryption.
- **FR-006**: `ChatModule` and attested search MUST import `ChatMessageCryptoModule`; attested search MUST drop `ChatModule`; consumers/tests MUST use the common path.
- **FR-007**: Gateway MUST own fixed input order `(LengthValidator, PIIDetector, InjectionDetector, TopicBoundary)` and tool order `(SizeStructureValidator, SchemaValidator, PIIScanner, UntrustedContentInjectionDetector)`.
- **FR-008**: `GuardrailGateway()` MUST construct the production tuples with no caller-supplied registry; an explicit keyword-only test seam MAY inject tuples, but the same `assert_layer_order` rules MUST reject missing, duplicated, reordered, wrongly typed, unknown-key, or prerequisite-invalid composition during construction.
- **FR-009**: Remove `GuardrailRegistry`, `create_production_registry`, `OutputPIILayer`, `InputGuardrailPipeline`, and `ToolOutputGuardrailPipeline` after caller/test migration.
- **FR-010**: Input/tool/batch validation MUST retain sealed authority, ordering, short-circuiting, response keys, and fail-closed exception behavior.
- **FR-011**: The canonical `validate_tool_result` method MUST preserve schema-failure PII priority via a named `PIIScanner` applied to the original raw tool result, including schema-invalid extra fields; no alias or tuple position is permitted.
- **FR-012**: `GuardrailGateway.stream_output(context, *, config, session_id)` MUST return an async context-managed per-turn stream-session facade that owns exactly one `OutputGuardrailPipeline`, exposes token processing to all three runner output branches, and provides separate one-shot `flush()` and idempotent non-flushing `close()` operations; `__aexit__` MUST call `close()` safely on every exit.
- **FR-013**: `OutputGuardrailBlockedError` MUST be owned/exported from stable `agent.guardrails.base`, and the stream-session facade MUST re-raise it without changing `partial_response`; external callers MUST NOT import/construct `OutputGuardrailPipeline` or import its block error from `output_pipeline.py`. Runner MUST preserve approved-prefix persistence → close → lease-release ordering at `_finalize_cleanup`, normal, blocked, early-return, cancelled, and exceptional call sites.
- **FR-014**: Move `deterministic_pii_match`, `_is_output_guardrail_disabled`, and `approved_model_content()` together to `agent.guardrails.pii`; `output_pipeline.py` MUST import both matcher and predicate, retain `payload_free_config` as a stateless helper that external callers MAY continue importing from that module, and preserve every current disabled-config shape without duplicate definitions or an import cycle.
- **FR-015**: Remove duplicate PII detection from `sse.py` but retain its transport maximum-length rejection. After the length guard and a successful gateway existence/type/health check, SSE MUST build the existing admission context and call `validate_input` exactly once before any Redis/quota work. A `GUARDRAIL_INPUT_PII` decision MUST immediately return one legacy `error` event with code `GUARDRAIL_BLOCKED`, message `Your message contains protected personal information and cannot be processed.`, `partialMessageId: null`, and no earlier/later event. The already-validated decision/data MUST be passed into `ChatController.stream` so it does not call the gateway again; non-PII blocks retain their existing safe mapping.
- **FR-016**: Preserve HTTP endpoints, SSE names/payloads/order, health shape, guardrail keys, telemetry, auth, fencing, and model/tool behavior. PII admission MUST consume no quota and MUST make zero Redis calls. Gateway-unavailable/degraded MUST retain the existing 503 and take precedence; with a healthy gateway, PII rejection MUST take precedence over Redis/quota availability.
- **FR-017**: Add no database migration, persistent schema, public API, package, feature flag, or post-validation normalization.
- **FR-018**: P1 and P2 MUST each be buildable, testable, deployable, and reversible independently.
- **FR-019**: Tests MUST cover module boundaries, crypto compatibility, startup failure, order, PII priority, chunk partitioning, cleanup, SSE admission, health, and deletion/import censuses.
- **FR-020**: Application startup and lifespan MUST use one idempotent canonical gateway factory/get-or-create path so `app.state.guardrail_gateway` is not constructed twice; invalid production composition MUST abort startup, while `is_healthy()` is reserved for runtime readiness after successful construction.

### Key Runtime Entities

- **AgentChatModule**: Edge adapter for agent-authenticated chat persistence and access.
- **ChatMessageCryptoModule**: Shared owner of unchanged record-bound chat crypto.
- **GuardrailGateway**: Fixed input, tool, output, and health orchestration boundary.
- **Output Stream Session**: Async context-managed, per-turn facade owning one pipeline across all output branches, one successful flush, and unconditional close.

## Success Criteria

- **SC-001**: All existing agent-chat, crypto, guardrail, runner, SSE, health, DAST, and holdout behavior tests pass without contract snapshot changes.
- **SC-002**: Census finds zero chat-to-gateway imports, zero attested-search `ChatModule` import, and zero production references to deleted guardrail symbols.
- **SC-003**: Exactly one production output path exists: runner → gateway → output pipeline; adversarial chunking leaks zero sensitive bytes.
- **SC-004**: All eight surviving layers run in the same order and retain response keys; tested invalid compositions fail startup.
- **SC-005**: Feature diff contains no Prisma/migration, endpoint catalog, dependency lockfile, or new external API change.
- **SC-006**: API lint/typecheck/build/tests and agent Ruff/focused/full applicable tests pass.

## Assumptions

- The approved grilling ADRs supersede older prose describing registry extensibility.
- Existing DTOs, Pydantic models, constants, telemetry contracts, and stored records remain authoritative.
- Delete `tool_schemas.py` only if implementation census proves no remaining consumer.
- Registry implementation tests may be replaced with behavior/boundary tests; external behavior assertions remain immutable.
