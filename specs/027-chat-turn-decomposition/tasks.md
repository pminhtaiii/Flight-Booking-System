# Tasks: Chat Turn Decomposition

**Input**: [spec.md](./spec.md), [plan.md](./plan.md), [research.md](./research.md), [data-model.md](./data-model.md), [internal contracts](./contracts/chat-turn-internal.md), [quickstart.md](./quickstart.md).
**Tests**: Required by FR-012; write a failing focused behavior test before each extraction.
**Organization**: Story phases are independently verifiable; complete phases in order except memory test/implementation may proceed alongside interpreter work in different files.

## Phase 1: Setup and event transport boundary

- [x] T001 Characterize exact `format_sse` bytes and current domain event payloads in `apps/agent/tests/test_chat_turn_events.py` and `apps/agent/tests/characterization/test_sse_characterization.py`.
- [x] T002 Move `format_sse` from `apps/agent/src/agent/chat_turn/events.py` to `apps/agent/src/agent/streaming/sse.py`, updating imports/exports in those files and `apps/agent/tests/test_chat_turn_events.py`.
- [x] T003 Run `apps/agent/tests/test_chat_turn_events.py` and `apps/agent/tests/characterization/test_sse_characterization.py`; record exact byte parity in `specs/027-chat-turn-decomposition/verification.md`.

## Phase 2: Foundational graph behavior baseline

- [x] T004 Add synthetic graph fixtures covering `on_chain_end` validated tool messages, `on_tool_end` timing-only events, accepted ToolResultEvent-before-specialized order, and invalid-readiness no-ToolResultEvent to `apps/agent/tests/test_chat_turn_runner.py`.
- [x] T005 Add model stream, model-end fallback, final-node fallback, and chunk-dedup assertions to `apps/agent/tests/test_chat_turn_runner.py` before extraction.

## Phase 3: User Story 1 - Isolate graph event translation (P1)

**Goal**: Tool-name-agnostic translation with domain projections owned by resolver.
**Independent test**: Fake graph stream/resolver yields current event sequence without live model, Redis, or NestJS.

- [x] T006 [P] [US1] Write resolver tests for validated search snapshots, readiness summary/block decisions, and all three handoff node-completion outputs including HANDOFF_FAILED and force-persistence in `apps/agent/tests/test_tool_result_resolver.py`.
- [x] T007 [US1] Implement the tool-resolution and typed handoff-node-completion operations in `apps/agent/src/agent/chat_turn/resolver.py`, consuming validated `tools` chain-end messages or the three existing handoff chain-end outputs and preserving safe block decisions.
- [x] T008 [US1] Write interpreter tests for model-token fallbacks/dedup, accepted tool-call/result/follow-up order, invalid-readiness no-ToolResultEvent, resolver invocation count, handoff-node routing/failure, and timing-only `on_tool_end` in `apps/agent/tests/test_chat_turn_interpreter.py`.
- [x] T009 [US1] Implement GraphEventInterpreter in `apps/agent/src/agent/chat_turn/interpreter.py` with no tool-name branching, Redis/NestJS call, or guardrail construction.
- [x] T010 [US1] Wire the interpreter into `apps/agent/src/agent/chat_turn/runner.py`, catching typed projection-block decisions for existing cleanup, passing every raw TokenEvent through the existing single OutputStreamSession, and retaining approved partial-response accounting.
- [x] T011 [US1] Run resolver, interpreter, runner, snapshot, and stream-session focused suites from `specs/027-chat-turn-decomposition/quickstart.md`; record event parity in `specs/027-chat-turn-decomposition/verification.md`.

## Phase 4: User Story 2 - Coordinate conversation memory (P2)

**Goal**: One safe context and compaction interface over existing mechanisms.
**Independent test**: Fake backend/gateway/manager reproduces history selection, unsafe handling, and summarization trigger.

- [x] T012 [P] [US2] Write context-fetch, window/offset, unsafe-summary/history, exact AdmissionContext identity/policy forwarding, and `totalMessageCount + 2` compaction tests in `apps/agent/tests/test_conversation_memory.py`.
- [x] T013 [US2] Implement `ConversationMemory.get_context(session_id, client, admission_context)` and `schedule_compaction` in `apps/agent/src/agent/memory/conversation.py`, delegating to existing NestJSClient, GuardrailGateway, and `apps/agent/src/agent/memory/manager.py`.
- [x] T014 [US2] Replace inline memory fetch/re-scan and compaction scheduling in `apps/agent/src/agent/chat_turn/runner.py` with ConversationMemory calls; preserve direct runner fallback behavior.
- [x] T015 [US2] Run `apps/agent/tests/test_conversation_memory.py`, `apps/agent/tests/test_memory.py`, and `apps/agent/tests/test_chat_turn_runner.py`; record parity in `specs/027-chat-turn-decomposition/verification.md`.

## Phase 5: User Story 3 - Reuse ordered admission (P3)

**Goal**: Reusable auth, input, and quota services with thin FastAPI wrappers.
**Independent test**: PII block uses zero Redis/quota; valid input reaches runner once; gateway outage and SSE responses remain unchanged.

- [ ] T016 [P] [US3] Write admission ordering and gateway-unavailable/PII/quota tests in `apps/agent/tests/test_chat_admission.py`, including a one-scan assertion through `apps/agent/tests/test_chat_controller.py`.
- [ ] T017 [US3] Create `apps/agent/src/agent/admission/__init__.py` and extract JWT decode and NestJS access rules from `apps/agent/src/agent/streaming/sse.py` into `apps/agent/src/agent/admission/auth.py`.
- [ ] T018 [US3] Extract length/gateway-health and input validation with existing deterministic PII fallback into `apps/agent/src/agent/admission/input_admission.py`.
- [ ] T019 [US3] Extract Redis daily/burst quota admission into `apps/agent/src/agent/admission/quota.py` without changing accounting.
- [ ] T020 [US3] Add ordered thin FastAPI dependency wrappers and reduce transport policy code in `apps/agent/src/agent/streaming/sse.py`; pass the existing validated decision through `apps/agent/src/agent/chat_turn/controller.py` to the runner.
- [ ] T021 [US3] Run `apps/agent/tests/test_chat_admission.py`, `apps/agent/tests/test_sse.py`, `apps/agent/tests/test_chat_controller.py`, and `apps/agent/tests/test_stream_auth_budget.py`; record zero-Redis and single-scan results in `specs/027-chat-turn-decomposition/verification.md`.

## Phase 6: User Story 4 - Expose a sequential lifecycle (P4)

**Goal**: Focused turn coordinator with unchanged output, persistence, and lease behavior.
**Independent test**: Existing successful, blocked, cancelled, stale-fence, and exception scenarios preserve events and cleanup order.

- [ ] T022 [US4] Extend normal, invalid-readiness block, handoff failure, cancellation, stale-fence ActionRequiredEvent/ActionHandoffEvent suppression, and exception cleanup assertions in `apps/agent/tests/test_chat_turn_runner.py` and `apps/agent/tests/test_stream_session_control.py` before moving lifecycle code.
- [ ] T023 [US4] Extract sequential TurnSessionCoordinator ownership within `apps/agent/src/agent/chat_turn/runner.py`, retaining session bootstrap, lease/fencing, snapshot load, persistence, one output-session flush/close, and background compaction.
- [ ] T024 [US4] Keep `apps/agent/src/agent/chat_turn/controller.py` and `apps/agent/src/agent/streaming/sse.py` integration signatures compatible; run `apps/agent/tests/test_sse_integration.py` and `apps/agent/tests/test_chat_turn_runner.py` for event and error parity.

## Phase 7: Polish and cross-cutting verification

- [ ] T025 Verify `apps/agent/src/agent/chat_turn/interpreter.py` has no tool-name checks or guardrail construction and `apps/agent/src/agent/chat_turn/events.py` has no `format_sse` using the censuses in `specs/027-chat-turn-decomposition/quickstart.md`.
- [ ] T026 Run Ruff check/format and the full non-Redis agent pytest gate from `specs/027-chat-turn-decomposition/quickstart.md`; record exit codes in `specs/027-chat-turn-decomposition/verification.md`.
- [ ] T027 Update `context/architecture.md` and `context/progress-checker.md` with the implemented boundaries and verified task status; do not mark planned work complete before the gate passes.

## Dependencies

`T001–T005` → US1 (`T006–T011`) → US4 (`T022–T024`). US2 (`T012–T015`) can begin after the baseline and run in parallel with US1 until both touch `runner.py`; merge US1 runner wiring before T014. US3 (`T016–T021`) is independent of US1/US2 until final coordinator integration. US4 starts after all three seams. Polish follows all stories.

## Parallel execution examples

- After T005, T006 in `test_tool_result_resolver.py` and T012 in `test_conversation_memory.py` can run in parallel.
- After US1, T016 admission tests in `test_chat_admission.py` and T012 memory tests can run in parallel; coordinate runner edits sequentially.

## Implementation strategy

MVP is US1 after the formatter/setup steps: the graph event loop is isolated and tested. Deliver US2 and US3 as separate working slices, then US4 as the lifecycle consolidation. Keep the existing service deployable and test-gated after every extraction step.
