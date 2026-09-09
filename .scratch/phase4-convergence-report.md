# Feature 023 Phase 4 T026–T028 Convergence

Date: 2026-09-08  
Scope: GOAL.md final slice only (T026, T027, T028)  
Branch baseline: `023-security-systems` at the documented `77caeed` baseline

## Scope and intent checked

The convergence check compared the GOAL slice, `spec.md` US2/FR-005/FR-006, the
capability-sealing and tool-execution contract, `plan.md` enforcement order, and
the T026–T028 entries in `tasks.md` against the current graph, gateway, runner,
snapshot lifecycle, tests, and existing evidence reports. No git or diff operation
was used, and no source, test, task, or validation-document file was changed.

The prerequisite script exited `0` and resolved
`specs/023-security-systems` with `tasks.md`. `.specify/extensions.yml` contains
only `after_specify` and `after_plan` optional agent-context hooks; there is no
convergence hook to run.

## Evidence already available

- T026 focused authority/gate/graph/runner/integration checks: `77 passed, 1
  skipped`, exit code `0`; Ruff check and format check both exit `0`.
- T027 integration suite: `9 passed`, exit code `0`. The adjacent boundary,
  layer, schema, authority, tools, graph, runner, handoff, and snapshot command
  recorded `342 passed, 1 skipped`, exit code `0`. Full agent Ruff check and
  format check also exit `0`.
- API handoff/gateway plus scorer/category-ranker/policy regression command with
  the corrected forward-slash `NODE_OPTIONS` preload: `15` suites and `424`
  tests passed, exit code `0`.
- Scoring API E2E: `1` suite and `13` tests passed, exit code `0`.
- Agent handoff and trusted snapshot lifecycle replacement suites
  (`test_handoff_nodes.py`, `test_search_snapshot.py`, and
  `test_trusted_search_snapshot_lifecycle.py`): `70 passed`, exit code `0`.
- C-01 empty-production-registry regression: focused check `1 passed`; the
  untracked T027 integration file passes `10 passed`, exit code `0`.
- Atomic S-01 closure regressions: two late version/write failures `2 passed`,
  valid same-owner coalescing `1 passed`, combined boundary/privacy set `5
  passed`, and real Redis owner-fence test `1 passed`, all exit code `0`.
- The saved adjacent post-fix set is `349 passed, 1 skipped`; the literal GOAL
  set is `49 passed`; Ruff check and format checks both exit `0`.
- Prior approved T093 real-flow rerun: Playwright `1/1`, exit code `0`; one
  `ACTION_HANDOFF`, one winning intent with concurrent `409` losers, consumed
  link, zero payments, two supplier calls, and payload-free encrypted
  plaintext evidence. The post-atomic final T093 rerun also passed `1/1`, exit code
  `0`, with the same handoff, payment, encryption, supplier, and privacy assertions.
- Existing evidence is preserved in `.scratch/phase4-t026-report.md`,
  `.scratch/phase4-t027-report.md`, `.scratch/phase4-api-empty-content-report.md`,
  and `docs/security/tool-boundary-validation.md`.

## Convergence findings

### C-01 — T026 empty tool-layer configuration is closed

`GuardrailGateway.validate_tool_result` now blocks before a validated result can
become a marked `ToolMessage` when `registry.ordered_layers("tool")` is empty
in production (`apps/agent/src/agent/guardrails/gateway.py:161-170`). The focused
regression and untracked integration file pass, so the existing T026 requirement
is satisfied and no duplicate convergence task was appended.

### S-01 — validation-before-snapshot ordering is addressed

The T026/US2 ordering requirement scans each tool result before snapshot/state
side effects (`GOAL.md:33`, `docs/superpowers/plans/2026-09-08-phase4-tool-boundary.md:18,220`,
`specs/023-security-systems/spec.md:20`). The graph path stages the
owner/envelope in `apps/agent/src/agent/tools/search_flights.py:252-257`,
coalesces same-owner stages, rejects multi-owner batches, and commits only after
a complete gateway `PASS` (`apps/agent/src/agent/graph/nodes.py:103-142`).
`TrustedSearchSnapshotLifecycle.commit_next` and the Redis Lua owner fence make
snapshot and version-counter writes atomic; focused failure regressions leave
the prior snapshot/counters unchanged. Every validated search still emits its
own `ToolMessage`, and direct tool calls retain their existing persistence
behavior. S-01 is fully addressed; no duplicate task was created.

### C-02 — T028 final rerun and documentation synchronization are complete

The post-atomic T093 rerun provides the authorized `ACTION_HANDOFF`, zero payment
mutations, concurrent loser behavior, supplier count, encryption/privacy evidence,
and disconnect/lease evidence. The exact final evidence and maintained agent
replacement (`apps/agent/tests/test_handoff_nodes.py`) are recorded in the validation
document. This closes the existing T028 gate without adding a new implementation gap.

## Requirement assessment

| Requirement | Assessment | Evidence/source |
|---|---|---|
| Immutable authority cannot expand through state, model proposals, or route transitions | Pass for the implemented graph path | Frozen strict `TurnCapabilities` in `guardrails/base.py:38,51`; state-only read in `graph/nodes.py:59`; tool intersection in the travel/checkout agents; authority tests cover mutation and checkout-to-travel transitions. |
| Malformed/unknown classifier output and forged provenance fail closed while retaining provenance | Pass | `graph/graph.py:24-87` rejects caller-supplied provenance, emits safe general clarification, and seals empty authority; router/gate and forged-provenance tests pass. |
| Mixed or forged tool batches invoke zero members | Pass | `guardrails/gateway.py:175-205` checks every name before invocation; authority and integration tests assert resolver and invoker counts remain zero. |
| Raw tool results are withheld from state, signals, checkpoints, callbacks, and public events | Pass for the graph boundary | `graph/nodes.py:97-142` commits coalesced staged snapshots only after gateway `PASS` with an atomic owner fence, then creates every marked `ToolMessage`; blocked, late-failure, and valid two-search tests pass. Direct tool persistence remains the supported direct-call behavior. |
| Owner/session/snapshot/attestation and handoff validation remain independent | Pass for scoped regressions and final T093 | `graph/nodes.py:244-291` reloads owner/session-bound snapshots and checks version, attestation, expiry, results, and selection; repository/lifecycle, tamper, handoff, and final T093 checks pass. |
| Lease cleanup and bounded telemetry on block/error/disconnect | Pass; final T028 counts/docs recorded | `chat_turn/runner.py:189-276` preserves cleanup ordering; integration tests and final T093 evidence assert one release, no canary persistence, and payload-free allowlisted telemetry. |

## Required closure gates

1. Preserve the final T093 exit code and mutation oracle in the validation record.
2. Preserve the literal T028 backend command and the maintained agent replacement
   command in the validation record:

   ```powershell
   $env:NODE_OPTIONS = '--require="C:/Booking Systems/tests/ci/node-network-guard.cjs"'
   pnpm --filter @api/backend test -- --runInBand src/chat-handoff/ src/agent-gateway/

   $env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'
   $env:PYTHONPATH = "$PWD/tests/ci/python;$PWD/apps/agent/src"
   uv run --package agent pytest apps/agent/tests/test_handoff_nodes.py apps/agent/tests/test_search_snapshot.py
   ```

   Exact counts, exit codes, mutation oracle results, lease cleanup evidence, and the
   final validation document are synchronized; the maintained replacement remains
   `apps/agent/tests/test_handoff_nodes.py`.

## Outcome

**Converged for the T026–T028 behavioral slice.** C-01 and the atomic S-01 fix are
addressed, the post-atomic T093 flow passed, and no new blocking breakage was found
in the bounded re-review. T026, T027, and T028 are recorded complete in
`specs/023-security-systems/tasks.md`; no duplicate tasks or future-phase work were
introduced.
