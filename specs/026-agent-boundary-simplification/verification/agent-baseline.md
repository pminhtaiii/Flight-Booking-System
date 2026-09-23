# Python Agent Baseline Verification (Task T002 & T003)

- **Timestamp**: 2026-09-23T14:45:00+07:00
- **Commit SHA**: `8c7ef172b027e90a3715c77f35783ed59f88751a`

## Baseline Execution Results

### 1. Ruff Lint Check
- **Command**:
  ```powershell
  $env:UV_CACHE_DIR = "C:\Booking Systems\.t093-uv-cache"
  uv run --package agent ruff check apps/agent
  ```
- **Exit Code**: `0`
- **Output**: `All checks passed!`

### 2. Ruff Format Check
- **Command**:
  ```powershell
  $env:UV_CACHE_DIR = "C:\Booking Systems\.t093-uv-cache"
  uv run --package agent ruff format --check apps/agent
  ```
- **Exit Code**: `0`
- **Output**: `155 files already formatted`

### 3. Targeted Security & Guardrail Pytest Suites
- **Command**:
  ```powershell
  $env:UV_CACHE_DIR = "C:\Booking Systems\.t093-uv-cache"
  $env:PYTHONPATH = "$PWD\tests\ci\python;$PWD\apps\agent\src"
  uv run --package agent pytest apps/agent/tests/security/test_gateway.py apps/agent/tests/security/test_input_layers.py apps/agent/tests/security/test_tool_layers.py apps/agent/tests/security/test_output_stream.py apps/agent/tests/test_output_pipeline.py apps/agent/tests/test_chat_turn_runner.py apps/agent/tests/test_sse.py
  ```
- **Exit Code**: `0`
- **Results Summary**:
  - `214 passed, 1 skipped in 91.10s`
  - Suites passed:
    - `test_gateway.py`: 10 passed
    - `test_input_layers.py`: 80 passed
    - `test_tool_layers.py`: 39 passed
    - `test_output_stream.py`: 41 passed
    - `test_output_pipeline.py`: 4 passed
    - `test_chat_turn_runner.py`: 18 passed, 1 skipped
    - `test_sse.py`: 22 passed

### 4. Full Pytest Suite (Excluding Redis Integration)
- **Command**:
  ```powershell
  $env:UV_CACHE_DIR = "C:\Booking Systems\.t093-uv-cache"
  $env:PYTHONPATH = "$PWD\tests\ci\python;$PWD\apps\agent\src"
  uv run --package agent pytest apps/agent/tests -m "not redis_integration"
  ```
- **Exit Code**: `1`
- **Results Summary**:
  - `1 failed, 1001 passed, 4 skipped, 12 deselected, 9 warnings in 346.41s`
  - Single pre-existing failure: `apps/agent/tests/test_search_snapshot.py::test_serialized_redis_payload_under_snapshot_key_is_score_free` (AssertionError: `assert None is not None` at line 894)
  - All 1001 other tests passing.

---

## Initial Code Census (Task T003)

### Query 1
- **Command**: `rg -n "agent-gateway" apps/api/src/chat`
- **Matches**: 5
  - `apps/api/src/chat/chat.module.ts:9`
  - `apps/api/src/chat/agent-chat.controller.ts:16`
  - `apps/api/src/chat/agent-chat.controller.ts:17`
  - `apps/api/src/chat/agent-chat.controller.ts:30`
  - `apps/api/src/chat/agent-chat.controller.spec.ts:6`

### Query 2
- **Command**: `rg -n "@/chat/chat-message-crypto.service|GuardrailRegistry|create_production_registry|OutputPIILayer|InputGuardrailPipeline|ToolOutputGuardrailPipeline" apps/api apps/agent`
- **Matches**: 170

### Query 3
- **Command**: `rg -n "OutputGuardrailPipeline\(" apps/agent/src/agent --glob "*.py"`
- **Matches**: 2
  - `apps/agent/src/agent/guardrails/gateway.py:185` (matches `ToolOutputGuardrailPipeline(` substring)
  - `apps/agent/src/agent/chat_turn/runner.py:547` (`pipeline = OutputGuardrailPipeline(`)

### Query 4
- **Command**: `rg -n "OutputGuardrailPipeline|OutputGuardrailBlockedError" apps/agent/src/agent --glob "*.py" --glob "!**/guardrails/gateway.py" --glob "!**/guardrails/output_pipeline.py" --glob "!**/guardrails/base.py"`
- **Matches**: 8
  - `apps/agent/src/agent/guardrails/tool_output_pipeline.py:27` (class `ToolOutputGuardrailPipeline`)
  - `apps/agent/src/agent/guardrails/tool_output_pipeline.py:83` (`__all__ = ["ToolOutputGuardrailPipeline"]`)
  - `apps/agent/src/agent/chat_turn/runner.py:36` (import `OutputGuardrailBlockedError`)
  - `apps/agent/src/agent/chat_turn/runner.py:37` (import `OutputGuardrailPipeline`)
  - `apps/agent/src/agent/chat_turn/runner.py:196` (type annotation)
  - `apps/agent/src/agent/chat_turn/runner.py:358` (type annotation / default)
  - `apps/agent/src/agent/chat_turn/runner.py:547` (instantiation)
  - `apps/agent/src/agent/chat_turn/runner.py:1239` (exception handler)

### Query 5
- **Command**: `rg -n "^(async )?def (deterministic_pii_match|_is_output_guardrail_disabled|approved_model_content)" apps/agent/src/agent --glob "*.py"`
- **Matches**: 3
  - `apps/agent/src/agent/guardrails/output_pipeline.py:71` (`def deterministic_pii_match`)
  - `apps/agent/src/agent/guardrails/output_pipeline.py:130` (`def _is_output_guardrail_disabled`)
  - `apps/agent/src/agent/guardrails/output_pipeline.py:158` (`async def approved_model_content`)
