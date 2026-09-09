# Phase 4 final standards re-review

Scope: prior S-01 atomic-batch and S-02 commit-warning findings only. No broader audit was performed. The duplicated intent allowlist advisory remains intentionally deferred.

## Re-review result

- **P1 S-01 atomicity: resolved.** `custom_tool_node` validates all staged entries, rejects multi-owner batches, coalesces same-owner entries to the latest envelope, and calls `commit_next` once after the complete gateway batch (`apps/agent/src/agent/graph/nodes.py:105-138`). `TrustedSearchSnapshotLifecycle.commit_next` delegates to `save_next_snapshot`, whose Redis Lua script checks the active snapshot plus issued/accepted fences and writes the snapshot and both counters in one atomic execution (`apps/agent/src/agent/trusted_search_snapshot/repository.py:129-205,361-400`). The two-call late version/write regressions preserve the previous snapshot and counters and emit no messages.

- **P2 commit-failure logging: resolved.** The fail-closed catch now emits only the static `trusted_search_snapshot_batch_commit_failed` event (`nodes.py:133-138`); the regression asserts the canary is absent.

- **Redis test classification: clean.** The new live Redis fence test is explicitly marked `redis_integration` (`apps/agent/tests/test_trusted_search_snapshot_lifecycle.py:672-674`). The marker is registered in `apps/agent/pyproject.toml`, excluded by the unit CI command, and included by the separate required Redis CI command (`.github/workflows/ci.yml:425-435`); it does not become an inadvertent unit-CI requirement.

## Verification

Fix-wave verification reports **349 agent tests passed, 1 skipped**, **49 GOAL tests passed**, Ruff check/format passed, and the live Redis fence regression passed. No genuine introduced blocking issue remains in this scoped re-review.

**Verdict:** prior S-01 and S-02 findings are closed; final standards sign-off is clean within the requested scope.
