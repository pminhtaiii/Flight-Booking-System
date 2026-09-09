# Phase 4 atomic snapshot commit fix

Date: 2026-09-09  
Scope: S-01 staged trusted-search snapshot commits in the graph tool gateway. No API or web files were changed.

## Decision

The graph path now keeps every search result private until the complete gateway batch passes. Staged entries for the same owner are validated first and coalesced to the last search envelope, which is the owner’s resulting trusted selection authority while every validated search still produces its own `ToolMessage`. A batch with more than one owner scope fails closed before any commit.

The lifecycle adds `commit_next`, and the repository adds `save_next_snapshot`. The latter uses one Redis Lua script to read the active snapshot and both version fences, require that the envelope version equals the next owner version, and write the snapshot plus issued/accepted counters together. This removes the separate `next_version` then `create_or_replace` window. It avoids rollback, so a failed commit cannot overwrite or delete a concurrent writer’s state. Direct `search_flights.ainvoke()` calls retain their existing allocation and persistence contract.

Commit exceptions return the existing generic tool-block response and emit only the static `trusted_search_snapshot_batch_commit_failed` warning. The warning does not include exception text, owner/session identifiers, snapshot content, or canary data.

## TDD evidence

### RED

Added a real registered `search_flights` two-call batch regression with late version and write failure variants. Before the atomic lifecycle change:

```text
$env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'; $env:PYTHONPATH = "$PWD\tests\ci\python;$PWD\apps\agent\src"; uv run --package agent pytest apps/agent/tests/security/test_tool_integration.py -k 'two_real_searches_fail_closed and version' -x -q
```

Result: exit code `1`; `1 failed, 13 deselected`. The old sequential loop persisted the first `TrustedSearchSnapshot` before the second version failure, so the prior active snapshot was no longer unchanged.

### GREEN

The same failure regression after the fix:

```text
uv run --package agent pytest apps/agent/tests/security/test_tool_integration.py -k two_real_searches_fail_closed -q
```

Result: exit code `0`; `2 passed, 12 deselected`.

The valid multi-search compatibility regression:

```text
uv run --package agent pytest apps/agent/tests/security/test_tool_integration.py -k two_real_searches_commit_latest -x -q
```

Result: exit code `0`; `1 passed, 14 deselected`. Both tool messages are emitted, one atomic commit occurs, and the second search is the final trusted snapshot authority.

The static log/privacy and prior boundary regressions:

```text
uv run --package agent pytest apps/agent/tests/security/test_tool_integration.py -k 'two_real_searches or blocked_real_search or handoff_snapshot_read_error' -q
```

Result: exit code `0`; `5 passed, 10 deselected`.

The repository primitive was exercised against local Redis database 15 using unique owner/session keys and targeted cleanup, without flushing the database:

```text
uv run --package agent pytest apps/agent/tests/test_trusted_search_snapshot_lifecycle.py -k save_next_snapshot_uses_atomic_owner_fence -q
```

Result: exit code `0`; `1 passed, 39 deselected`. The test confirms first commit, stale same-version rejection leaves the snapshot and both counters unchanged, and the next version commits successfully.

## Required regression gates

Adjacent agent baseline plus the new regressions:

```text
uv run --package agent pytest apps/agent/tests/security/test_tool_integration.py apps/agent/tests/security/test_tool_boundary.py apps/agent/tests/security/test_tool_layers.py apps/agent/tests/security/test_tool_schemas.py apps/agent/tests/security/test_tool_authority.py apps/agent/tests/test_tools.py apps/agent/tests/test_graph.py apps/agent/tests/test_chat_turn_runner.py apps/agent/tests/test_handoff_nodes.py apps/agent/tests/test_search_snapshot.py apps/agent/tests/test_trusted_search_snapshot_lifecycle.py -q
```

Result: exit code `0`; `349 passed, 1 skipped`. The skip is the existing cancellation test documented in the prior baseline.

Literal GOAL set:

```text
uv run --package agent pytest apps/agent/tests/security/test_tool_integration.py apps/agent/tests/test_tools.py apps/agent/tests/test_graph.py
```

Result: exit code `0`; `49 passed`.

Static checks:

```text
uv run --package agent ruff check apps/agent
uv run --package agent ruff format --check apps/agent
```

Results: both exit code `0`; Ruff check reported `All checks passed!`, and format reported `154 files already formatted`.

Pytest emitted the pre-existing cache-permission warning for `apps/agent/.pytest_cache`; it did not affect collection or outcomes.
