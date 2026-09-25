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

