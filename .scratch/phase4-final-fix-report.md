# Phase 4 final Python fix pass

Date: 2026-09-08  
Scope: S-01 snapshot side-effect ordering and S-02 bounded handoff-read warning

## S-01 — snapshot persistence follows the validated graph boundary

`search_flights` previously allocated a snapshot version and called
`create_or_replace` before `custom_tool_node` passed its result through the
four-layer gateway. The graph path now supplies a private, local staging map to
the real registered search tool. Graph search calls stage the owner and
attested envelope without allocating a version or writing storage. After the
entire `execute_tool_batch` returns `PASS`, `custom_tool_node` allocates the
owner version, verifies it matches the attested envelope, and commits the
staged snapshot. A blocked batch clears the local staging map and publishes no
message. Direct `search_flights.ainvoke()` calls retain their existing
snapshot-persistence behavior.

The regression uses the actual registered `search_flights` tool, a real
`TrustedSearchSnapshotLifecycle`, a mocked upstream client, and a recording
storage repository. It proves a four-layer-blocked result leaves the active
snapshot, version allocator, repository writes, and trusted config snapshot
unchanged.

### S-01 RED

Command:

```powershell
$env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'; $env:PYTHONPATH = "$PWD\tests\ci\python;$PWD\apps\agent\src"; uv run --package agent pytest apps/agent/tests/security/test_tool_integration.py -k blocked_real_search -x -q
```

Observed result: `1 failed, 10 deselected, 2 warnings`, exit code `1`.
The real search path allocated one snapshot version before the gateway blocked
the injection-bearing result (`next_version_calls == 1`).

### S-01 GREEN

The graph-scoped staging and post-batch commit changes are in
`apps/agent/src/agent/graph/nodes.py` and
`apps/agent/src/agent/tools/search_flights.py`.

Command:

```powershell
$env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'; $env:PYTHONPATH = "$PWD\tests\ci\python;$PWD\apps\agent\src"; uv run --package agent pytest apps/agent/tests/security/test_tool_integration.py -k blocked_real_search -x -q
```

Observed result: `1 passed, 10 deselected, 1 warning`, exit code `0`.

Existing direct-tool and graph compatibility command:

```powershell
$env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'; $env:PYTHONPATH = "$PWD\tests\ci\python;$PWD\apps\agent\src"; uv run --package agent pytest apps/agent/tests/test_tools.py apps/agent/tests/test_graph.py -q
```

Observed result: `34 passed, 1 warning`, exit code `0`.

## S-02 — bounded snapshot-read warning

`validate_handoff` now emits the static logger event
`validate_handoff_snapshot_read_failed` when the owner-bound repository read
raises, then returns the existing generic safe error. The warning contains no
exception text, owner/session identifiers, snapshot content, or raw payload.
The regression injects a canary-bearing repository exception and asserts the
safe result and log privacy.

### S-02 RED

Command:

```powershell
$env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'; $env:PYTHONPATH = "$PWD\tests\ci\python;$PWD\apps\agent\src"; uv run --package agent pytest apps/agent/tests/security/test_tool_integration.py -k handoff_snapshot_read_error -x -q
```

Observed result: `1 failed, 11 deselected, 2 warnings`, exit code `1`.

### S-02 GREEN

Command:

```powershell
$env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'; $env:PYTHONPATH = "$PWD\tests\ci\python;$PWD\apps\agent\src"; uv run --package agent pytest apps/agent/tests/security/test_tool_integration.py -k handoff_snapshot_read_error -x -q
```

Observed result: `1 passed, 11 deselected, 1 warning`, exit code `0`.

## Final Python verification

Literal adjacent T027 command:

```powershell
$env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'; $env:PYTHONPATH = "$PWD\tests\ci\python;$PWD\apps\agent\src"; uv run --package agent pytest apps/agent/tests/security/test_tool_integration.py apps/agent/tests/security/test_tool_boundary.py apps/agent/tests/security/test_tool_layers.py apps/agent/tests/security/test_tool_schemas.py apps/agent/tests/security/test_tool_authority.py apps/agent/tests/test_tools.py apps/agent/tests/test_graph.py apps/agent/tests/test_chat_turn_runner.py apps/agent/tests/test_handoff_nodes.py apps/agent/tests/test_search_snapshot.py apps/agent/tests/test_trusted_search_snapshot_lifecycle.py -q
```

Observed result: `345 passed, 1 skipped, 1 warning`, exit code `0`.

Literal GOAL integration/tools/graph command:

```powershell
$env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'; $env:PYTHONPATH = "$PWD\tests\ci\python;$PWD\apps\agent\src"; uv run --package agent pytest apps/agent/tests/security/test_tool_integration.py apps/agent/tests/test_tools.py apps/agent/tests/test_graph.py
```

Observed result: `46 passed, 1 warning`, exit code `0`.

Static checks:

- `uv run --package agent ruff check apps/agent` — exit code `0`, `All checks passed!`.
- `uv run --package agent ruff format --check apps/agent` — exit code `0`, `154 files already formatted`.

The only pytest warning was the known cache-permission warning for
`apps/agent/.pytest_cache`.

The duplicated four-intent allowlist in `graph.py`, `checkout_gate.py`, and
`guardrails/capabilities.py` remains an advisory maintainability item. It was
left unchanged because centralizing it would expand this bounded security fix
without affecting the reported correctness findings.
