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
