# Phase 4 final API and agent regression report

Date: 2026-09-08

No source or test files were changed for this verification task. Existing Docker PostgreSQL and Redis services were reused; no migration, seed, reset, or database creation command ran.

## Guarded API regression set

Exact command:

```powershell
$ErrorActionPreference = 'Continue'
$env:NODE_OPTIONS = '--require="C:/Booking Systems/tests/ci/node-network-guard.cjs"'
pnpm --filter @api/backend test -- --runInBand src/chat/ src/chat-handoff/ src/agent-gateway/ src/flight-match/flight-match-scorer.service.spec.ts src/flight-match/category-ranker.service.spec.ts src/flight-match/flight-match.policy.spec.ts
$code = $LASTEXITCODE
Write-Output ('api_scoped_units_exit=' + $code)
exit $code
```

Result: exit 0; 18 suites passed, 462 tests passed, 0 failed. Expected simulated error/warning logs and the existing Node `url.parse()` deprecation warning were emitted.

## Shared types

Exact command:

```powershell
pnpm --filter @shared/types test
```

Result: exit 0; 23 suites passed, 110 tests passed, 0 failed.

API lint and direct workspace TypeScript checks were already green in `.scratch/phase4-api-empty-content-report.md`; no API files changed after those checks, so they were not duplicated here.

## Full agent-chat gateway E2E

Exact command and database environment:

```powershell
$ErrorActionPreference = 'Continue'
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
$env:NODE_ENV = 'test'
$env:DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/test_db'
$env:REDIS_URL = 'redis://127.0.0.1:6379/1'
Push-Location apps/api
& '.\node_modules\.bin\jest.CMD' --config '.\test\jest-e2e.json' --runInBand test/agent-chat-gateway.e2e-spec.ts
$code = $LASTEXITCODE
Pop-Location
Write-Output ('agent_chat_gateway_e2e_exit=' + $code)
exit $code
```

Result: exit 0; 1 suite passed, 12 tests passed, 0 failed, about 153 seconds. The empty-agent turn regression passed with a complete encrypted envelope and round-trip response.

## Literal GOAL agent command

Exact command:

```powershell
$ErrorActionPreference = 'Continue'
$env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'
$env:PYTHONPATH = "$PWD\tests\ci\python;$PWD\apps\agent\src"
uv run --package agent pytest apps/agent/tests/security/test_tool_integration.py apps/agent/tests/test_tools.py apps/agent/tests/test_graph.py
$code = $LASTEXITCODE
Write-Output ('goal_agent_exit=' + $code)
exit $code
```

Result: exit 1; 44 tests collected, 43 passed, 1 failed. The failing test was `test_empty_tool_registry_blocks_before_state_boundary`, which raised `KeyError: 'tool_blocked'` because the returned update lacked that key. This is the only assertion failure in this command. Pytest also emitted two existing cache permission warnings for `apps/agent/.pytest_cache`.

No T093 rerun was performed during this verification task. No destructive database operation was performed.

## Final GOAL agent rerun after C01 completion

The earlier RED result was superseded after the C01 worker completed its implementation. Exact command:

```powershell
$ErrorActionPreference = 'Continue'
$env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'
$env:PYTHONPATH = "$PWD\tests\ci\python;$PWD\apps\agent\src"
uv run --package agent pytest apps/agent/tests/security/test_tool_integration.py apps/agent/tests/test_tools.py apps/agent/tests/test_graph.py
$code = $LASTEXITCODE
Write-Output ('goal_agent_exit=' + $code)
exit $code
```

Result: exit 0; 44 tests collected and 44 passed in about 13 seconds. One existing pytest cache permission warning remained; there were no failures or skips.
