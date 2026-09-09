# Phase 4 T027 Working Report

## Scope

- Added the tool-boundary integration suite in `apps/agent/tests/security/test_tool_integration.py`.
- Narrow production fixes are limited to `apps/agent/src/agent/graph/nodes.py` and `apps/agent/src/agent/chat_turn/runner.py`.
- With explicit user approval on 2026-09-08, updated only the two stale `test_tool_boundary.py` fixtures to place sealed capabilities in graph state, matching T026's state-only authority contract. Payload, callback, and canary assertions were preserved.
- Preserved the pre-existing deletion `specs/023-security-systems/t007-implementation-plan.md` and all unrelated working-tree edits.
- No commit, branch, worktree, or review-agent action was performed.

## RED / GREEN evidence

### RED 1: owner/session snapshot tampering

- Test: `test_tampered_snapshot_is_rejected_before_handoff`.
- Exact command:

  ```powershell
  $env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'; $env:PYTHONPATH = "$PWD/tests/ci/python;$PWD/apps/agent/src"; uv run --package agent pytest apps/agent/tests/security/test_tool_integration.py -k tampered_snapshot -x -q
  ```

- Before the production fix: `1 failed, 4 deselected`, exit code `1`.
- Cause: `validate_handoff` trusted the graph state's caller-supplied snapshot and did not consume the configured owner/session-bound snapshot.

### GREEN 1: owner/session snapshot tampering

- `validate_handoff` now loads the configured active snapshot when a repository is supplied, rejects missing or mismatched owner/session data, and returns the validated snapshot to graph state. The runner's already owner-bound `trusted_snapshot` config is also accepted and takes precedence over a tampered state copy.
- The same exact command after the fix: `1 passed, 4 deselected`, exit code `0`; one known pytest cache-permission warning.

### RED 2: unvalidated tool message

- Test: `test_unvalidated_tool_message_emits_static_error_and_releases_lease`.
- Exact command:

  ```powershell
  $env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'; $env:PYTHONPATH = "$PWD/tests/ci/python;$PWD/apps/agent/src"; uv run --package agent pytest apps/agent/tests/security/test_tool_integration.py -k unvalidated_tool_message -x -q
  ```

- Before the production fix: `1 failed, 8 deselected`, exit code `1`.
- Cause: the runner silently skipped an unmarked `ToolMessage`, released the lease, and emitted no static error.

### GREEN 2: unvalidated tool message

- `ChatTurnRunner` now finalizes cleanup with `GUARDRAIL_TOOL_SCHEMA` and the existing static error text before any public projection or persistence when a tool message lacks `guardrail_validated=True`.
- The same exact command after the fix: `1 passed, 8 deselected`, exit code `0`; one known pytest cache-permission warning.

### Integration security cases

These tests exercise the real production gateway/guardrail registry, real graph tool node, real snapshot repository, and real runner cleanup paths; external tool/storage/model boundaries use synthetic doubles only.

- `test_forged_signal_and_prompt_injection_never_enter_state_or_events`: blocked forged checkout signal, injection directive, credential, and card; no graph message/signal or canary.
- `test_mixed_batch_denial_invokes_zero_members`: whole-batch denial invokes neither member.
- `test_blocked_tool_turn_emits_static_error_and_releases_lease`: static error, one lease release, no agent persistence; telemetry contains only bounded operation/tool labels and no canary.
- `test_validated_checkout_result_is_the_only_handoff_source`: exactly one `ACTION_HANDOFF`, opaque token only in that event, callback token ignored.
- `test_disconnect_after_raw_tool_callback_releases_lease_without_persistence`: cancellation after raw callback releases the lease once without persisting callback data.
- `test_unvalidated_tool_message_emits_static_error_and_releases_lease`: validated marker is mandatory before public result projection.

Exact focused command and result:

```powershell
$env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'; $env:PYTHONPATH = "$PWD/tests/ci/python;$PWD/apps/agent/src"; uv run --package agent pytest apps/agent/tests/security/test_tool_integration.py -q
```

Result: `9 passed`, exit code `0`; one known pytest cache-permission warning.

## Adjacent regression evidence

The T027 plan command was run exactly:

```powershell
$env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'; $env:PYTHONPATH = "$PWD/tests/ci/python;$PWD/apps/agent/src"; uv run --package agent pytest apps/agent/tests/security/test_tool_integration.py apps/agent/tests/security/test_tool_boundary.py apps/agent/tests/security/test_tool_layers.py apps/agent/tests/security/test_tool_schemas.py apps/agent/tests/security/test_tool_authority.py apps/agent/tests/test_tools.py apps/agent/tests/test_graph.py apps/agent/tests/test_chat_turn_runner.py apps/agent/tests/test_handoff_nodes.py apps/agent/tests/test_search_snapshot.py apps/agent/tests/test_trusted_search_snapshot_lifecycle.py -q
```

Result after the explicitly approved fixture-only correction: `342 passed, 1 skipped`, exit code `0`; one known pytest cache-permission warning. The two corrected tests now provide `turn_capabilities` in graph state and no longer provide it through `configurable`; every payload, callback, and canary assertion is unchanged.

The focused integration/tools/graph/runner command also passed:

```powershell
$env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'; $env:PYTHONPATH = "$PWD/tests/ci/python;$PWD/apps/agent/src"; uv run --package agent pytest apps/agent/tests/security/test_tool_integration.py apps/agent/tests/security/test_tool_boundary.py apps/agent/tests/test_tools.py apps/agent/tests/test_graph.py apps/agent/tests/test_chat_turn_runner.py -q
```

Result: `72 passed, 1 skipped`, exit code `0`; one known pytest cache-permission warning.

## Ruff evidence

```powershell
$env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'; uv run --package agent ruff check apps/agent
```

Result: `All checks passed!`, exit code `0`.

```powershell
$env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'; uv run --package agent ruff format --check apps/agent
```

Result: `154 files already formatted`, exit code `0`.

## Implementation status

- T027 integration proof is complete and green in the new security suite.
- Snapshot owner/session binding and validated-result enforcement are covered by production behavior and RED-to-GREEN evidence above.
- The explicitly approved fixture correction closed both stale T026 config-fallback assumptions; no further Python edits are pending in this worker slice.
