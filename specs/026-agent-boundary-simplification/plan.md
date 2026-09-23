# Implementation Plan: Agent Boundary Simplification

**Branch**: `codex/026-agent-boundary-simplification` | **Date**: 2026-09-23 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/026-agent-boundary-simplification/spec.md`

## Summary

Deliver two independently testable refactors. P1 moves agent-chat routes into a gateway module and relocates chat crypto intact into shared infrastructure. P2 removes Python registry/pipeline indirection so `GuardrailGateway` owns fixed, asserted input/tool layers and the output-stream lifecycle while preserving every external and security contract.

## Technical Context

**Language/Version**: Repository TypeScript/NestJS toolchain; Python 3.12-compatible agent

**Primary Dependencies**: Existing NestJS configuration/Prisma/cache modules and FastAPI guardrail classes; no new dependency

**Storage**: Existing PostgreSQL and Redis use unchanged; no schema or migration

**Testing**: Jest unit/API E2E; pytest unit/security/SSE/runner/lifecycle; repository lint/type gates

**Target Platform**: Existing API and agent server deployment targets

**Project Type**: Multi-service web application (`apps/api`, `apps/agent`)

**Performance Goals**: No route/streaming regression; no per-request dynamic layer sort

**Constraints**: Preserve HTTP/SSE, auth guards, encryption/AAD, layer order, disabled-config behavior, PII priority, buffering, and fail-closed outcomes

**Scale/Scope**: Two internal slices; no frontend, booking/payment, database, or provider changes

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Pre-Research Gate

| Principle | Result | Evidence |
|---|---|---|
| I. Flight-First | PASS | No new product scope or external dependency. |
| II. Deterministic Transaction Boundary | PASS | Agent remains advisory; booking/payment paths are untouched. |
| III. API Budget Discipline | PASS | No external calls change. |
| IV. Observability | PASS | Existing health, response-key, and safe logging contracts remain. |
| V. Incremental Delivery | PASS | P1 and P2 are independently testable/deployable. |
| Security | PASS | Auth, crypto/AAD, PII order/priority, and fail-closed behavior are explicit invariants. |
| Complexity | PASS | Speculative registry/dead paths are removed; new modules have one owner purpose. |

Pre-research result: **PASS**.

## Design

### P1: NestJS boundary

1. Move `AgentChatController` and `AgentChatAccessService` with tests to `apps/api/src/agent-gateway/agent-chat/`; add `AgentChatModule` importing `ChatModule`, `AgentAuthModule`, `PrismaModule`, and `CacheModule`.
2. Register it from `AgentGatewayModule`; do not duplicate registration in `AppModule`.
3. Move `ChatMessageCryptoService` with tests to `common/`; add `ChatMessageCryptoModule` as sole provider/export owner.
4. Make `ChatModule` import crypto, remove the `AgentAuthModule` source import and its imports-array entry, drop gateway controller/access providers, and export only `ChatService`. Add a static/module-metadata assertion that `apps/api/src/chat/chat.module.ts` contains no agent-gateway dependency.
5. Make attested flight search import crypto, not `ChatModule`; preserve decrypt/errors and keep `EncryptionService` separate.

### P2: Python boundary

1. `GuardrailGateway()` constructs the production input/tool tuples by default. A keyword-only private test seam (`_input_layers`, `_tool_layers`) permits explicit tuples; `assert_layer_order` requires exact expected length/type/order, unique layer keys, and every declared prerequisite key earlier in the same tuple. Invalid production or test composition raises during construction.
2. Preserve only the canonical `validate_tool_result`; inline tool-pipeline logic and apply the named `PIIScanner` to the original raw result—including schema-invalid extra fields—before returning schema failure so PII retains priority.
3. `stream_output(context, *, config, session_id)` is a factory for an async context-managed per-turn session facade. Its `__aenter__` creates one internal pipeline; `process_token()` spans all three output branches; one-shot `flush()` is explicit; idempotent `close()` never flushes; `__aexit__` calls `close()` on every exit. Move `OutputGuardrailBlockedError` to stable `guardrails.base`; prohibit external class/error imports from `output_pipeline.py`, while preserving the external stateless `payload_free_config` import. Preserve block `partial_response` unchanged.
4. Move `deterministic_pii_match`, `_is_output_guardrail_disabled`, and `approved_model_content()` together to `guardrails/pii.py`; make `output_pipeline.py` import both matcher and predicate and retain externally importable `payload_free_config`. Assert no duplicate definitions/import cycle, run lint, and census only prohibited pipeline-class/block-error imports—not helper imports.
5. Use one idempotent canonical factory/get-or-create path in `main.py` so module initialization and lifespan resolve the same `app.state.guardrail_gateway` instance. Production calls `GuardrailGateway()`; central fixtures use only the explicit injection seam. Constructor errors abort startup; `is_healthy()` checks post-construction runtime readiness only.
6. Remove only the SSE duplicate detector. After auth/access and the transport length guard, resolve and health-check the gateway; unavailable/degraded still returns the existing 503. With a healthy gateway, build the existing admission context and call `validate_input` exactly once before `get_redis_client()` or quota admission. Return the exact legacy single PII event immediately with zero Redis/quota calls. Pass the decision/data into `ChatController.stream(command, admission_decision=decision)` so the controller never revalidates; non-PII blocks retain their existing safe mapping after the existing quota path. Thus gateway 503 wins when unhealthy, while PII wins over Redis/quota failure when healthy.
7. Replace `test_registry.py` with gateway construction/order tests. Delete registry/dead pipelines after imports clear. Delete `tool_schemas.py` only after its lone test fallback migrates and no import remains.

## Exact Touchpoints

### P1

```text
apps/api/src/chat/{agent-chat.controller.ts,agent-chat-access.service.ts} -> move with specs
apps/api/src/chat/chat-message-crypto.service.ts                         -> move with spec
apps/api/src/chat/{chat.module.ts,chat.service.ts}
apps/api/src/agent-gateway/agent-chat/agent-chat.module.ts               -> create
apps/api/src/agent-gateway/agent-gateway.module.ts
apps/api/src/agent-gateway/attested-flight-search/{attested-flight-search.module.ts,attested-flight-search.service.ts,attested-flight-search.service.spec.ts,attested-flight-search.persistence.spec.ts}
apps/api/src/common/{chat-message-crypto.module.ts,chat-message-crypto.service.ts} -> create/move
apps/api/test/agent-chat-gateway.e2e-spec.ts
apps/api/test/{agent-gateway,chat,chat-plaintext-cleanup,chat-privacy-corpus,negative-privacy-audit,phase11d-cryptographic-audit,phase11e-continuous-reliability,privacy-and-telemetry-audit,rollback-matrix}.e2e-spec.ts
```

### P2 source

```text
apps/agent/src/agent/guardrails/{base.py,gateway.py,output_pipeline.py}
apps/agent/src/agent/guardrails/pii.py -> create
apps/agent/src/agent/guardrails/{registry.py,input_pipeline.py,tool_output_pipeline.py} -> delete
apps/agent/src/agent/guardrails/tool_schemas.py -> conditional delete after lone test migration
apps/agent/src/agent/{main.py,streaming/sse.py,chat_turn/controller.py,chat_turn/runner.py,graph/nodes.py,memory/manager.py}
apps/agent/src/agent/agents/{travel_assistant.py,general_agent.py,checkout_orchestrator.py}
```

### P2 tests

```text
apps/agent/tests/conftest.py
apps/agent/tests/test_{guardrails,chat_turn_runner,graph,tools,stream_session_control,stream_auth_budget,rollback_matrix,negative_privacy_audit,output_pipeline,output_guardrail_nemo,pipeline_parallelism,hard_stop,guardrail_logging,e2e_output_guardrails,sse_output_guardrail,sse,benchmark_output_pipeline,chaos_simulation}.py
apps/agent/tests/security/test_{registry,gateway,enforcement,input_layers,output_stream,model_output_boundary,memory_boundary,lifecycle,rollout,security_performance,tool_authority,tool_boundary,tool_integration,tool_layers}.py
```

Final targeted searches may add only files importing removed symbols; behavioral assertions remain unchanged.

## Project Structure

### Documentation (this feature)

```text
specs/026-agent-boundary-simplification/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/internal-boundaries.md
├── tasks.md
└── verification/                     # planned runtime evidence; not created during planning
```

### Source Code (repository root)

```text
apps/api/src/{agent-gateway/agent-chat,chat,common}/
apps/agent/src/agent/{guardrails,chat_turn,streaming,graph,agents,memory}/
```

**Structure Decision**: Keep existing services and move ownership to the narrowest existing subtree. Add no package, deployable, persistence layer, or dependency.

## Verification

1. Record every baseline and post-change command, exit code, timestamp, and census result under planned `specs/026-agent-boundary-simplification/verification/` when implementation begins.
2. Verify P1 alone with moved unit tests, affected API E2E, API lint/typecheck, and dependency searches.
3. Verify P2 alone with constructor/order, raw-result PII priority, disabled-config/import-cycle matrix, persistent stream session, exactly-once non-flushing close, stable block-exception import, exact pre-quota SSE PII mapping with zero Redis/quota calls, runner cleanup order, and security tests; then run the complete non-Redis agent suite and Ruff gates.
4. Run repository change-aware API/agent chains. Assert no Prisma/migration diff and no removed-symbol production import.

## Post-Design Constitution Check

| Principle | Result | Confirmation |
|---|---|---|
| I. Flight-First | PASS | Existing chat/agent internals only. |
| II. Deterministic Boundary | PASS | No transaction ownership change; order is explicit. |
| III. API Budget | PASS | No external call. |
| IV. Observability | PASS | Health, response keys, and safe logging remain. |
| V. Incremental Delivery | PASS | P1/P2 retain separate gates. |
| Security | PASS | Guards, crypto/AAD, disabled mode, PII priority, stream withholding, and fail-closed paths are frozen. |
| Complexity | PASS | Net removal of registry/DAG/dead pipelines. |

Post-design result: **PASS**. No exception or complexity waiver is required.
