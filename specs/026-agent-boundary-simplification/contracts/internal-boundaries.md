# Internal Boundary Contracts

These contracts freeze behavior while ownership changes; they define no new public API.

## Agent-chat HTTP boundary

Base path: `/agent-gateway/chat`. Controller-level guard declaration and order retain `AgentApiKeyGuard` followed by `ClaimTokenGuard`. As in existing production code, `ClaimTokenGuard` deliberately bypasses `/access/check` (`/chat/access/check`), allowing requests to supply only `X-Agent-API-Key` and `{ sub }` body without `X-User-Claim`; `AgentChatAccessService` validates identity and token status from that body. All remaining six session routes require a valid `X-User-Claim`.

| Method | Relative path | Authentication & Guard Behavior |
|---|---|---|
| POST | `/access/check` | `AgentApiKeyGuard` + `ClaimTokenGuard` (bypassed in guard; accepts API key + `{ sub }` body without `X-User-Claim`) |
| POST | `/sessions` | `AgentApiKeyGuard` + `ClaimTokenGuard` (requires `X-User-Claim`) |
| GET | `/sessions/:sessionId/memory` | `AgentApiKeyGuard` + `ClaimTokenGuard` (requires `X-User-Claim`) |
| POST | `/sessions/:sessionId/messages` | `AgentApiKeyGuard` + `ClaimTokenGuard` (requires `X-User-Claim`) |
| POST | `/sessions/:sessionId/turns` | `AgentApiKeyGuard` + `ClaimTokenGuard` (requires `X-User-Claim`) |
| POST | `/sessions/:sessionId/summaries` | `AgentApiKeyGuard` + `ClaimTokenGuard` (requires `X-User-Claim`) |
| DELETE | `/sessions/:sessionId` | `AgentApiKeyGuard` + `ClaimTokenGuard` (requires `X-User-Claim`) |

DTOs, claims, ownership/access checks, fencing behavior, statuses, and bodies remain unchanged.

## Chat crypto boundary

`ChatMessageCryptoService` is owned/exported by `ChatMessageCryptoModule` and consumed by `ChatService` and `AttestedFlightSearchService`. Frozen properties are `CHAT_ENCRYPTION_KEY`, `{ ciphertext, nonce, authTag, keyVersion }`, current algorithms/errors, and AAD construction/verification. It never falls back to or merges with `EncryptionService`.

## Guardrail gateway boundary

Caller-facing contracts remain:

- `validate_input(context, message) -> PipelineDecision[ValidatedInput]`
- current tool execution/batch methods and sole tool-result method `validate_tool_result(context, tool_name, result) -> PipelineDecision[ValidatedToolResult]`; no alternate alias
- `stream_output(context, *, config, session_id) -> OutputStreamSession`, where the result is an async context manager
- `is_healthy() -> bool`

Registry/pipeline types are internal and removable.

### Fixed input order

1. `LengthValidator`
2. `PIIDetector`
3. `InjectionDetector`
4. `TopicBoundary`

### Fixed tool order

1. `SizeStructureValidator`
2. `SchemaValidator`
3. `PIIScanner`
4. `UntrustedContentInjectionDetector`

Production construction is `GuardrailGateway()` with no registry argument. A keyword-only private injection seam (`_input_layers`, `_tool_layers`) exists for tests only. `assert_layer_order(stage, layers, expected_types)` requires the exact expected count and type at every position, unique layer keys, and every declared prerequisite key earlier in the same tuple; missing, duplicate, reordered, wrongly typed, unknown prerequisite, or later prerequisite raises during construction. Production startup therefore aborts before serving traffic. `is_healthy()` checks only post-construction runtime readiness and cannot recover or represent an invalid constructor.

If schema and PII both block, the named PII scan receives the original raw tool result, including schema-invalid extra fields, and `GUARDRAIL_TOOL_PII` wins over `GUARDRAIL_TOOL_SCHEMA`; no numeric index encodes this rule.

### Persistent output stream session

`ChatTurnRunner` enters one `async with gateway.stream_output(context, config=output_config, session_id=session_id) as stream` block per turn. The returned facade:

- constructs and owns exactly one `OutputGuardrailPipeline` in `__aenter__`;
- exposes `process_token(token) -> AsyncIterator[str]` to all three existing runner model-output branches, preserving one shared `ChunkBuffer` and `partial_response`;
- exposes `flush() -> AsyncIterator[str]`, callable exactly once after successful model-output completion;
- exposes idempotent `close()`, which closes but never flushes or emits buffered data;
- calls `close()` from `__aexit__` on normal completion, block, cancellation, or any other exception;
- returns false from `__aexit__`/otherwise never suppresses exceptions, and re-raises `OutputGuardrailBlockedError` with the original `partial_response`, `layer`, `rule`, and message unchanged.

`OutputGuardrailBlockedError` is owned/exported by stable `agent.guardrails.base`. External production callers MUST NOT import or construct `OutputGuardrailPipeline`, or import `OutputGuardrailBlockedError`, from `output_pipeline.py`. They MAY continue importing the retained stateless `payload_free_config` helper from `output_pipeline.py`; that helper is not an orchestration bypass. At `_finalize_cleanup`, normal completion, block, early-return/error, cancellation, and final defensive cleanup call sites, effective ordering is approved-partial persistence → idempotent non-flushing close → lease release. Successful completion flushes once before persistence; early block/cancel/error never flushes. Repeated close requests are safe and have one effective close.

### Input PII compatibility mapping

Ingress order in `apps/agent/src/agent/streaming/sse.py` is fixed: authentication/access check → transport length guard → gateway obtain/type/health check → construct existing `AdmissionContext` → one `GuardrailGateway.validate_input` call → Redis/quota admission for non-PII decisions only. An absent/degraded gateway returns the existing `GUARDRAIL_GATEWAY_UNAVAILABLE` 503 before validation or Redis. With a healthy gateway, a PII decision takes precedence over Redis/quota availability, consumes no quota, and makes zero Redis calls.

`validate_input` is the sole ingress PII detector and returns `response_key=GUARDRAIL_INPUT_PII`. SSE immediately translates that key to the legacy response formerly emitted by its duplicate detector:

- event name: `error`;
- data code: `GUARDRAIL_BLOCKED`;
- data message: `Your message contains protected personal information and cannot be processed.`;
- `partialMessageId`: `null`;
- event ordering: first and only event, followed by immediate return.

SSE returns immediately after that first and only event. For non-PII decisions, it retains the decision and `validated_data`, completes the existing Redis/quota path, then calls `ChatController.stream(command, admission_decision=decision)`. The controller MUST use the supplied decision/data and MUST NOT call `validate_input` again; other block keys retain their existing safe mapping.

## Stateless PII utility

`guardrails/pii.py` owns the only definitions of `deterministic_pii_match`, `_is_output_guardrail_disabled`, and `approved_model_content(content, config=None)`. `output_pipeline.py` imports both matcher and predicate from `pii.py` and keeps `payload_free_config`, so the dependency is acyclic. Disabled behavior remains true for every existing shape: top-level object `.enabled`, nested object `.output_guardrail.enabled`, top-level mapping `enabled`, nested mapping/object `output_guardrail.enabled`, and mapping `configurable.enabled` or `configurable.output_guardrail.enabled`. Tests cover each shape, enabled/default PII, safe/non-string content, streaming-disabled behavior, cross-token matching, zero duplicate definitions, import-cycle absence, and lint. The utility is not an orchestration bypass.

## Application construction

`apps/agent/src/agent/main.py` owns one idempotent factory/get-or-create function that constructs `GuardrailGateway()` only when `app.state.guardrail_gateway` is absent. Module initialization and lifespan call the same path and resolve the same instance; constructor failure aborts startup. Tests may replace state explicitly or use the private tuple seam, but production never injects layers.

## Compatibility exclusions

HTTP/SSE contracts, auth, encrypted storage, layer implementations, normalization internals, persistent schemas, and booking/payment boundaries do not change.
