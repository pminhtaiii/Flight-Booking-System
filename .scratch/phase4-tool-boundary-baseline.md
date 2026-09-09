# Phase 4 tool-boundary baseline

Date: 2026-09-08  
Branch: `023-security-systems`  
Scope: read-only baseline for T026-T028 before implementation.

The worktree already contained the unrelated deletion `specs/023-security-systems/t007-implementation-plan.md`; it was preserved. No source or test files were changed by these runs.

## Runtime

- `uv 0.11.18`, `pnpm 11.9.0`, Node `v24.14.0`, Docker Compose `v5.0.2`.
- `uv run` selected Python `3.11.15` from the repository environment (`apps/agent/.python-version` is `3.11`).
- CI uses Node 20; the local Node 24 runtime is a version difference to keep in mind.
- `docker compose ps` returned no running services. Docker Compose also warned that `C:\Users\taiph\.docker\config.json` was inaccessible.

## Agent baseline: core T001/T028 regression set

Command from `C:\Booking Systems`:

```powershell
$env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'
$env:PYTHONPATH = "$PWD\tests\ci\python;$PWD\apps\agent\src"
uv run --package agent pytest apps/agent/tests/test_tools.py apps/agent/tests/test_graph.py apps/agent/tests/test_handoff_nodes.py apps/agent/tests/test_search_snapshot.py
```

Result: exit code `0`; `65 passed` in `56.89s`.

Pytest emitted one pre-existing cache warning because it could not write `apps/agent/.pytest_cache` (`WinError 5`). The warning did not affect collection or test results.

## Agent baseline: router/gate/runner regression set

Command:

```powershell
$env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'
$env:PYTHONPATH = "$PWD\tests\ci\python;$PWD\apps\agent\src"
uv run --package agent pytest apps/agent/tests/test_router.py apps/agent/tests/test_checkout_gate.py apps/agent/tests/test_chat_turn_runner.py
```

Result: exit code `0`; `29 passed, 1 skipped` in `13.13s`.

The skip is intentional and pre-existing: `test_runner_cancellation_bounded_timeout_on_stuck_dependency` calls `pytest.skip("Legacy shielded-persistence drill superseded by deterministic Phase 3 cleanup")`.

The same pytest cache warning appeared.

## API baseline: blocked before Jest startup

Required scoped command, with the repository network guard:

```powershell
$env:NODE_OPTIONS = "--require=$PWD\tests\ci\node-network-guard.cjs"
pnpm --filter @api/backend test -- --runInBand src/chat-handoff/ src/agent-gateway/
```

Result: exit code `1` before Jest startup. Node parsed the workspace path at the space as `C:\Booking` and reported `Cannot find module 'C:\Booking'`.

One corrective attempt quoted the absolute path:

```powershell
$env:NODE_OPTIONS = '--require="C:\Booking Systems\tests\ci\node-network-guard.cjs"'
pnpm --filter @api/backend test -- --runInBand src/chat-handoff/ src/agent-gateway/
```

Result: exit code `1` before Jest startup. Node stripped the Windows backslashes while parsing `NODE_OPTIONS` and reported `Cannot find module 'C:Booking Systemstestscinode-network-guard.cjs'`.

Per the repository rule to stop after one corrective attempt for the same persistent failure, the API baseline is blocked on the Windows `NODE_OPTIONS`/space-in-path interaction. It was not bypassed by running without the network guard.

### Authorized retry with forward-slash preload path

After explicit authorization to retry, the same scoped API command was run with a quoted forward-slash preload path and the dedicated scorer specs:

```powershell
$env:NODE_OPTIONS = '--require="C:/Booking Systems/tests/ci/node-network-guard.cjs"'
pnpm --filter @api/backend test -- --runInBand src/chat-handoff/ src/agent-gateway/ src/flight-match/flight-match-scorer.service.spec.ts src/flight-match/category-ranker.service.spec.ts src/flight-match/flight-match.policy.spec.ts
```

Result: exit code `0`; `15` suites passed and `424` tests passed in `175.837s`.

The run included the handoff, gateway, attestation, and search specs plus the dedicated scorer, category-ranker, and policy specs. Nest emitted expected warning/error logs from simulated disabled-feature and unavailable-database cases, and Node emitted an existing `url.parse()` deprecation warning; none represented failed tests.

## Static selection counts

These are inventory counts, not substitutes for execution evidence:

- `apps/agent/tests/test_handoff_nodes.py`: 13 test functions.
- `apps/agent/tests/test_search_snapshot.py`: 12 test functions.
- `apps/agent/tests/test_tools.py`: 28 test functions.
- `apps/agent/tests/test_graph.py`: 6 test functions.
- The API command selects 13 spec files under `src/chat-handoff/` and `src/agent-gateway/`, containing approximately 165 `it(...)` blocks.

## Scoring, attestation, and trusted snapshot inventory

The scoped API command includes the gateway-facing scoring and attestation contracts:

- `apps/api/src/agent-gateway/attested-flight-search/attested-flight-search.service.spec.ts`: 22 `it(...)` blocks covering V1/V2 projection, MATCHED/RANKED scoring metadata, exact ranked order, snapshot expiry, and deterministic offer binding.
- `apps/api/src/agent-gateway/attested-flight-search/attested-flight-search.persistence.spec.ts`: 2 `it(...)` blocks covering commit failure and baggage preservation.
- `apps/api/src/agent-gateway/selection-attestation.service.spec.ts`: 25 `it(...)` blocks covering offer tampering/order, owner/session/version mismatches, expiry, malformed payloads, timing-safe signature checks, and key rotation.

The dedicated scorer specs are outside the literal T028 path but were included in the authorized retry:

- `apps/api/src/flight-match/flight-match-scorer.service.spec.ts`: 130 `it(...)` blocks covering eligibility, all scoring dimensions, weights, degenerate sets, final score buckets, metadata, and stable tie-breaking.
- `apps/api/src/flight-match/category-ranker.service.spec.ts`: 16 `it(...)` blocks covering deterministic category ranking and module registration.
- `apps/api/src/flight-match/flight-match.policy.spec.ts`: 80 `it(...)` blocks covering policy constants and scoring math.

The core baseline ran all 12 functions in `apps/agent/tests/test_search_snapshot.py`, including V2 client contracts, identifier stripping, monotonic overwrite, TTL/expiry, cross-user/session isolation, privacy projection, score-field rejection, strict extra-field rejection, and score-free Redis serialization. The deeper lifecycle file was inventoried but not run in this baseline:

- `apps/agent/tests/test_trusted_search_snapshot_lifecycle.py`: 31 test functions covering stale-version fencing, retained counters, corrupt-state recovery, Lua fail-closed behavior, TTL bounds, owner-scoped persistence, one-based selection, graph-state normalization, monotonic/concurrent version allocation, and score-free persistence.
- `apps/agent/tests/test_trusted_snapshot.py`: 10 test functions covering schema validation, forbidden fields, repository replace/overwrite/TTL/delete.

## Handoff E2E feasibility

No E2E command was started. The existing candidates and prerequisites are:

- Backend: `pnpm --filter @api/backend test:e2e -- test/chat-handoff.e2e-spec.ts test/chat-handoff-concurrency.e2e-spec.ts test/chat-handoff-observability.e2e-spec.ts`. The Jest E2E specs bootstrap NestJS and Prisma and use the agent probe helpers; they require the configured test database/Redis and working `uv` subprocess resolution.
- Browser: `& '.\apps\web\node_modules\.bin\playwright.CMD' test apps/web/tests/chat-checkout-handoff.spec.ts --config=apps/web/tests/playwright.config.ts --reporter=line`. The config starts a Next server and API server by default, sets `DATABASE_URL`/`REDIS_URL`, and the test performs real registration/login while mocking the agent SSE stream. It therefore needs PostgreSQL/Redis and the installed Chromium browser.

The scoped T026-T028 change has no schema migration or direct payment mutation, so the explicit T028 API unit and agent regression gates are the immediate evidence. Because it spans graph modules and preserves the user-facing handoff boundary, the existing handoff E2E candidates remain appropriate before release when services are available.
