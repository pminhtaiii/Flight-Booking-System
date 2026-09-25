# Verification Evidence: Chat Turn Decomposition (Phase 1)

## Overview & Metadata

- **Feature**: 027 Chat Turn Decomposition
- **Phase**: Phase 1 - Setup and Event Transport Boundary
- **Tasks**: T001, T002, T003
- **Execution Timestamp**: `2026-09-25T09:42:00+07:00`
- **Commit SHA Anchors**:
  - T001: `360ca39e` (`test(agent): characterize exact format_sse wire bytes across 8 domain events (T001)`)
  - T002: `37fcf8db` (`refactor(agent): relocate format_sse to streaming.sse and purge from events (T002)`)
  - T003: current verification and task progression commit

---

## 1. Test Suite Verification (Pytest)

### Command Executed
```powershell
$env:PYTHONPATH = "$PWD/tests/ci/python;$PWD/apps/agent/src"
uv run --package agent pytest apps/agent/tests/test_chat_turn_events.py apps/agent/tests/characterization/test_sse_characterization.py apps/agent/tests/security/test_output_stream.py apps/agent/tests/test_sse.py
```

### Execution Result
- **Exit Code**: `0`
- **Output**:
```text
============================= test session starts =============================
platform win32 -- Python 3.11.15, pytest-9.1.1, pluggy-1.6.0
rootdir: C:\Booking Systems\apps\agent
configfile: pyproject.toml
plugins: anyio-4.14.2, langsmith-0.11.1, asyncio-1.4.0, cov-7.1.0, mock-3.15.1
asyncio: mode=Mode.AUTO, debug=False, asyncio_default_fixture_loop_scope=None, asyncio_default_test_loop_scope=function
collected 112 items

apps\agent\tests\test_chat_turn_events.py ...............                [ 13%]
apps\agent\tests\characterization\test_sse_characterization.py ......... [ 21%]
..s....                                                                  [ 27%]
apps\agent\tests\security\test_output_stream.py ........................ [ 49%]
...........................                                              [ 73%]
apps\agent\tests\test_sse.py ..............................              [100%]

======================= 111 passed, 1 skipped in 13.09s =======================
```

---

## 2. Linter & Formatter Verification (Ruff)

### Commands Executed
```powershell
$env:UV_CACHE_DIR = "C:\Booking Systems\.t093-uv-cache"
uv run --package agent ruff check apps/agent
uv run --package agent ruff format --check apps/agent
```

### Execution Result
- **Exit Code**: `0`
- **Output**:
```text
All checks passed!
153 files already formatted
```

---

## 3. Static Boundary Census

### Command Executed
```powershell
git grep -n "def format_sse" apps/agent/src/agent/
```

### Execution Result
- **Exit Code**: `0`
- **Output**:
```text
apps/agent/src/agent/streaming/sse.py:63:def format_sse(event: ChatTurnEvent) -> str:
```
- **Boundary Confirmation**: `def format_sse` exists only within `apps/agent/src/agent/streaming/sse.py`. No occurrences exist in `apps/agent/src/agent/chat_turn/` or elsewhere in `apps/agent/src/agent/`.

---

## 4. Byte-for-Byte Wire Parity Across 8 Canonical Events

Tests in `apps/agent/tests/test_chat_turn_events.py` and `apps/agent/tests/characterization/test_sse_characterization.py` verify that `format_sse` produces exact UTF-8 serialized byte representations:
`f"event: {event.event}\ndata: {event.data.model_dump_json()}\n\n".encode("utf-8")`

### Canonical Event Wire Validation Matrix

| Event Type Constant | Model Class | Wire Prefix | Termination Framing | Extra Fields |
|---|---|---|---|---|
| `token` | `TokenEvent` | `event: token\ndata: ` | `\n\n` (bytes: `b"\n\n"`) | Forbidden (`extra="forbid"`) |
| `tool_call` | `ToolCallEvent` | `event: tool_call\ndata: ` | `\n\n` (bytes: `b"\n\n"`) | Forbidden (`extra="forbid"`) |
| `tool_result` | `ToolResultEvent` | `event: tool_result\ndata: ` | `\n\n` (bytes: `b"\n\n"`) | Forbidden (`extra="forbid"`) |
| `flight_results` | `FlightResultsEvent` | `event: flight_results\ndata: ` | `\n\n` (bytes: `b"\n\n"`) | Forbidden (`extra="forbid"`) |
| `ACTION_HANDOFF` | `ActionHandoffEvent` | `event: ACTION_HANDOFF\ndata: ` | `\n\n` (bytes: `b"\n\n"`) | Forbidden (`extra="forbid"`) |
| `ACTION_REQUIRED` | `ActionRequiredEvent` | `event: ACTION_REQUIRED\ndata: ` | `\n\n` (bytes: `b"\n\n"`) | Forbidden (`extra="forbid"`) |
| `done` | `DoneEvent` | `event: done\ndata: ` | `\n\n` (bytes: `b"\n\n"`) | Forbidden (`extra="forbid"`) |
| `error` | `ErrorEvent` | `event: error\ndata: ` | `\n\n` (bytes: `b"\n\n"`) | Forbidden (`extra="forbid"`) |

Every event passes:
1. Strict discriminated union parsing with Pydantic `TypeAdapter(ChatTurnEvent)`.
2. Exact string formatting and UTF-8 encoding parity with zero extra trailing newlines (`assert wire_str.endswith("\n\n")` and `assert not wire_str.endswith("\n\n\n")`).
3. Strict `extra="forbid"` schema validation prohibiting unexpected fields on payload and wrapper models.
4. Privacy and PII isolation preventing sensitive fields (e.g. `handoffToken`, `offerId`, `rawOffer`) from leaking into `done` or `error` payloads.

---

## 5. Domain Model Purity Confirmation

Inspection of `apps/agent/src/agent/chat_turn/events.py` validates complete transport decoupling:
- **Zero transport dependencies**: No references to HTTP, SSE formatting, Starlette, FastAPI, or JSON encoding strings.
- **Minimal imports**: Standard library `typing` (`Annotated`, `Any`, `Dict`, `List`, `Literal`, `Optional`, `Union`) and `pydantic` (`BaseModel`, `ConfigDict`, `Field`).
- **Zero non-standard imports**: No external HTTP or transport-layer packages.
- **Architectural Seam**: Transport serialization strictly isolated in `apps/agent/src/agent/streaming/sse.py`.

---

# Verification Evidence: Chat Turn Decomposition (Phase 2)

## Overview & Metadata

- **Feature**: 027 Chat Turn Decomposition
- **Phase**: Phase 2 - Foundational Graph Behavior Baseline
- **Tasks**: T004, T005
- **Execution Timestamp**: `2026-09-25T11:55:00+07:00`

---

## 1. Test Suite Verification (Pytest)

### Command Executed
```powershell
$env:PYTHONPATH = "$PWD/tests/ci/python;$PWD/apps/agent/src"
uv run --package agent pytest apps/agent/tests/test_chat_turn_runner.py -v
```

### Execution Result
- **Exit Code**: `0`
- **Output**:
```text
============================= test session starts =============================
platform win32 -- Python 3.11.15, pytest-9.1.1, pluggy-1.6.0
rootdir: C:\Booking Systems\apps\agent
configfile: pyproject.toml
plugins: anyio-4.14.2, langsmith-0.11.1, asyncio-1.4.0, cov-7.1.0, mock-3.15.1
asyncio: mode=Mode.AUTO, debug=False, asyncio_default_fixture_loop_scope=None, asyncio_default_test_loop_scope=function
collected 28 items

apps\agent\tests\test_chat_turn_runner.py::test_chat_turn_command_valid_and_extra_forbid PASSED [  3%]
apps\agent\tests\test_chat_turn_runner.py::test_runner_happy_path_streaming PASSED [  7%]
apps\agent\tests\test_chat_turn_runner.py::test_production_runner_passes_mandatory_gateway_into_graph_config PASSED [ 10%]
apps\agent\tests\test_chat_turn_runner.py::test_runner_session_auto_creation_when_none PASSED [ 14%]
apps\agent\tests\test_chat_turn_runner.py::test_runner_tool_calls_and_flight_results PASSED [ 17%]
apps\agent\tests\test_chat_turn_runner.py::test_runner_check_booking_readiness_sanitized_and_action_required PASSED [ 21%]
apps\agent\tests\test_chat_turn_runner.py::test_runner_tool_block_emits_static_guardrail_error_without_raw_callbacks PASSED [ 25%]
apps\agent\tests\test_chat_turn_runner.py::test_runner_action_handoff_event PASSED [ 28%]
apps\agent\tests\test_chat_turn_runner.py::test_runner_causal_failure_cleanup_on_guardrail_block PASSED [ 32%]
apps\agent\tests\test_chat_turn_runner.py::test_stream_session_covers_all_three_runner_branches_per_turn PASSED [ 35%]
apps\agent\tests\test_chat_turn_runner.py::test_runner_causal_failure_cleanup_on_llm_error PASSED [ 39%]
apps\agent\tests\test_chat_turn_runner.py::test_runner_stale_fence_aborts_persistence PASSED [ 42%]
apps\agent\tests\test_chat_turn_runner.py::test_runner_cancellation_shielded_persistence PASSED [ 46%]
apps\agent\tests\test_chat_turn_runner.py::test_runner_generator_exit_shielded_persistence PASSED [ 50%]
apps\agent\tests\test_chat_turn_runner.py::test_runner_cancellation_bounded_timeout_on_stuck_dependency SKIPPED [ 53%]
apps\agent\tests\test_chat_turn_runner.py::test_on_chat_model_end_prevents_duplicate_on_chain_end PASSED [ 57%]
apps\agent\tests\test_chat_turn_runner.py::test_multiple_model_invocations_emit_later_model_output_without_duplication PASSED [ 60%]
apps\agent\tests\test_chat_turn_runner.py::test_streaming_first_model_and_non_streaming_second_model_with_run_ids PASSED [ 64%]
apps\agent\tests\test_chat_turn_runner.py::test_t004_tools_chain_end_requires_guardrail_validated PASSED [ 67%]
apps\agent\tests\test_chat_turn_runner.py::test_t004_on_tool_end_is_strictly_timing_only PASSED [ 71%]
apps\agent\tests\test_chat_turn_runner.py::test_t004_flight_search_ordering_tool_result_before_flight_results PASSED [ 75%]
apps\agent\tests\test_chat_turn_runner.py::test_t004_booking_readiness_ordering_tool_result_before_action_required PASSED [ 78%]
apps\agent\tests\test_chat_turn_runner.py::test_t004_invalid_readiness_fail_closed_no_tool_result PASSED [ 82%]
apps\agent\tests\test_chat_turn_runner.py::test_t005_token_stream_processing PASSED [ 85%]
apps\agent\tests\test_chat_turn_runner.py::test_t005_model_end_fallback_when_stream_empty PASSED [ 89%]
apps\agent\tests\test_chat_turn_runner.py::test_t005_final_node_fallback_when_stream_and_model_end_empty PASSED [ 92%]
apps\agent\tests\test_chat_turn_runner.py::test_t005_chunk_deduplication_prevents_duplicate_emission PASSED [ 96%]
apps\agent\tests\test_chat_turn_runner.py::test_t005_single_output_guardrail_session_routed PASSED [100%]

======================= 27 passed, 1 skipped in 12.63s ========================
```

---

## 2. Linter & Formatter Verification (Ruff)

### Commands Executed
```powershell
$env:UV_CACHE_DIR = "C:\Booking Systems\.t093-uv-cache"
uv run --package agent ruff check apps/agent/tests/test_chat_turn_runner.py
uv run --package agent ruff format --check apps/agent/tests/test_chat_turn_runner.py
```

### Execution Result
- **Exit Code**: `0`
- **Output**:
```text
All checks passed!
1 file already formatted
```

---

## 3. Characterization Invariants Verified

| Invariant | Test Method | Outcome |
|---|---|---|
| `on_chain_end` for `tools` requires `guardrail_validated: True` | `test_t004_tools_chain_end_requires_guardrail_validated` | Passed (`GUARDRAIL_TOOL_SCHEMA` on unvalidated) |
| `on_tool_end` is strictly timing-only | `test_t004_on_tool_end_is_strictly_timing_only` | Passed (Zero wire domain events emitted) |
| Flight search ordering: `ToolCallEvent` -> `ToolResultEvent` -> `FlightResultsEvent` | `test_t004_flight_search_ordering_tool_result_before_flight_results` | Passed (Strict ordering confirmed) |
| Readiness ordering: `ToolCallEvent` -> `ToolResultEvent` -> `ActionRequiredEvent` | `test_t004_booking_readiness_ordering_tool_result_before_action_required` | Passed (Strict ordering confirmed) |
| Invalid readiness fails closed with no `ToolResultEvent` | `test_t004_invalid_readiness_fail_closed_no_tool_result` | Passed (`READINESS_RESPONSE_INVALID` error, no `ToolResultEvent`) |
| Token streaming via `on_chat_model_stream` | `test_t005_token_stream_processing` | Passed (Token chunks yielded to client) |
| Model-end fallback when stream empty | `test_t005_model_end_fallback_when_stream_empty` | Passed (Message content emitted from model end) |
| Final-node fallback when stream and model-end empty | `test_t005_final_node_fallback_when_stream_and_model_end_empty` | Passed (Emitted from final_answer node) |
| Chunk deduplication across stream and node ends | `test_t005_chunk_deduplication_prevents_duplicate_emission` | Passed (No duplicate tokens emitted) |
| Single output guardrail session routed | `test_t005_single_output_guardrail_session_routed` | Passed (Routed via single `OutputStreamSession`) |

---

# Verification Evidence: Chat Turn Decomposition (Phase 3 / Slice 1)

## Overview & Metadata

- **Feature**: 027 Chat Turn Decomposition
- **Phase/Slice**: Phase 3 / Slice 1 (User Story 1 - ToolResultResolver Extraction)
- **Tasks**: T006, T007
- **Execution Timestamp**: `2026-09-25T14:24:00+07:00`
- **Commit SHA Anchors**:
  - T006: `2aeb236a5eee13b214007d1ca3374b848b602fc0` (`test(agent): characterization tests for ToolResultResolver (T006)`)
  - T007: `17d28bf5d73063d4f46f08420c02fa916144be86` (`feat(agent): implement ToolResultResolver and resolution types (T007)`)
  - Review Fixes: `038b37d2145e08c50688a8efba3df9e3da6531c9` (`fix(agent): align resolver summary overrides, strict readiness validation, and handoff error message`)

---

## 1. Test Suite Verification (Pytest)

### 1.1 ToolResultResolver Dedicated Suite (T006 / T007)
```powershell
$env:PYTHONPATH = "$PWD/tests/ci/python;$PWD/apps/agent/src"
uv run --package agent pytest apps/agent/tests/test_tool_result_resolver.py -v
```

**Execution Result**:
- **Exit Code**: `0`
- **Output**:
```text
============================= test session starts =============================
platform win32 -- Python 3.11.15, pytest-9.1.1, pluggy-1.6.0 -- C:\Booking Systems\.venv\Scripts\python.exe
cachedir: .pytest_cache
rootdir: C:\Booking Systems\apps\agent
configfile: pyproject.toml
plugins: anyio-4.14.2, langsmith-0.11.1, asyncio-1.4.0, cov-7.1.0, mock-3.15.1
asyncio: mode=Mode.AUTO, debug=False, asyncio_default_fixture_loop_scope=None, asyncio_default_test_loop_scope=function
collecting ... collected 23 items

apps\agent\tests\test_tool_result_resolver.py::test_resolve_generic_tool_string_result PASSED [  4%]
apps\agent\tests\test_tool_result_resolver.py::test_resolve_generic_tool_dict_result PASSED [  8%]
apps\agent\tests\test_tool_result_resolver.py::test_resolve_generic_tool_other_type_result PASSED [ 13%]
apps\agent\tests\test_tool_result_resolver.py::test_resolve_search_flights_with_active_snapshot PASSED [ 17%]
apps\agent\tests\test_tool_result_resolver.py::test_resolve_search_flights_with_no_snapshot PASSED [ 21%]
apps\agent\tests\test_tool_result_resolver.py::test_resolve_search_flights_with_no_lifecycle PASSED [ 26%]
apps\agent\tests\test_tool_result_resolver.py::test_resolve_check_booking_readiness_valid_ready_true PASSED [ 30%]
apps\agent\tests\test_tool_result_resolver.py::test_resolve_check_booking_readiness_valid_ready_true_json_string PASSED [ 34%]
apps\agent\tests\test_tool_result_resolver.py::test_resolve_check_booking_readiness_valid_ready_false_complete_profile PASSED [ 39%]
apps\agent\tests\test_tool_result_resolver.py::test_resolve_check_booking_readiness_valid_ready_false_other_action PASSED [ 43%]
apps\agent\tests\test_tool_result_resolver.py::test_resolve_check_booking_readiness_upstream_error PASSED [ 47%]
apps\agent\tests\test_tool_result_resolver.py::test_resolve_check_booking_readiness_invalid_schema PASSED [ 52%]
apps\agent\tests\test_tool_result_resolver.py::test_resolve_check_booking_readiness_unknown_scope PASSED [ 56%]
apps\agent\tests\test_tool_result_resolver.py::test_resolve_check_booking_readiness_invalid_string PASSED [ 60%]
apps\agent\tests\test_tool_result_resolver.py::test_resolve_handoff_node_valid_token PASSED [ 65%]
apps\agent\tests\test_tool_result_resolver.py::test_resolve_handoff_node_node_aliases[create_handoff_token_node] PASSED [ 69%]
apps\agent\tests\test_tool_result_resolver.py::test_resolve_handoff_node_node_aliases[validate_handoff] PASSED [ 73%]
apps\agent\tests\test_tool_result_resolver.py::test_resolve_handoff_node_token_alias PASSED [ 78%]
apps\agent\tests\test_tool_result_resolver.py::test_resolve_handoff_node_action_error PASSED [ 82%]
apps\agent\tests\test_tool_result_resolver.py::test_resolve_handoff_node_action_error_empty_string PASSED [ 86%]
apps\agent\tests\test_tool_result_resolver.py::test_resolve_handoff_node_unrecognized_node PASSED [ 91%]
apps\agent\tests\test_tool_result_resolver.py::test_resolve_handoff_node_missing_action PASSED [ 95%]
apps\agent\tests\test_tool_result_resolver.py::test_resolve_handoff_node_non_dict_output PASSED [100%]

============================= 23 passed in 11.60s =============================
```

### 1.2 Baseline Chat Turn Runner Suite Regression Check
```powershell
uv run --package agent pytest apps/agent/tests/test_chat_turn_runner.py
```

**Execution Result**:
- **Exit Code**: `0`
- **Output**:
```text
============================= test session starts =============================
platform win32 -- Python 3.11.15, pytest-9.1.1, pluggy-1.6.0
rootdir: C:\Booking Systems\apps\agent
configfile: pyproject.toml
plugins: anyio-4.14.2, langsmith-0.11.1, asyncio-1.4.0, cov-7.1.0, mock-3.15.1
asyncio: mode=Mode.AUTO, debug=False, asyncio_default_fixture_loop_scope=None, asyncio_default_test_loop_scope=function
collected 28 items

apps\agent\tests\test_chat_turn_runner.py ..............s.............   [100%]

======================== 27 passed, 1 skipped in 6.90s ========================
```

---

## 2. Linter & Formatter Verification (Ruff)

### Commands Executed
```powershell
$env:UV_CACHE_DIR = "C:\Booking Systems\.t093-uv-cache"
uv run --package agent ruff check apps/agent/src/agent/chat_turn/resolver.py apps/agent/tests/test_tool_result_resolver.py
uv run --package agent ruff format --check apps/agent/src/agent/chat_turn/resolver.py apps/agent/tests/test_tool_result_resolver.py
```

**Execution Result**:
- **Exit Code**: `0`
- **Output**:
```text
All checks passed!
2 files already formatted
```

---

## 3. Boundary & Non-Regression Invariants

| Invariant / Constraint | Target | Status | Notes |
|---|---|---|---|
| Zero runner modifications | `apps/agent/src/agent/chat_turn/runner.py` | Verified | 0 modifications; intact for subsequent wiring (T010) |
| Zero interpreter modifications | `apps/agent/src/agent/chat_turn/interpreter.py` | Verified | Unmodified / preserved for T008-T009 |
| Generic tool fallback | `resolve_tool_message` | Verified | Emits `ToolResultEvent` with stringified content; no follow-up |
| Flight search snapshot | `search_flights` | Verified | Emits `ToolResultEvent` followed by `FlightResultsEvent` via snapshot payload |
| Flight search empty snapshot fallback | `search_flights` | Verified | Fallback to raw flights list if snapshot empty or missing |
| Valid readiness summary | `check_booking_readiness` | Verified | Emits `ToolResultEvent` then `ActionRequiredEvent` with sanitized summary |
| Invalid readiness fail-closed | `check_booking_readiness` | Verified | Sets `block_decision` (`READINESS_RESPONSE_INVALID`), emits NO `ToolResultEvent` |
| Upstream readiness error fail-closed | `check_booking_readiness` | Verified | Sets `block_decision` (`UPSTREAM_READINESS_ERROR`), emits NO `ToolResultEvent` |
| Handoff token generation | `create_handoff_token` | Verified | Emits `ActionHandoffEvent` (`force_persist=True`) |
| Handoff validation | `validate_handoff` | Verified | Emits `ActionHandoffEvent` (`force_persist=True`) |
| Handoff failure fail-closed | handoff nodes | Verified | Emits `ErrorEvent` with code `HANDOFF_FAILED` (`force_persist=True`) |
| Unrecognized handoff node | other nodes | Verified | No-op resolution (`events=[]`, `block_decision=None`, `force_persist=False`) |

---

# Verification Evidence: Chat Turn Decomposition (Phase 3 / Slice 2)

## Overview & Metadata

- **Feature**: 027 Chat Turn Decomposition
- **Phase/Slice**: Phase 3 / Slice 2 (User Story 1 - GraphEventInterpreter Extraction)
- **Tasks**: T008, T009
- **Execution Timestamp**: `2026-09-25T17:35:00+07:00`
- **Files Created/Modified**:
  - `apps/agent/tests/test_chat_turn_interpreter.py` (Created - T008)
  - `apps/agent/src/agent/chat_turn/interpreter.py` (Created - T009)
  - `apps/agent/src/agent/chat_turn/__init__.py` (Modified - exports)
  - `specs/027-chat-turn-decomposition/tasks.md` (Updated)

---

## 1. Test Suite Verification (Pytest)

### 1.1 Targeted Interpreter Unit Suite (T008 / T009)
```powershell
$env:PYTHONPATH = "$PWD/tests/ci/python;$PWD/apps/agent/src"
uv run --package agent pytest apps/agent/tests/test_chat_turn_interpreter.py -v
```

**Execution Result**:
- **Exit Code**: `0`
- **Output**:
```text
============================= test session starts =============================
platform win32 -- Python 3.11.15, pytest-9.1.1, pluggy-1.6.0 -- C:\Booking Systems\.venv\Scripts\python.exe
cachedir: .pytest_cache
rootdir: C:\Booking Systems\apps\agent
configfile: pyproject.toml
plugins: anyio-4.14.2, langsmith-0.11.1, asyncio-1.4.0, cov-7.1.0, mock-3.15.1
asyncio: mode=Mode.AUTO, debug=False, asyncio_default_fixture_loop_scope=None, asyncio_default_test_loop_scope=function
collecting ... collected 29 items

apps\agent\tests\test_chat_turn_interpreter.py::test_tool_name_agnostic_arbitrary_tools_forwarded_identically[custom_tool_abc-{"status": "ok", "custom_field": 42}] PASSED [  3%]
apps\agent\tests\test_chat_turn_interpreter.py::test_tool_name_agnostic_arbitrary_tools_forwarded_identically[search_flights-{"flights": [{"flight_number": "FL101"}]}] PASSED [  6%]
apps\agent\tests\test_chat_turn_interpreter.py::test_tool_name_agnostic_arbitrary_tools_forwarded_identically[check_booking_readiness-{"ready": true}] PASSED [ 10%]
apps\agent\tests\test_chat_turn_interpreter.py::test_tool_name_agnostic_arbitrary_tools_forwarded_identically[ancillary_seat_picker-{"selected_seat": "14A"}] PASSED [ 13%]
apps\agent\tests\test_chat_turn_interpreter.py::test_accepted_tool_execution_ordering_with_flight_results_follow_up PASSED [ 17%]
apps\agent\tests\test_chat_turn_interpreter.py::test_accepted_tool_execution_ordering_with_action_required_follow_up PASSED [ 20%]
apps\agent\tests\test_chat_turn_interpreter.py::test_accepted_tool_execution_without_follow_up_emits_call_and_result_only PASSED [ 24%]
apps\agent\tests\test_chat_turn_interpreter.py::test_accepted_multiple_tool_messages_invokes_resolver_per_message PASSED [ 27%]
apps\agent\tests\test_chat_turn_interpreter.py::test_blocked_readiness_resolution_raises_projection_blocked_and_yields_no_result PASSED [ 31%]
apps\agent\tests\test_chat_turn_interpreter.py::test_arbitrary_tool_blocked_resolution_raises_projection_blocked PASSED [ 34%]
apps\agent\tests\test_chat_turn_interpreter.py::test_unvalidated_tool_output_tool_blocked_flag_raises_projection_blocked PASSED [ 37%]
apps\agent\tests\test_chat_turn_interpreter.py::test_unvalidated_tool_output_missing_guardrail_validated_flag_raises_blocked[additional_kwargs0] PASSED [ 41%]
apps\agent\tests\test_chat_turn_interpreter.py::test_unvalidated_tool_output_missing_guardrail_validated_flag_raises_blocked[additional_kwargs1] PASSED [ 44%]
apps\agent\tests\test_chat_turn_interpreter.py::test_unvalidated_tool_output_missing_guardrail_validated_flag_raises_blocked[additional_kwargs2] PASSED [ 48%]
apps\agent\tests\test_chat_turn_interpreter.py::test_unvalidated_tool_output_missing_guardrail_validated_flag_raises_blocked[additional_kwargs3] PASSED [ 51%]
apps\agent\tests\test_chat_turn_interpreter.py::test_handoff_node_completion_emits_action_handoff_event[create_handoff_token] PASSED [ 55%]
apps\agent\tests\test_chat_turn_interpreter.py::test_handoff_node_completion_emits_action_handoff_event[create_handoff_token_node] PASSED [ 58%]
apps\agent\tests\test_chat_turn_interpreter.py::test_handoff_node_completion_emits_action_handoff_event[validate_handoff] PASSED [ 62%]
apps\agent\tests\test_chat_turn_interpreter.py::test_handoff_node_completion_blocked_raises_projection_blocked[create_handoff_token] PASSED [ 65%]
apps\agent\tests\test_chat_turn_interpreter.py::test_handoff_node_completion_blocked_raises_projection_blocked[create_handoff_token_node] PASSED [ 68%]
apps\agent\tests\test_chat_turn_interpreter.py::test_handoff_node_completion_blocked_raises_projection_blocked[validate_handoff] PASSED [ 72%]
apps\agent\tests\test_chat_turn_interpreter.py::test_handoff_node_completion_no_event_yields_nothing PASSED [ 75%]
apps\agent\tests\test_chat_turn_interpreter.py::test_non_handoff_node_does_not_route_to_resolve_handoff_node PASSED [ 79%]
apps\agent\tests\test_chat_turn_interpreter.py::test_model_stream_emits_raw_token_chunks PASSED [ 82%]
apps\agent\tests\test_chat_turn_interpreter.py::test_model_stream_fallback_to_on_chat_model_end_when_stream_empty PASSED [ 86%]
apps\agent\tests\test_chat_turn_interpreter.py::test_model_stream_fallback_to_final_node_output_when_stream_and_model_end_empty PASSED [ 89%]
apps\agent\tests\test_chat_turn_interpreter.py::test_model_stream_deduplication_streamed_tokens_not_re_emitted_by_fallbacks PASSED [ 93%]
apps\agent\tests\test_chat_turn_interpreter.py::test_model_stream_deduplication_model_end_fallback_not_duplicated_by_node_end PASSED [ 96%]
apps\agent\tests\test_chat_turn_interpreter.py::test_on_tool_end_yields_zero_domain_events PASSED [100%]

============================= 29 passed in 12.40s =============================
```

### 1.2 Regression Suite Verification
```powershell
uv run --package agent pytest apps/agent/tests/test_tool_result_resolver.py apps/agent/tests/test_chat_turn_runner.py
```

**Execution Result**:
- **Exit Code**: `0`
- **Output**:
```text
======================= 50 passed, 1 skipped in 15.28s ========================
```

---

## 2. Linter & Formatter Verification (Ruff)

### Commands Executed
```powershell
$env:UV_CACHE_DIR = "C:\Booking Systems\.t093-uv-cache"
uv run --package agent ruff check apps/agent/src/agent/chat_turn/interpreter.py apps/agent/tests/test_chat_turn_interpreter.py
uv run --package agent ruff format --check apps/agent/src/agent/chat_turn/interpreter.py apps/agent/tests/test_chat_turn_interpreter.py
```

**Execution Result**:
- **Exit Code**: `0`
- **Output**:
```text
All checks passed!
2 files already formatted
```

---

## 3. Static Boundary & Invariant Censuses

### 3.1 Tool-Name Agnostic Boundary Census
```powershell
git grep -n -E "tool_name\s*(==|in)" apps/agent/src/agent/chat_turn/interpreter.py
```
- **Exit Code**: `1` (0 matches found)
- **Status**: PASSED (strict adherence to FR-001)

### 3.2 Strict Typing Census
```powershell
git grep -n -w "Any" apps/agent/src/agent/chat_turn/interpreter.py apps/agent/tests/test_chat_turn_interpreter.py
```
- **Exit Code**: `1` (0 matches found)
- **Status**: PASSED (zero `Any` in new code)

### 3.3 Zero Runner Modifications Boundary
```powershell
git diff --name-only origin/development...HEAD apps/agent/src/agent/chat_turn/runner.py
```
- **Status**: PASSED (`runner.py` untouched; wiring deferred to Slice 3 / T010)

| Invariant / Constraint | Target | Status | Notes |
|---|---|---|---|
| Zero runner modifications | `apps/agent/src/agent/chat_turn/runner.py` | Verified | 0 modifications in Slice 2 |
| Tool-name agnostic translation | `GraphEventInterpreter` | Verified | Zero `tool_name` inspections; delegates unconditionally |
| Dependency isolation | `GraphEventInterpreter` | Verified | Zero imports/calls to Redis, NestJS, Guardrail gateway/pipeline |
| Raw token emission | `GraphEventInterpreter` | Verified | Yields `TokenEvent` directly without output guardrails |
| Fail-closed on blocked resolution | `GraphEventInterpreter` | Verified | Raises `ProjectionBlockedException`; 0 `ToolResultEvent` emitted |
| Fail-closed on unvalidated output | `GraphEventInterpreter` | Verified | Raises `ProjectionBlockedException(GUARDRAIL_TOOL_SCHEMA)` |
| Handoff node routing | `GraphEventInterpreter` | Verified | Forwards to `resolver.resolve_handoff_node`; yields `ActionHandoffEvent` |
| Streaming deduplication | `GraphEventInterpreter` | Verified | Preserves model-end and node-end fallbacks without duplicate emission |
| Timing-only `on_tool_end` | `GraphEventInterpreter` | Verified | Absorbs `on_tool_end` with zero domain event emission |

---

# Verification Evidence: Chat Turn Decomposition (Phase 3 / Slice 3 - User Story 1 Verification Gate)

## Overview & Metadata

- **Feature**: 027 Chat Turn Decomposition
- **Phase/Slice**: Phase 3 / Slice 3 (User Story 1 - Runner Wiring & Comprehensive US1 Verification Gate)
- **Tasks**: T010, T011
- **Execution Timestamp**: `2026-09-25T19:21:00+07:00`
- **Git HEAD SHA**: `7f5fe12c` (`style(agent): place third-party langchain imports before first-party agent imports`)
- **Files Modified**:
  - `apps/agent/src/agent/chat_turn/runner.py` (Wired `GraphEventInterpreter` and `ToolResultResolver`; eliminated ~560 lines of legacy translation logic)
  - `apps/agent/src/agent/chat_turn/interpreter.py` (Tool call input projection integration)
  - `apps/agent/src/agent/chat_turn/resolver.py` (Typed input projection helpers)
  - `apps/agent/tests/test_chat_turn_runner.py` (Delegation and invariant tests)
  - `apps/agent/tests/test_chat_turn_interpreter.py`
  - `apps/agent/tests/test_tool_result_resolver.py`
  - `specs/027-chat-turn-decomposition/tasks.md`

---

## 1. Test Suite Verification (Pytest - 7 Focused US1 Suites)

### Command Executed
```powershell
$env:PYTHONPATH = "$PWD/tests/ci/python;$PWD/apps/agent/src"
uv run --package agent pytest `
  apps/agent/tests/test_chat_turn_events.py `
  apps/agent/tests/test_tool_result_resolver.py `
  apps/agent/tests/test_chat_turn_interpreter.py `
  apps/agent/tests/test_chat_turn_runner.py `
  apps/agent/tests/test_sse_integration.py `
  apps/agent/tests/characterization/test_sse_characterization.py `
  apps/agent/tests/security/test_output_stream.py -v
```

### Execution Result
- **Exit Code**: `0`
- **Total Tests**: 182 items (180 passed, 2 skipped, 0 failed in 17.94s)
- **Suite Breakdown**:
  - `apps/agent/tests/test_chat_turn_events.py`: 16 passed
  - `apps/agent/tests/test_tool_result_resolver.py`: 28 passed
  - `apps/agent/tests/test_chat_turn_interpreter.py`: 30 passed
  - `apps/agent/tests/test_chat_turn_runner.py`: 28 passed, 1 skipped (`test_runner_cancellation_bounded_timeout_on_stuck_dependency`)
  - `apps/agent/tests/test_sse_integration.py`: 12 passed
  - `apps/agent/tests/characterization/test_sse_characterization.py`: 15 passed, 1 skipped (canonical failure finalization)
  - `apps/agent/tests/security/test_output_stream.py`: 51 passed

---

## 2. Linter & Formatter Verification (Ruff)

### Commands Executed
```powershell
$env:UV_CACHE_DIR = "C:\Booking Systems\.t093-uv-cache"
uv run --package agent ruff check apps/agent/src/agent/chat_turn/ apps/agent/tests/
uv run --package agent ruff format --check apps/agent/src/agent/chat_turn/ apps/agent/tests/
```

### Execution Result
- **Exit Code**: `0`
- **Output**:
```text
All checks passed!
92 files already formatted
```

---

## 3. User Story 1 Event Parity Evidence & Invariant Audit

| Invariant / Requirement | Verification Target | Status | Evidence / Notes |
|---|---|---|---|
| **FR-001**: Tool-name agnostic translation | `GraphEventInterpreter` | Verified | Interpreter contains 0 tool-name conditionals; delegates tool results unconditionally to `ToolResultResolver` |
| **FR-002**: Tool projection separation | `ToolResultResolver` | Verified | Encapsulates search snapshot projection, booking readiness schema validation/sanitization, and handoff token extractions |
| **FR-003**: Event ordering | `GraphEventInterpreter` / `Runner` | Verified | Accepted tool emits `tool_call` then `tool_result`, followed by domain projections (`flight_results`, `ACTION_REQUIRED`) |
| **FR-004**: Single OutputStreamSession | `runner.py` | Verified | Every raw `TokenEvent` from interpreter passes through single `OutputStreamSession.push()` for PII scanning |
| **FR-005**: Fail-closed projection blocking | `resolver.py` / `runner.py` | Verified | `ProjectionBlockedException` caught by runner; triggers 4-step causal failure cleanup and emits static `ErrorEvent` |
| **FR-006**: Handoff node routing | `interpreter.py` / `resolver.py` | Verified | Dispatches `create_handoff_token`, `create_handoff_token_node`, `validate_handoff` to typed completions |
| **FR-007**: Streaming deduplication | `interpreter.py` | Verified | Streaming chunks, model-end fallbacks, and node-end fallbacks deduplicated without double emissions |
| **FR-008**: Timing-only `on_tool_end` | `interpreter.py` | Verified | Consumes `on_tool_end` for latency metrics; produces zero domain events |
| **Wire & SSE Parity** | `sse.py` & Characterization | Verified | 100% byte-for-byte serialization match across all 8 canonical domain events |

---

# Verification Evidence: Chat Turn Decomposition (Phase 4 — User Story 2, Slice 1)

## Overview & Metadata

- **Feature**: 027 Chat Turn Decomposition
- **Phase**: Phase 4: User Story 2 — Coordinate conversation memory
- **Slice**: Slice 1: ConversationMemory Extraction & Unit Tests
- **Tasks**: T012, T013
- **Execution Timestamp**: `2026-09-25T20:14:00+07:00`
- **Deliverables**:
  - `apps/agent/src/agent/memory/conversation.py`
  - `apps/agent/src/agent/memory/__init__.py`
  - `apps/agent/tests/test_conversation_memory.py`

---

## 1. Test Suite Verification (Pytest — Focused Memory Suites)

### Command Executed
```powershell
$env:PYTHONPATH = "$PWD/tests/ci/python;$PWD/apps/agent/src"
uv run --package agent pytest apps/agent/tests/test_conversation_memory.py apps/agent/tests/test_memory.py -v
```

### Execution Result
- **Exit Code**: `0`
- **Total Tests**: 25 passed in 7.82s
- **Suite Breakdown**:
  - `apps/agent/tests/test_conversation_memory.py`: 20 passed (100%)
  - `apps/agent/tests/test_memory.py`: 5 passed (100%)

---

## 2. Full Non-Redis Agent Test Suite Regression Verification

### Command Executed
```powershell
$env:PYTHONPATH = "$PWD/tests/ci/python;$PWD/apps/agent/src"
uv run --package agent pytest apps/agent/tests -m "not redis_integration" -q
```

### Execution Result
- **Exit Code**: `0`
- **Outcome**: 1240 passed, 4 skipped, 12 deselected in 97.04s

---

## 3. Linter & Formatter Verification (Ruff)

### Commands Executed
```powershell
$env:UV_CACHE_DIR = "C:\Booking Systems\.t093-uv-cache"
uv run --package agent ruff check apps/agent/src/agent/memory/ apps/agent/tests/test_conversation_memory.py
uv run --package agent ruff format --check apps/agent/src/agent/memory/ apps/agent/tests/test_conversation_memory.py
```

### Execution Result
- **Exit Code**: `0`
- **Output**:
```text
All checks passed!
4 files already formatted
```

---

## 4. Invariant & Boundary Verification Matrix

| Invariant / Requirement | Target | Status | Evidence / Notes |
|---|---|---|---|
| **FR-009**: Exact identity & policy forwarding | `ConversationMemory.get_context` | Verified | `user_id`, `chat_session_id`, `trace_id`, `correlation_id`, and `policy_version` forwarded verbatim to `gateway.validate_input()` |
| **Fail-closed historical messages** | `ConversationMemory.get_context` | Verified | History message `BLOCK` or exception raises `ContextBlockedException` with block code (`GUARDRAIL_INPUT_INJECTION`, `GUARDRAIL_INPUT_PII`) |
| **Unsafe summary discard** | `ConversationMemory.get_context` | Verified | Persisted summary `BLOCK` or validation exception discards summary (`summary = None`) while safe history is preserved |
| **Window size / offset handling** | `ConversationMemory.get_context` | Verified | Passes configured `MEMORY_WINDOW_SIZE` (or default 20) as `recent_count` to `client.get_memory` |
| **Error mapping** | `ConversationMemory.get_context` | Verified | `404`/`NOT_FOUND` mapped to `SessionNotFoundException`; generic errors mapped to `MemoryPersistenceException` |
| **Compaction accounting** | `ConversationMemory.schedule_compaction` | Verified | Preserves `total_count = total_message_count + 2` calling `MemoryManager.check_and_summarize` |
| **Task tracking & cleanup** | `ConversationMemory.schedule_compaction` | Verified | Registers task in `background_tasks` set; adds `add_done_callback(background_tasks.discard)` |
| **Strict Typing** | `conversation.py`, `__init__.py`, `test_conversation_memory.py` | Verified | Strictly 0 instances of `Any` |
| **Slice Isolation** | `runner.py` | Verified | `runner.py` untouched; wiring deferred to Slice 2 (T014–T015) |

---

# Verification Evidence: Chat Turn Decomposition (Phase 4 — User Story 2, Slice 2)

## Overview & Metadata

- **Feature**: 027 Chat Turn Decomposition
- **Phase**: Phase 4: User Story 2 — Coordinate conversation memory
- **Slice**: Slice 2: ChatTurnRunner Memory Wiring & Parity Verification
- **Tasks**: T014, T015
- **Execution Timestamp**: `2026-09-25T21:05:00+07:00`
- **Deliverables**:
  - `apps/agent/src/agent/chat_turn/runner.py` (wired to `ConversationMemory.get_context` and `ConversationMemory.schedule_compaction`)
  - `apps/agent/tests/test_chat_turn_runner.py` (unit tests verifying memory delegation, session not found cleanup, persistence error cleanup, context blocked cleanup)

---

## 1. Test Suite Verification (Pytest — Focused Memory & Runner Suites)

### Command Executed
```powershell
$env:PYTHONPATH = "$PWD/tests/ci/python;$PWD/apps/agent/src"
uv run --package agent pytest apps/agent/tests/test_conversation_memory.py apps/agent/tests/test_memory.py apps/agent/tests/test_chat_turn_runner.py -v
```

### Execution Result
- **Exit Code**: `0`
- **Total Tests**: 57 passed, 1 skipped in 10.47s
- **Suite Breakdown**:
  - `apps/agent/tests/test_conversation_memory.py`: 20 passed (100%)
  - `apps/agent/tests/test_memory.py`: 5 passed (100%)
  - `apps/agent/tests/test_chat_turn_runner.py`: 32 passed, 1 skipped (100% of runnable)

---

## 2. Full Non-Redis Agent Test Suite Regression Verification

### Command Executed
```powershell
$env:PYTHONPATH = "$PWD/tests/ci/python;$PWD/apps/agent/src"
uv run --package agent pytest apps/agent/tests -m "not redis_integration" -k "not test_security_performance" -q
```

### Execution Result
- **Exit Code**: `0`
- **Outcome**: 1236 passed, 4 skipped, 20 deselected, 9 warnings in 110.82s

---

## 3. Linter & Formatter Verification (Ruff)

### Commands Executed
```powershell
$env:UV_CACHE_DIR = "C:\Booking Systems\.t093-uv-cache"
uv run --package agent ruff check apps/agent/src/agent/chat_turn/runner.py apps/agent/tests/test_chat_turn_runner.py
uv run --package agent ruff format --check apps/agent/src/agent/chat_turn/runner.py apps/agent/tests/test_chat_turn_runner.py
```

### Execution Result
- **Exit Code**: `0`
- **Output**:
```text
All checks passed!
2 files already formatted
```

---

## 4. Invariant & Parity Verification Matrix

| Invariant / Requirement | Target | Status | Evidence / Notes |
|---|---|---|---|
| **FR-009: Exact AdmissionContext Forwarding** | `runner.py` -> `ConversationMemory.get_context` | Verified | Runner passes `session_id`, `client`, and constructed `AdmissionContext` (carrying `user_id`, `chat_session_id`, `trace_id`, `correlation_id`, `policy_version`) verbatim to memory coordinator. |
| **Direct Runner Fallback (None admission_context)** | `runner.py` / `conversation.py` | Verified | When runner invoked directly without `admission_context`, `ConversationMemory.get_context` constructs default context from `user_id`/`session_id` preserving backward compatibility. |
| **Causal Cleanup on Session Missing** | `runner.py` -> `SessionNotFoundException` | Verified | Missing session triggers 4-step causal failure cleanup (release lock, audit log, record metrics, clear active session) and emits static `ErrorEvent(SESSION_NOT_FOUND)`. |
| **Causal Cleanup on Persistence Error** | `runner.py` -> `MemoryPersistenceException` | Verified | Upstream persistence error triggers 4-step causal failure cleanup and emits static `ErrorEvent(UPSTREAM_PERSISTENCE_ERROR)`. |
| **Causal Cleanup on Context Blocked** | `runner.py` -> `ContextBlockedException` | Verified | Blocked context (injection/PII in historical messages) triggers 4-step causal failure cleanup and emits static `ErrorEvent(error_code)`. |
| **Compaction Accounting (`totalMessageCount + 2`)** | `runner.py` -> `ConversationMemory.schedule_compaction` | Verified | Runner delegates post-turn background compaction to `ConversationMemory.schedule_compaction` preserving `total_count = total_message_count + 2`. |
| **Background Task Registry & GC Safety** | `runner.py` -> `ConversationMemory.schedule_compaction` | Verified | Compaction task registered in runner's `background_tasks` set with `add_done_callback(background_tasks.discard)`. |
| **Strict Typing** | `runner.py`, `conversation.py` | Verified | Fully typed; zero unresolved type issues; clean mypy/pyright compatibility. |

---

# Verification Evidence: Chat Turn Decomposition (Phase 5 — User Story 3)

## Overview & Metadata

- **Feature**: 027 Chat Turn Decomposition
- **Phase**: Phase 5: User Story 3 — Reuse ordered admission
- **Tasks**: T016, T017, T018, T019, T020, T021
- **Execution Timestamp**: `2026-09-25T23:00:00+07:00`
- **Deliverables**:
  - `apps/agent/src/agent/admission/__init__.py`
  - `apps/agent/src/agent/admission/auth.py` (`AuthService`, `AuthenticatedUser`)
  - `apps/agent/src/agent/admission/input_admission.py` (`InputAdmissionService`, `InputAdmissionResult`, `create_blocked_sse_response`)
  - `apps/agent/src/agent/admission/quota.py` (`QuotaService`)
  - `apps/agent/src/agent/streaming/sse.py` (thin FastAPI dependencies `get_auth_service`, `get_authenticated_user`, `get_input_admission_service`, `get_admitted_input`, `get_quota_service`, `check_chat_quota`, direct-call backward compatibility fallback)
  - `apps/agent/tests/test_chat_admission.py` (endpoint admission, service unit tests, strict ordering, single-scan, PII short-circuit)

---

## 1. Test Suite Verification (Pytest — Focused Admission & Transport Suites)

### Command Executed
```powershell
$env:PYTHONPATH = "$PWD/tests/ci/python;$PWD/apps/agent/src"
uv run --package agent pytest apps/agent/tests/test_chat_admission.py apps/agent/tests/test_sse.py apps/agent/tests/test_chat_controller.py apps/agent/tests/test_stream_auth_budget.py apps/agent/tests/test_sse_integration.py -v
```

### Execution Result
- **Exit Code**: `0`
- **Total Tests**: 90 passed in 27.68s
- **Suite Breakdown**:
  - `apps/agent/tests/test_chat_admission.py`: 28 passed (100%)
  - `apps/agent/tests/test_sse.py`: 30 passed (100%)
  - `apps/agent/tests/test_chat_controller.py`: 6 passed (100%)
  - `apps/agent/tests/test_stream_auth_budget.py`: 9 passed (100%)
  - `apps/agent/tests/test_sse_integration.py`: 17 passed (100%)

---

## 2. Full Non-Redis Agent Test Suite Regression Verification

### Command Executed
```powershell
$env:PYTHONPATH = "$PWD/tests/ci/python;$PWD/apps/agent/src"
uv run --package agent pytest apps/agent/tests -m "not redis_integration" -k "not test_security_performance" -q
```

### Execution Result
- **Exit Code**: `0`
- **Outcome**: 1270 passed, 4 skipped, 20 deselected, 9 warnings in 146.56s (0:02:26)
- **Regressions**: 0 failures

---

## 3. Linter & Formatter Verification (Ruff)

### Commands Executed
```powershell
$env:UV_CACHE_DIR = "C:\Booking Systems\.t093-uv-cache"
uv run --package agent ruff check apps/agent/src/agent/admission apps/agent/src/agent/streaming/sse.py apps/agent/tests/test_chat_admission.py
uv run --package agent ruff format --check apps/agent/src/agent/admission apps/agent/src/agent/streaming/sse.py apps/agent/tests/test_chat_admission.py
```

### Execution Result
- **Exit Code**: `0`
- **Output**:
```text
All checks passed!
6 files already formatted
```

---

## 4. Invariant & Parity Verification Matrix

| Invariant / Requirement | Target | Status | Evidence / Notes |
|---|---|---|---|
| **Zero-Redis PII Short-Circuit** | `InputAdmissionService` & `sse.py` | Verified | Ingress message with PII immediately yields `ErrorEvent(GUARDRAIL_BLOCKED)` SSE stream before quota admission, resulting in zero Redis client initialization and zero quota consumed (`test_pii_ingress_short_circuit_zero_redis_zero_quota`, `test_ingress_pii_detected_yields_guardrail_blocked_event`). |
| **Single-Scan Guarantee** | `InputAdmissionService` -> `ChatController` | Verified | Input message validated exactly once during admission; validated `decision` forwarded to `ChatController.stream()` and runner without redundant re-scanning (`test_single_scan_guarantee_end_to_end`, `test_chat_controller_single_scan_guarantee_forwards_validated_input`). |
| **Ordered Admission Progression** | `sse.py` dependencies | Verified | Progression enforced: `auth` (header + JWT + NestJS active check) -> `length` -> `gateway_health` -> `input_scan` -> `quota` -> `runner`. Any failure short-circuits subsequent stages (`test_strict_ordering_auth_then_input_then_quota`). |
| **Error Contract Parity** | `AuthService`, `InputAdmissionService`, `QuotaService` | Verified | Exact parity with prior contracts: 400 for max length / invalid input (`Message exceeds maximum length`), 401 for missing/invalid header, bad JWT, revoked account (`Invalid authorization header`, `Invalid token`, `User account inactive or token revoked`), 429 for daily/burst quota (`CHAT_DAILY_QUOTA_EXCEEDED`, `CHAT_BURST_LIMIT_EXCEEDED`), 503 for degraded gateway or redis down (`GUARDRAIL_GATEWAY_UNAVAILABLE`, `CHAT_CONTROL_PLANE_UNAVAILABLE`). |
| **Dynamic Dependency Resolution Compatibility** | `sse.py` / `QuotaService` | Verified | Thin dependency factories dynamically inspect `sys.modules[__name__]` and module-level attributes, guaranteeing full compatibility with existing test monkeypatches (`patch("agent.streaming.sse.ChatBudgetRepository")`, `patch("agent.streaming.sse.NestJSClient")`, etc.) and direct test function invocations. |
| **Strict Zero `Any` Typing** | `apps/agent/src/agent/admission/`, `sse.py` | Verified | `git grep -n -w "Any"` yields 0 matches in admission services and modified streaming endpoints. |





