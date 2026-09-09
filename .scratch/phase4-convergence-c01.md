# Phase 4 convergence C-01 closure

Date: 2026-09-08  
Scope: GuardrailGateway empty production tool registry

## Judgment

C-01 was an actionable fail-closed gap at the production gateway boundary.
`main.py` constructs the application gateway with
`GuardrailGateway(create_production_registry())`, and the SSE fallback uses the
same production registry. That registry includes the four compulsory tool
layers. However, `GuardrailGateway.validate_tool_result` accepted any
`GuardrailRegistry` and returned a raw result as `ValidatedToolResult` when the
tool stage had zero layers. A production-mode registry can be empty if it is
misconstructed or its layer set is corrupted, so the raw result could reach
`custom_tool_node` and become a marked `ToolMessage`.

The fix keeps the existing nonproduction empty registries used by authority
tests as test doubles. When a production-mode registry has no tool layers, the
gateway now returns `BLOCK` with `GUARDRAIL_TOOL_SCHEMA` and no validated data.
The graph integration regression proves that the tool invocation may complete,
but no message, graph update, or raw canary is published. Existing authority
tests and their expectations were left unchanged.

## RED

Added `test_empty_production_registry_blocks_before_state_boundary` to
`apps/agent/tests/security/test_tool_integration.py`, using a sealed search
capability, a production-mode empty registry, and a raw canary tool result.

Command:

```powershell
$env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'; $env:PYTHONPATH = "$PWD\tests\ci\python;$PWD\apps\agent\src"; uv run --package agent pytest apps/agent/tests/security/test_tool_integration.py -k empty_production_registry -x -q
```

Observed result: `1 failed, 9 deselected, 2 warnings`, exit code `1`. The
failure was the missing `tool_blocked` update because the empty registry branch
returned `PASS` with raw data.

## GREEN

The narrow production fix is in
`apps/agent/src/agent/guardrails/gateway.py`: an empty tool stage blocks when
`registry.production` is true, while the deliberate nonproduction test-double
behavior remains unchanged.

Focused regression command:

```powershell
$env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'; $env:PYTHONPATH = "$PWD\tests\ci\python;$PWD\apps\agent\src"; uv run --package agent pytest apps/agent/tests/security/test_tool_integration.py -k empty_production_registry -x -q
```

Observed result: `1 passed, 9 deselected, 1 warning`, exit code `0`.

Literal T027 adjacent command:

```powershell
$env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'; $env:PYTHONPATH = "$PWD\tests\ci\python;$PWD\apps\agent\src"; uv run --package agent pytest apps/agent/tests/security/test_tool_integration.py apps/agent/tests/security/test_tool_boundary.py apps/agent/tests/security/test_tool_layers.py apps/agent/tests/security/test_tool_schemas.py apps/agent/tests/security/test_tool_authority.py apps/agent/tests/test_tools.py apps/agent/tests/test_graph.py apps/agent/tests/test_chat_turn_runner.py apps/agent/tests/test_handoff_nodes.py apps/agent/tests/test_search_snapshot.py apps/agent/tests/test_trusted_search_snapshot_lifecycle.py -q
```

Observed result: `343 passed, 1 skipped, 1 warning`, exit code `0`.

Static checks:

- `uv run --package agent ruff check apps/agent` — exit code `0` (`All checks passed!`).
- `uv run --package agent ruff format --check apps/agent` — exit code `0` (`154 files already formatted`).

The only warning in these runs was the pre-existing pytest cache permission
warning under `apps/agent/.pytest_cache`.
