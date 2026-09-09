# Phase 4 T026 Working Report

## Scope

- Baseline: `77caeed` on branch `023-security-systems`.
- Pre-existing deletion preserved: `specs/023-security-systems/t007-implementation-plan.md`.
- Pre-implementation prerequisite check: `.specify/scripts/powershell/check-prerequisites.ps1 -Json -RequireTasks -IncludeTasks` exited `0` and resolved feature `specs/023-security-systems` with `tasks.md` available.
- Extension hooks: `.specify/extensions.yml` has no `hooks.before_implement` entry.

## RED / GREEN evidence

### RED 1: forged routing provenance

- Test: `test_forged_routing_provenance_fails_closed_before_router_authority` in `apps/agent/tests/security/test_tool_integration.py`.
- Assertion: caller supplied routing provenance must be rejected before classifier invocation and return `route=general`, `routing_provenance=missing_provenance`, static clarification, and an empty sealed tool tuple.
- Exact command:

  ```powershell
  $env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'; $env:PYTHONPATH = "$PWD/tests/ci/python;$PWD/apps/agent/src"; uv run --package agent pytest apps/agent/tests/security/test_tool_integration.py -k forged_routing_provenance -x -v
  ```

- Observed result before graph production edits: `1 failed`, exit code `1`. Baseline returned `route=travel` instead of `route=general`; only pytest cache permission warnings were reported.

### GREEN 1: trusted router rejection

- Exact command:

  ```powershell
  $env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'; $env:PYTHONPATH = "$PWD/tests/ci/python;$PWD/apps/agent/src"; uv run --package agent pytest apps/agent/tests/security/test_tool_integration.py -k forged_routing_provenance -q
  ```

- Observed result after the trusted router/sealer changes: `1 passed`, exit code `0`; one known pytest cache permission warning.

### GREEN 2: configuration capability fallback denied

- Test: `test_custom_tool_node_rejects_capabilities_supplied_only_by_config` in `apps/agent/tests/security/test_tool_integration.py`.
- Assertion: graph dispatch must read capabilities only from state, reject config-only authority, return the static tool schema block, and resolve/invoke zero tools.
- Exact command:

  ```powershell
  $env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'; $env:PYTHONPATH = "$PWD/tests/ci/python;$PWD/apps/agent/src"; uv run --package agent pytest apps/agent/tests/security/test_tool_integration.py -k custom_tool_node_rejects -x -v
  ```

- Observed result: `1 passed`, `1 deselected`, exit code `0`; one known pytest cache permission warning. This assertion was added after the config fallback was removed and therefore is recorded as a post-change regression check rather than a separate RED cycle.

### Focused T026 GREEN suite

- Exact command:

  ```powershell
  $env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'; $env:PYTHONPATH = "$PWD/tests/ci/python;$PWD/apps/agent/src"; uv run --package agent pytest apps/agent/tests/security/test_tool_authority.py apps/agent/tests/test_checkout_gate.py apps/agent/tests/test_graph.py apps/agent/tests/test_chat_turn_runner.py -q
  ```

- Observed result: `73 passed, 1 skipped`, exit code `0`; one known pytest cache permission warning.

- Direct gate regression command:

  ```powershell
  $env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'; $env:PYTHONPATH = "$PWD/tests/ci/python;$PWD/apps/agent/src"; uv run --package agent pytest apps/agent/tests/test_checkout_gate.py -k fails_closed -q
  ```

- Observed result: `2 passed, 8 deselected`, exit code `0`; one known pytest cache permission warning.

- Ruff command:

  ```powershell
  $env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'; uv run --package agent ruff check apps/agent/src/agent/guardrails/capabilities.py apps/agent/src/agent/graph apps/agent/src/agent/chat_turn/runner.py apps/agent/tests/security/test_tool_integration.py
  ```

- Observed result: `All checks passed!`, exit code `0`.

### Final T026 scoped checks

- Integration file command:

  ```powershell
  $env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'; $env:PYTHONPATH = "$PWD/tests/ci/python;$PWD/apps/agent/src"; uv run --package agent pytest apps/agent/tests/security/test_tool_integration.py -q
  ```

- Observed result: `2 passed`, exit code `0`; one known pytest cache permission warning.

- Combined scoped command:

  ```powershell
  $env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'; $env:PYTHONPATH = "$PWD/tests/ci/python;$PWD/apps/agent/src"; uv run --package agent pytest apps/agent/tests/security/test_tool_authority.py apps/agent/tests/test_checkout_gate.py apps/agent/tests/test_graph.py apps/agent/tests/test_chat_turn_runner.py apps/agent/tests/security/test_tool_integration.py -q
  ```

- Observed result: `77 passed, 1 skipped`, exit code `0`; one known pytest cache permission warning.

- Final Ruff commands: `ruff check` and `ruff format --check` over the T026 production/test paths; both exited `0` (`All checks passed!`; `10 files already formatted`).

## Current implementation status

- Router provenance is output-only and caller supplied provenance fails closed before model invocation.
- Sealing requires explicit trusted provenance; omitted provenance returns an empty seal.
- Invalid or unknown gate inputs return a safe general route and empty authority.
- Graph tool dispatch no longer accepts `configurable.turn_capabilities` and parses checkout signals only from validated checkout results.
- Remaining work: run the focused T026 authority, gate, graph, runner, and Ruff checks; inspect compatibility failures; do not commit in this worker slice.
