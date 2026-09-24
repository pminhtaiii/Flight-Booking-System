# Tasks: Agent Boundary Simplification

**Input**: Design documents from `specs/026-agent-boundary-simplification/`

**Prerequisites**: `spec.md`, `plan.md`, `research.md`, `data-model.md`, `quickstart.md`, and `contracts/internal-boundaries.md`

**Tests**: Required by FR-019. Characterization and boundary tests must be updated before implementation and must demonstrate the intended ownership failure before the production move/collapse.

**Organization**: Tasks are grouped into two independently shippable user stories. US1 is the P1 MVP; US2 can be implemented and reverted independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel because it touches different files and does not depend on an incomplete task.
- **[Story]**: Used only in user-story phases.
- Every task names the exact file path(s) it changes or verifies.

---

## Phase 1: Setup (Baseline and Scope)

**Purpose**: Establish behavior and change-scope baselines before either refactor starts.

- [x] T001 Run the concrete pre-refactor NestJS unit, API E2E, lint, shared-types, typecheck, and build commands in `specs/026-agent-boundary-simplification/quickstart.md`; record command, timestamp, commit SHA, exit code, and concise output in planned `specs/026-agent-boundary-simplification/verification/api-baseline.md`.
- [x] T002 [P] Run the concrete pre-refactor Python focused guardrail, runner, SSE, security, Ruff, and non-Redis commands in `specs/026-agent-boundary-simplification/quickstart.md`; record command, timestamp, commit SHA, exit code, and concise output in planned `specs/026-agent-boundary-simplification/verification/agent-baseline.md`.
- [x] T003 [P] Capture the initial import/deletion census from `apps/api/src/`, `apps/api/test/`, `apps/agent/src/agent/`, and `apps/agent/tests/`, using the zero-result searches in `specs/026-agent-boundary-simplification/quickstart.md` as the post-change acceptance baseline.

---

## Phase 2: Foundational (Frozen Contracts)

**Purpose**: Freeze the shared behavioral constraints that both independently deployable slices must preserve.

**⚠️ CRITICAL**: Complete this phase before changing either ownership boundary.

- [x] T004 Reconcile characterization assertions with the frozen route, controller guard declaration/order (`AgentApiKeyGuard` followed by `ClaimTokenGuard`), the `/access/check` claim-guard bypass (accepting API key and `{ sub }` body without `X-User-Claim`), crypto, layer-order, response-key, stream-lifecycle, health, and compatibility contracts in `specs/026-agent-boundary-simplification/contracts/internal-boundaries.md`, `apps/api/test/agent-chat-gateway.e2e-spec.ts`, and `apps/agent/tests/security/test_characterization.py` without changing expected external behavior (contract reconciliation documented; characterization test suite assertions remain open and deferred to T010 and T017–T022 prior to production refactor).
- [x] T005 [P] Establish a diff guard for the no-schema/no-dependency scope by recording clean baselines for `apps/api/prisma/`, `pnpm-lock.yaml`, `apps/api/package.json`, and `apps/agent/pyproject.toml` (recorded with exact command, SHA-256 hash manifest, timestamp, and exit code in `specs/026-agent-boundary-simplification/verification/api-baseline.md` and `agent-baseline.md`).

**Checkpoint**: Existing behavior and prohibited change areas are explicit; either story may now proceed independently.

---

## Phase 3: User Story 1 - Restore the NestJS Agent Boundary (Priority: P1) 🎯 MVP

**Goal**: Move agent-authenticated chat persistence to the gateway edge and shared chat crypto to `common/` while preserving every HTTP and encryption contract.

**Independent Test**: Build and boot the API with only US1 applied; exercise every `/api/agent-gateway/chat/*` route, run crypto compatibility and affected E2E suites, and prove that `apps/api/src/chat/` has no gateway import and attested search no longer imports `ChatModule`.

### Tests for User Story 1

- [x] T006 [P] [US1] Move and update the controller characterization spec from `apps/api/src/chat/agent-chat.controller.spec.ts` to `apps/api/src/agent-gateway/agent-chat/agent-chat.controller.spec.ts`, preserving route bodies, statuses, controller-level guard declaration and order (`AgentApiKeyGuard`, `ClaimTokenGuard`), the `/access/check` bypass within `ClaimTokenGuard` (validating identity from `{ sub }` with API key only while session routes require `X-User-Claim`), fencing-header spellings, and `CHAT_SESSION_NOT_FOUND` mapping before moving the controller.
- [x] T007 [P] [US1] Move and update the access-service characterization spec from `apps/api/src/chat/agent-chat-access.service.spec.ts` to `apps/api/src/agent-gateway/agent-chat/agent-chat-access.service.spec.ts`, preserving ownership, cache, fencing, and fail-closed behavior before moving the service.
- [x] T008 [P] [US1] Move the crypto compatibility spec from `apps/api/src/chat/chat-message-crypto.service.spec.ts` to `apps/api/src/common/chat-message-crypto.service.spec.ts` and retain coverage for `CHAT_ENCRYPTION_KEY`, AES-256-GCM, 12-byte nonce, 16-byte tag, version `1`, hex envelopes, record-bound AAD, empty/corrupt envelopes, wrong key/version, and authentication failure.
- [x] T009 [P] [US1] Update attested-search crypto/module-boundary assertions in `apps/api/src/agent-gateway/attested-flight-search/attested-flight-search.service.spec.ts` and `apps/api/src/agent-gateway/attested-flight-search/attested-flight-search.persistence.spec.ts` to require the common crypto owner and reject `ChatModule`; add a static/module-metadata assertion for `apps/api/src/chat/chat.module.ts` proving no agent-gateway source import or imports-array dependency remains.
- [x] T010 [P] [US1] Strengthen the gateway HTTP characterization in `apps/api/test/agent-chat-gateway.e2e-spec.ts` to cover all seven `/api/agent-gateway/chat/*` routes, controller-level guard declaration and order (`AgentApiKeyGuard`, `ClaimTokenGuard`), the deliberate `/access/check` bypass within `ClaimTokenGuard` (asserting `/access/check` succeeds with API key and `{ sub }` body without `X-User-Claim`, while the other six routes require `X-User-Claim`), request/response/status parity, both fencing-header spellings, and unchanged not-found mapping.

### Implementation for User Story 1

- [x] T011 [US1] Move `ChatMessageCryptoService` from `apps/api/src/chat/chat-message-crypto.service.ts` to `apps/api/src/common/chat-message-crypto.service.ts`, create its sole provider/export owner in `apps/api/src/common/chat-message-crypto.module.ts`, and update `apps/api/src/chat/chat.service.ts` to consume the common path without changing crypto behavior.
- [x] T012 [P] [US1] Move `AgentChatController` and `AgentChatAccessService` from `apps/api/src/chat/agent-chat.controller.ts` and `apps/api/src/chat/agent-chat-access.service.ts` to `apps/api/src/agent-gateway/agent-chat/agent-chat.controller.ts` and `apps/api/src/agent-gateway/agent-chat/agent-chat-access.service.ts`, preserving controller-level `@UseGuards(AgentApiKeyGuard, ClaimTokenGuard)`, the `/access/check` bypass in `ClaimTokenGuard`, routes, DTOs, fencing, and error mapping.
- [x] T013 [US1] Create `AgentChatModule` with `ChatModule`, `AgentAuthModule`, `PrismaModule`, and `CacheModule` imports in `apps/api/src/agent-gateway/agent-chat/agent-chat.module.ts`, compose it once from `apps/api/src/agent-gateway/agent-gateway.module.ts`, and in `apps/api/src/chat/chat.module.ts` remove both the `AgentAuthModule` source import and imports-array entry plus edge controller/access providers so `ChatModule` imports `ChatMessageCryptoModule`, exports only `ChatService`, and passes the T009 zero-gateway-dependency assertion.
- [x] T014 [US1] Replace the broad chat dependency with `ChatMessageCryptoModule` and update crypto imports in `apps/api/src/agent-gateway/attested-flight-search/attested-flight-search.module.ts`, `apps/api/src/agent-gateway/attested-flight-search/attested-flight-search.service.ts`, `apps/api/src/agent-gateway/attested-flight-search/attested-flight-search.service.spec.ts`, and `apps/api/src/agent-gateway/attested-flight-search/attested-flight-search.persistence.spec.ts` while keeping `EncryptionService` separate.
- [x] T015 [US1] Update the nine crypto-import E2E consumers to the common owner in `apps/api/test/agent-gateway.e2e-spec.ts`, `apps/api/test/chat.e2e-spec.ts`, `apps/api/test/chat-plaintext-cleanup.e2e-spec.ts`, `apps/api/test/chat-privacy-corpus.e2e-spec.ts`, `apps/api/test/negative-privacy-audit.e2e-spec.ts`, `apps/api/test/phase11d-cryptographic-audit.e2e-spec.ts`, `apps/api/test/phase11e-continuous-reliability.e2e-spec.ts`, `apps/api/test/privacy-and-telemetry-audit.e2e-spec.ts`, and `apps/api/test/rollback-matrix.e2e-spec.ts`, and confirm `apps/api/test/agent-chat-gateway.e2e-spec.ts` resolves the moved edge module.
- [x] T016 [US1] Run the moved unit specs, attested-search specs, all ten affected E2E files, API lint, shared-types tests, TypeScript no-emit, and API build for `apps/api/src/agent-gateway/agent-chat/`, `apps/api/src/common/`, `apps/api/src/agent-gateway/attested-flight-search/`, `apps/api/test/`, and `packages/shared/`, then run the US1 import census from `specs/026-agent-boundary-simplification/quickstart.md`.

**Checkpoint**: US1 is independently buildable, deployable, reversible, and satisfies the P1 module/crypto boundary.

---

## Phase 4: User Story 2 - Make the Guardrail Gateway Authoritative (Priority: P2)

**Goal**: Collapse the speculative registry and dead orchestration wrappers into a fixed, startup-asserted gateway while preserving tool/input/output, SSE, health, and security behavior.

**Independent Test**: Apply US2 without US1; run focused gateway/input/tool/output/runner/SSE/security and holdout suites, prove only the gateway constructs the production output pipeline, and prove deleted symbols have no production references.

### Tests for User Story 2

- [x] T017 [US2] Replace registry implementation tests with `GuardrailGateway()` production-default and keyword-only test-injection coverage in `apps/agent/tests/security/test_registry.py` and `apps/agent/tests/security/test_gateway.py`; assert exact count/type/order, unique keys, prerequisite-before-dependent rules, constructor raises for missing/duplicate/reordered/wrong-type/unknown-or-late prerequisite composition, valid runtime readiness, and that `is_healthy()` never recovers an invalid constructor.
- [x] T018 [P] [US2] Rewrite the former `InputGuardrailPipeline` expectation in `apps/agent/tests/security/test_input_layers.py` to assert fixed gateway order, short-circuiting, fail-closed exceptions, unchanged response keys, and detection-only normalization that returns accepted non-Latin input unchanged.
- [x] T019 [P] [US2] Update tool authority/integration tests in `apps/agent/tests/security/test_tool_layers.py`, `apps/agent/tests/security/test_tool_authority.py`, `apps/agent/tests/security/test_tool_boundary.py`, and `apps/agent/tests/security/test_tool_integration.py` to exercise only `validate_tool_result`, sealed authority, batch behavior, and a named `PIIScanner` over the original raw schema-invalid result—including extra fields—so `GUARDRAIL_TOOL_PII` wins without tuple indexing.
- [x] T020 [P] [US2] Add persistent stream-session and runner coverage in `apps/agent/tests/security/test_output_stream.py`, `apps/agent/tests/security/test_model_output_boundary.py`, `apps/agent/tests/security/test_lifecycle.py`, and `apps/agent/tests/test_chat_turn_runner.py`: replace the live `runner.OutputGuardrailPipeline` patch with a fake gateway output-session and stable `agent.guardrails.base.OutputGuardrailBlockedError`; prove one pipeline spans all branches, flush/close semantics, unchanged partial response, and partial persistence → close → lease release across every cleanup path.
- [x] T021 [P] [US2] Preserve direct delegate coverage in `apps/agent/tests/test_output_pipeline.py`, `apps/agent/tests/test_output_guardrail_nemo.py`, `apps/agent/tests/test_pipeline_parallelism.py`, `apps/agent/tests/test_hard_stop.py`, `apps/agent/tests/test_guardrail_logging.py`, `apps/agent/tests/test_e2e_output_guardrails.py`, `apps/agent/tests/test_sse_output_guardrail.py`, `apps/agent/tests/test_benchmark_output_pipeline.py`, and `apps/agent/tests/security/test_security_performance.py`; update block-error imports to `agent.guardrails.base`, require `output_pipeline.py` to import both matcher and disabled predicate from `pii.py`, cover streaming-disabled behavior, and add no-duplicate/import-cycle plus lint assertions without making the delegate public orchestration.
- [x] T022 [P] [US2] Update `apps/agent/tests/test_sse.py` and controller-focused coverage for `apps/agent/src/agent/chat_turn/controller.py`: after length and healthy-gateway checks SSE calls validation once before Redis/quota; PII makes zero Redis/budget calls and emits one first-and-only event named `error` with code `GUARDRAIL_BLOCKED`, message `Your message contains protected personal information and cannot be processed.`, and `partialMessageId: null`; unhealthy gateway keeps existing 503 precedence, healthy-gateway PII beats Redis failure, supplied non-PII decision/data prevents controller revalidation, and existing non-PII mapping remains.
- [x] T023 [US2] After T021, update the shared `apps/agent/tests/test_e2e_output_guardrails.py` coverage for `agent.guardrails.pii`: cover enabled/default PII, safe/non-string inputs, every legacy disabled shape, streaming-disabled predicate use, exactly one definition of matcher/predicate/utility, import-cycle absence, and lint; retain cross-token delegate tests and migrate the lone fallback before evaluating `tool_schemas.py` deletion.

### Implementation for User Story 2

- [x] T024 [US2] Refactor `apps/agent/src/agent/guardrails/gateway.py` so `GuardrailGateway()` builds the production tuples, keyword-only private tuple injection supports tests, `assert_layer_order` enforces exact count/type/order, unique keys, and earlier same-stage prerequisites, invalid composition raises at construction, `is_healthy()` covers runtime readiness only, orchestration stays fail-closed, and the sole tool method remains `validate_tool_result` over original raw results.
- [x] T025 [US2] Implement `GuardrailGateway.stream_output(context, *, config, session_id)` as an async context-manager factory whose per-turn facade owns one pipeline, exposes `process_token`, one-shot `flush`, and idempotent non-flushing `close`, and whose `__aexit__` calls close without suppressing errors; move/export `OutputGuardrailBlockedError` from stable `apps/agent/src/agent/guardrails/base.py` and preserve its fields.
- [x] T026 [US2] Remove pipeline class/error imports and construction from `apps/agent/src/agent/chat_turn/runner.py` while retaining its permitted `payload_free_config` import from `output_pipeline.py`; import block errors from `agent.guardrails.base`, use one stream session across all branches, migrate the live `apps/agent/tests/test_chat_turn_runner.py` patch from `runner.OutputGuardrailPipeline` to a fake gateway output-session/stable base exception, and preserve partial persistence → close → lease release at every cleanup call site.
- [x] T027 [P] [US2] Create `apps/agent/src/agent/guardrails/pii.py` as the sole owner of `deterministic_pii_match`, `_is_output_guardrail_disabled`, and `approved_model_content`; update five batch callers, make `output_pipeline.py` import both matcher and predicate while retaining `payload_free_config`, remove duplicate definitions, and prove all disabled shapes, no import cycle, and lint.
- [x] T028 [P] [US2] In `apps/agent/src/agent/streaming/sse.py`, after length and gateway health but before Redis/quota, build the existing admission context and call `validate_input` exactly once; on PII return one `error` event with code `GUARDRAIL_BLOCKED`, message `Your message contains protected personal information and cannot be processed.`, and `partialMessageId: null` with zero Redis/quota calls; retain gateway 503 and healthy-PII precedence, pass stored decision/data to `ChatController.stream` to prevent a second call, preserve non-PII mapping, and remove only the duplicate detector/import.
- [x] T029 [US2] Add one idempotent canonical factory/get-or-create path in `apps/agent/src/agent/main.py` so module-load and lifespan calls resolve one cached `GuardrailGateway()` instance, production constructor failure aborts startup, and the central `apps/agent/tests/conftest.py` fixture uses the explicit test seam rather than a registry.
- [x] T030 [US2] Migrate the registry-constructor fixture cluster to `GuardrailGateway()` for production-like cases or keyword-only tuple injection for composition tests in `apps/agent/tests/security/test_enforcement.py`, `apps/agent/tests/security/test_gateway.py`, `apps/agent/tests/security/test_input_layers.py`, `apps/agent/tests/security/test_lifecycle.py`, `apps/agent/tests/security/test_memory_boundary.py`, `apps/agent/tests/security/test_model_output_boundary.py`, `apps/agent/tests/security/test_registry.py`, `apps/agent/tests/security/test_rollout.py`, `apps/agent/tests/security/test_security_performance.py`, `apps/agent/tests/security/test_tool_authority.py`, `apps/agent/tests/security/test_tool_boundary.py`, `apps/agent/tests/security/test_tool_integration.py`, `apps/agent/tests/security/test_tool_layers.py`, `apps/agent/tests/test_chaos_simulation.py`, `apps/agent/tests/test_chat_turn_runner.py`, `apps/agent/tests/test_graph.py`, `apps/agent/tests/test_guardrails.py`, `apps/agent/tests/test_negative_privacy_audit.py`, `apps/agent/tests/test_rollback_matrix.py`, `apps/agent/tests/test_stream_auth_budget.py`, `apps/agent/tests/test_stream_session_control.py`, and `apps/agent/tests/test_tools.py`; assert no test treats `is_healthy()` as constructor recovery.
- [x] T031 [US2] Delete `apps/agent/src/agent/guardrails/registry.py` including `OutputPIILayer`, plus `input_pipeline.py` and `tool_output_pipeline.py`, only after all callers/tests migrate and a symbol census proves no `OutputPIILayer` reference; delete `tool_schemas.py` only if its migrated fallback and repository census prove no consumer.
- [x] T032 [US2] Run the focused gateway/input/tool/output/runner/SSE/security suites and the remaining affected holdouts in `apps/agent/tests/test_guardrails.py`, `apps/agent/tests/test_graph.py`, `apps/agent/tests/test_tools.py`, `apps/agent/tests/test_stream_session_control.py`, `apps/agent/tests/test_stream_auth_budget.py`, `apps/agent/tests/test_rollback_matrix.py`, `apps/agent/tests/test_negative_privacy_audit.py`, `apps/agent/tests/test_chaos_simulation.py`, `apps/agent/tests/security/test_memory_boundary.py`, `apps/agent/tests/security/test_rollout.py`, and `apps/agent/tests/security/test_enforcement.py`, then run Ruff and the full non-Redis suite for `apps/agent/`.

**Checkpoint**: US2 is independently buildable, deployable, reversible, and has one auditable production orchestration path.

---

## Phase 5: Polish & Cross-Cutting Verification

**Purpose**: Prove both slices integrate without scope drift and synchronize project documentation after implementation.

- [x] T033 Run exact post-change censuses over API/agent source and tests to prove zero chat-to-gateway imports, zero attested-search `ChatModule` imports, zero old crypto imports, zero references to removed registry symbols, exactly one matcher/predicate/approved-content definition in `pii.py`, production pipeline construction only in `guardrails/gateway.py`, and zero external imports of `OutputGuardrailPipeline` or `OutputGuardrailBlockedError` from `output_pipeline.py`; explicitly allow external `payload_free_config` imports.
- [x] T034 [P] Confirm the final diff has no persistent-schema, migration, endpoint-catalog, dependency, feature-flag, or external-API changes in `apps/api/prisma/`, `apps/api/package.json`, `apps/agent/pyproject.toml`, `pnpm-lock.yaml`, `apps/api/src/app.module.ts`, and `apps/agent/src/agent/main.py`.
- [x] T035 Update ownership, dependency direction, fixed guardrail sequences, and the authoritative runner-to-gateway-to-output-pipeline flow in `context/architecture.md` after US1 and US2 implementation is complete.
- [x] T036 Update completed task/status, independent verification evidence, remaining risks, and rollback boundaries in `context/progress-checker.md` after implementation and test gates pass.
- [x] T037 Execute the complete API and agent change-aware verification matrix from `context/workflow.md` plus both independent quickstart checks in `specs/026-agent-boundary-simplification/quickstart.md`, and confirm final exit codes and census results before merge.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies; establishes reproducible baselines.
- **Foundational (Phase 2)**: Depends on Phase 1 and blocks story implementation.
- **US1 (Phase 3)**: Depends only on Phase 2; this is the MVP and can ship independently.
- **US2 (Phase 4)**: Depends only on Phase 2; it does not depend on US1 and can ship independently.
- **Polish (Phase 5)**: T033-T034 follow the implemented stories selected for release; T035-T037 follow completion of both stories.

### User Story Dependency Graph

```text
Phase 1 Setup
      |
Phase 2 Frozen Contracts
      |----------------------|
      v                      v
US1 NestJS Boundary      US2 Python Gateway
      |                      |
      |----------------------|
                 v
        Cross-cutting Verification
```

### Within User Story 1

1. T006-T010 update/move tests first and expose broken ownership imports.
2. T011 and T012 can proceed in parallel after the test moves.
3. T013 depends on T011-T012; T014 depends on T011; T015 depends on the common crypto path from T011.
4. T016 verifies the complete, independently deployable P1 slice.

### Within User Story 2

1. T017-T022 establish the desired boundary and behavior in parallel where marked; T023 follows T021 because both edit `apps/agent/tests/test_e2e_output_guardrails.py`.
2. T024 establishes the fixed gateway and blocks T025, T029-T031.
3. T025 blocks T026; T027 and T028 can proceed in parallel with that stream work.
4. T029-T030 migrate construction/callers before T031 deletes obsolete modules.
5. T032 verifies the complete, independently deployable P2 slice.

---

## Parallel Examples

### User Story 1

```text
Parallel test preparation:
- T006 move controller characterization
- T007 move access-service characterization
- T008 move crypto compatibility coverage
- T009 update attested-search boundary coverage
- T010 strengthen agent-chat gateway E2E coverage

Parallel implementation after tests:
- T011 move shared crypto and add its module
- T012 move the gateway controller/access service
```

### User Story 2

```text
Parallel test preparation after T017:
- T018 rewrite input/order/normalization expectations
- T019 update tool authority and PII-priority coverage
- T020 add gateway stream lifecycle and runner coverage
- T021 preserve delegate tests and prove imported matcher/predicate ownership
- T022 prove pre-quota single validation and exact legacy PII event ordering

Parallel implementation after T024:
- T027 move matcher, disabled predicate, approved_model_content, and five callers
- T028 move single gateway admission before quota and remove the duplicate detector
```

After the parallel test-preparation group, run T023 following T021 to avoid overlapping edits in `apps/agent/tests/test_e2e_output_guardrails.py`.

---

## Implementation Strategy

### MVP First: User Story 1

1. Complete T001-T005 to freeze the baseline and scope.
2. Complete T006-T016 in dependency order.
3. Stop and validate US1 independently: API boot/build, moved unit specs, attested specs, ten affected E2E files, and import census.
4. Ship or revert the NestJS slice without waiting for Python changes.

### Incremental Delivery

1. Deliver US1 as the P1 module/crypto-boundary MVP.
2. Deliver US2 separately after T017-T032 pass the focused and full agent gates.
3. Complete T033-T037 only after the selected slices are integrated; documentation must describe implemented state, not planned state.

### Parallel Team Strategy

1. Complete setup/foundational tasks together.
2. Assign one worker to T006-T016 and another to T017-T032 because the stories touch separate services.
3. Within each story, parallelize only the tasks explicitly marked `[P]`; serialize module composition, caller migration, deletion, and final verification.

---

## Notes

- Preserve `validate_tool_result` as the sole public tool-result method; do not introduce an alias.
- Do not add a package, database migration, persistent schema, endpoint, feature flag, dependency, normalization pass, or external API change.
- Keep direct `OutputGuardrailPipeline` unit tests. External production code may import `payload_free_config` from `output_pipeline.py`, but may not import/construct the pipeline class or import its block error there.
- Treat deletion of `apps/agent/src/agent/guardrails/tool_schemas.py` as conditional on both fallback migration and a zero-consumer census.
- Commit and verify US1 and US2 as separate reversible slices.
