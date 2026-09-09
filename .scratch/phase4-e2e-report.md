# Phase 4 E2E validation report

Date: 2026-09-08

## Preflight

- Docker services were already running before this task: `flight-postgres` and `flight-redis`. They were left running and unchanged.
- PostgreSQL accepted connections; `test_db` existed. Redis DB 1 returned `PONG`.
- `test_db` was targeted explicitly as `postgresql://postgres:postgres@127.0.0.1:5432/test_db`. Prisma reported 23 migrations and an up-to-date schema (exit 0). No migration, seed, reset, or database creation command was run.
- Prisma client generation exited 0.
- Chrome, the Playwright package, its browser cache, and the T093 helper files were present.
- The documented Next build exited 0.

## Completed checks

### Scorer API E2E

Command, run from the repository root:

```powershell
$env:NODE_ENV = 'test'
$env:DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/test_db'
$env:REDIS_URL = 'redis://127.0.0.1:6379/1'
Push-Location apps/api
& '.\node_modules\.bin\jest.CMD' --config '.\test\jest-e2e.json' --runInBand test/flights-match-scoring.e2e-spec.ts
Pop-Location
```

Result: exit 0; 1 suite passed, 13 tests passed, 0 snapshots, about 88 seconds.

### Agent handoff and trusted snapshot lifecycle

```powershell
$env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'
$env:PYTHONPATH = "$PWD\tests\ci\python;$PWD\apps\agent\src"
uv run --package agent pytest apps/agent/tests/test_handoff_nodes.py apps/agent/tests/test_search_snapshot.py apps/agent/tests/test_trusted_search_snapshot_lifecycle.py -q
```

Result: exit 0; 70 tests passed in about 13 seconds. Pytest emitted one pre-existing cache permission warning for `apps/agent/.pytest_cache`.

## T093 real-flow result

The documented command ran with `T093_REAL_FLOW=true`, the configured test timeouts, and the same explicit `test_db` URL. Its configured API, Mimo, agent, and Next web servers started successfully. The one Chromium test exited 1 after the 120-second browser assertion timeout:

- Expected URL after the registration/login helper: `http://localhost:3000/`.
- Received URL: `http://localhost:3000/dashboard`.

This is the current T093 blocker. It is an application/test redirect contract mismatch, rather than a missing service or database prerequisite. No source or test files were changed. After Playwright teardown, ports 3000-3003 were clear; the pre-existing Docker PostgreSQL and Redis services remained running.

## Approved redirect correction and rerun

The user approved updating the stale post-login assertion. The test now retains `page.goto(`${WEB_ORIGIN}/`)` and expects `/dashboard`, matching `apps/web/app/page.tsx` and the authenticated redirect documented in the architecture. The only test edit is the requested rationale comment and this assertion change.

Exact rerun command:

```powershell
$ErrorActionPreference = 'Continue'
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
$env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'
$env:T093_REAL_FLOW = 'true'
$env:T093_TEST_TIMEOUT_MS = '600000'
$env:T093_STREAM_TIMEOUT_MS = '300000'
$env:T093_BROWSER_TIMEOUT_MS = '120000'
$env:DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/test_db'
& '.\apps\web\node_modules\.bin\playwright.CMD' test 'apps/web/tests/chat-t093-real-flow.spec.ts' --config='apps/web/tests/playwright.config.ts' --reporter=line
$code = $LASTEXITCODE
Write-Output ('t093_playwright_exit=' + $code)
exit $code
```

Result: exit 1; 1 Chromium test executed, 0 passed, 1 failed. The redirect assertion passed, but the second turn produced no `done` event (`expected length 1, received 0`) after the API reported `ChatMessage is missing ciphertext envelope or is corrupted` while persisting the turn. The source path shows `ChatService.createMessageBatch` leaves the ciphertext envelope null when a batched message has falsy content, then immediately decrypts every created message; this is the distinct application persistence blocker exposed after the approved redirect correction. No further assertion weakening or test edits were made.

The T093-owned servers were cleaned up after the rerun; ports 3000-3003 were clear, and the pre-existing Docker services remained running.

## Final rerun after API empty-content fix

The API empty-content persistence fix was present before this run. The approved `/dashboard` assertion was retained without further test edits.

Exact full command and environment:

```powershell
$ErrorActionPreference = 'Continue'
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
$env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'
$env:T093_REAL_FLOW = 'true'
$env:T093_TEST_TIMEOUT_MS = '600000'
$env:T093_STREAM_TIMEOUT_MS = '300000'
$env:T093_BROWSER_TIMEOUT_MS = '120000'
$env:DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/test_db'
& '.\apps\web\node_modules\.bin\playwright.CMD' test 'apps/web/tests/chat-t093-real-flow.spec.ts' --config='apps/web/tests/playwright.config.ts' --reporter=line
$code = $LASTEXITCODE
Write-Output ('t093_playwright_exit=' + $code)
exit $code
```

Result: exit 1; 1 Chromium test executed, 0 passed, 1 failed. The corrected `/dashboard` redirect and API empty-content path were reached without their prior failures. The first signed search then returned no `results` event (`expected length 1, received 0`) while the API logged `AttestedFlightSearchService` failure for V2 search. No `ACTION_HANDOFF`, booking intent, or payment mutation evidence was produced in this run. This is a distinct first-search/upstream blocker; no further test retry or test edit was made.

Playwright cleaned up its owned servers; ports 3000-3003 were clear. The pre-existing Docker PostgreSQL and Redis services remained running. [historical checkpoint]

## Persisted final post-atomic closure record — 2026-09-09

Source checkpoint: `.scratch/phase4-atomic-fix-report.md`, with the atomic snapshot-commit fix active. No source or test files were changed for this run. Local readiness was verified read-only: Docker PostgreSQL/Redis were up, Redis returned `PONG`, and `test_db` retained `HAN|VVNB` and `SGN|VVTS`.

Exact command:

```powershell
$ErrorActionPreference = 'Continue'
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
$env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'
$env:T093_REAL_FLOW = 'true'
$env:T093_TEST_TIMEOUT_MS = '600000'
$env:T093_STREAM_TIMEOUT_MS = '300000'
$env:T093_BROWSER_TIMEOUT_MS = '120000'
$env:DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/test_db'
& '.\apps\web\node_modules\.bin\playwright.CMD' test 'apps/web/tests/chat-t093-real-flow.spec.ts' --config='apps/web/tests/playwright.config.ts' --reporter=line
$code = $LASTEXITCODE
Write-Output ('t093_playwright_exit=' + $code)
exit $code
```

Recorded result: `1 passed (12.2m)` and `t093_playwright_exit=0`. Independent artifact: `C:\Booking Systems\apps\web\test-results\.last-run.json`, read as `{"status":"passed","failedTests":[]}` (last write 2026-09-09 12:32:55). The passing flow asserted one signed search, exactly one `ACTION_HANDOFF`, one winning intent with concurrent 409 losers, one consumed handoff linkage, zero payment rows/calls, supplier calls 2, encrypted and plaintext-free counts each at least 4, no token/provider-ID/attestation leakage, and checkout at `/checkout/passengers`.

This tail record is authoritative for final closure. The earlier append was present at the absolute path but was not at EOF because a concurrent report writer regenerated the document; this record was verified by immediate tail read-back.

## Final post-atomic T093 verification — 2026-09-09

This is the final run from the current source checkpoint documented in `.scratch/phase4-atomic-fix-report.md` (atomic snapshot commit fix; adjacent agent gates 349 passed/1 skipped, literal GOAL set 49 passed, Ruff green). The approved URL and ciphertext-envelope assertions were unchanged. The local service/fixture preflight was read-only: Docker PostgreSQL and Redis were available, Redis returned `PONG`, and `test_db` retained exactly `HAN|VVNB` and `SGN|VVTS`.

Exact command and environment:

```powershell
$ErrorActionPreference = 'Continue'
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
$env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'
$env:T093_REAL_FLOW = 'true'
$env:T093_TEST_TIMEOUT_MS = '600000'
$env:T093_STREAM_TIMEOUT_MS = '300000'
$env:T093_BROWSER_TIMEOUT_MS = '120000'
$env:DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/test_db'
& '.\apps\web\node_modules\.bin\playwright.CMD' test 'apps/web/tests/chat-t093-real-flow.spec.ts' --config='apps/web/tests/playwright.config.ts' --reporter=line
$code = $LASTEXITCODE
Write-Output ('t093_playwright_exit=' + $code)
exit $code
```

Observed tool output: `1 passed (12.2m)` followed by `t093_playwright_exit=0`. The Playwright result artifact independently corroborates the final status at `C:\Booking Systems\apps\web\test-results\.last-run.json` (read-back content: `{"status":"passed","failedTests":[]}`; last write 2026-09-09 12:32:55). The flow asserted one signed search and exactly one `ACTION_HANDOFF`; one winning booking intent with all concurrent losers rejected with 409; one consumed handoff linked to that intent; zero payment rows and zero payment calls; supplier call count 2; encrypted chat message count and plaintext-free encrypted count each at least 4; no handoff token in URLs, DOM, browser storage, console, or non-handoff SSE payloads; no provider identifiers or selection attestations in browser request URLs; and checkout at `/checkout/passengers`.

The T093-owned servers were cleaned up; the pre-existing Docker PostgreSQL and Redis services remained running. An earlier post-atomic append was overwritten by a concurrent report regeneration; this section is persisted at the absolute report path above and was verified by immediate read-back.

## Final T093 rerun after atomic snapshot-commit fix — 2026-09-09

This run used the current source checkpoint documented in `.scratch/phase4-atomic-fix-report.md`. The atomic trusted-search snapshot commit fix was present; the approved `/dashboard` and ciphertext-envelope assertions were unchanged. Read-only preflight confirmed PostgreSQL/Redis readiness and the retained SGN/HAN fixture in local `test_db`; no source/test edits, migrations, seeds, resets, or redundant API runs were performed.

Exact full command and environment:

```powershell
$ErrorActionPreference = 'Continue'
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
$env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'
$env:T093_REAL_FLOW = 'true'
$env:T093_TEST_TIMEOUT_MS = '600000'
$env:T093_STREAM_TIMEOUT_MS = '300000'
$env:T093_BROWSER_TIMEOUT_MS = '120000'
$env:DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/test_db'
& '.\apps\web\node_modules\.bin\playwright.CMD' test 'apps/web/tests/chat-t093-real-flow.spec.ts' --config='apps/web/tests/playwright.config.ts' --reporter=line
$code = $LASTEXITCODE
Write-Output ('t093_playwright_exit=' + $code)
exit $code
```

Result: exit 0; 1 Chromium test passed. Playwright reported `1 passed (12.2m)`. The flow asserted one signed search and exactly one `ACTION_HANDOFF`; one winning booking intent with all concurrent losers rejected with 409; one consumed handoff linked to that intent; zero payment rows and zero payment calls; supplier call count 2; encrypted chat message count and plaintext-free encrypted count each at least 4; no handoff token in URLs, DOM, browser storage, console, or non-handoff SSE payloads; no provider identifiers or selection attestations in browser request URLs; and checkout at `/checkout/passengers`.

The API emitted transient startup/flow warnings for a booking-intent expiration transaction timeout and Pydantic serialization diagnostics; the test completed successfully afterward. Playwright cleaned up its owned servers; pre-existing Docker PostgreSQL and Redis services remained running. This post-atomic result supersedes the earlier pre-atomic successful T093 checkpoint for final closure evidence.

## Final T093 rerun after S01 snapshot-ordering fix — 2026-09-09

This run used the current stable Python snapshot after the S01 side-effect ordering fix documented in `.scratch/phase4-final-fix-report.md`. The previously approved `/dashboard` and ciphertext-envelope assertions were unchanged. Read-only preflight confirmed PostgreSQL readiness, Redis `PONG`, and the retained two-row SGN/HAN fixture in `test_db`; no migrations, seeds, resets, or source/test edits were made.

Exact full command and environment:

```powershell
$ErrorActionPreference = 'Continue'
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
$env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'
$env:T093_REAL_FLOW = 'true'
$env:T093_TEST_TIMEOUT_MS = '600000'
$env:T093_STREAM_TIMEOUT_MS = '300000'
$env:T093_BROWSER_TIMEOUT_MS = '120000'
$env:DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/test_db'
& '.\apps\web\node_modules\.bin\playwright.CMD' test 'apps/web/tests/chat-t093-real-flow.spec.ts' --config='apps/web/tests/playwright.config.ts' --reporter=line
$code = $LASTEXITCODE
Write-Output ('t093_playwright_exit=' + $code)
exit $code
```

Result: exit 0; 1 Chromium test passed. Playwright reported `1 passed (22.0m)` and a slow-file notice. The flow again asserted one signed search and exactly one `ACTION_HANDOFF`; one winning booking intent with all concurrent losers rejected with 409; one consumed handoff linked to that intent; zero payment rows and zero payment calls; supplier call count 2; encrypted chat message count and plaintext-free encrypted count each at least 4; no handoff token in URLs, DOM, browser storage, console, or non-handoff SSE payloads; no provider identifiers or selection attestations in browser request URLs; and checkout at `/checkout/passengers`.

The API emitted one transient startup health-check warning about a 500ms Prisma transaction timeout; the test completed successfully afterward. Playwright cleaned up its owned servers; pre-existing Docker PostgreSQL and Redis services remained running. This is the final post-S01 result and supersedes the earlier pre-S01 successful T093 checkpoint for closure evidence.

## T093 corrected ciphertext assertion rerun

The user approved the single assertion correction to treat an empty ciphertext string as valid only when the envelope is present, while requiring non-empty nonce/auth tag and a positive key version. The existing `/dashboard` assertion, handoff assertions, and plaintext-leakage checks were retained. No other test or source files were changed.

Exact full command and environment:

```powershell
$ErrorActionPreference = 'Continue'
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
$env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'
$env:T093_REAL_FLOW = 'true'
$env:T093_TEST_TIMEOUT_MS = '600000'
$env:T093_STREAM_TIMEOUT_MS = '300000'
$env:T093_BROWSER_TIMEOUT_MS = '120000'
$env:DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/test_db'
& '.\apps\web\node_modules\.bin\playwright.CMD' test 'apps/web/tests/chat-t093-real-flow.spec.ts' --config='apps/web/tests/playwright.config.ts' --reporter=line
$code = $LASTEXITCODE
Write-Output ('t093_playwright_exit=' + $code)
exit $code
```

Result: exit 0; 1 Chromium test passed in about 7.3 minutes. The passing assertions provide the required handoff and security evidence: one signed search and exactly one `ACTION_HANDOFF`; one winning booking intent with all concurrent losers rejected with 409; one consumed handoff linked to that intent; zero payment rows and zero payment calls; supplier call count 2; encrypted chat message count and plaintext-free encrypted count each at least 4; no handoff token in URLs, DOM, browser storage, console, or non-handoff SSE payloads; no provider identifiers or selection attestations in browser request URLs; and checkout reached `/checkout/passengers`.

Playwright cleaned up its owned servers; ports 3000-3003 were clear. The pre-existing Docker PostgreSQL and Redis services remained running. [historical checkpoint]

## T093 airport fixture preparation

The signed-search diagnosis identified the canonical airport lookup as the blocker. Before the retry, a read-only query against the explicitly targeted local `test_db` showed `airport_count=0` and no SGN/HAN rows. The deterministic T093 provider fixture uses SGN to HAN, but does not replace the canonical airport lookup.

The existing airport seed helper uses uppercase IATA/ICAO/country values, the CSV's airport names and coordinates, and `LARGE_AIRPORT` for these two rows. The following narrow idempotent upsert applied only those two `iataCode` keys; it did not run the full seed, delete rows, reset the database, or run migrations:

```powershell
$ErrorActionPreference = 'Continue'
$env:DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/test_db'
Push-Location apps/api
node -e 'const { PrismaClient, AirportType } = require("@prisma/client"); const prisma = new PrismaClient(); const airports = [{ iataCode: "SGN", icaoCode: "VVTS", name: "Tan Son Nhat International Airport", city: "Ho Chi Minh City", country: "VN", region: "VN-SE", latitude: 10.8188, longitude: 106.652, elevation: 33, type: AirportType.LARGE_AIRPORT }, { iataCode: "HAN", icaoCode: "VVNB", name: "Noi Bai International Airport", city: "Hanoi (Soc Son)", country: "VN", region: "VN-RRD", latitude: 21.221201, longitude: 105.806999, elevation: 39, type: AirportType.LARGE_AIRPORT }]; (async () => { for (const airport of airports) { await prisma.airport.upsert({ where: { iataCode: airport.iataCode }, update: airport, create: airport }); console.log("upserted " + airport.iataCode); } })().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());'
$code = $LASTEXITCODE
Pop-Location
Write-Output ('airport_upsert_exit=' + $code)
exit $code
```

Result: exit 0; SGN and HAN were upserted. Post-checks showed exactly 2 airport rows with `SGN|VVTS` and `HAN|VVNB`; the previously empty `flight_offers` and `search_history` tables remained `0|0`.

## T093 retry after airport fixture preparation

The C01 Python worker was stable before this retry. The approved `/dashboard` assertion and API empty-content fix were retained; no source or test files were changed for this run.

Exact full command and environment:

```powershell
$ErrorActionPreference = 'Continue'
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
$env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'
$env:T093_REAL_FLOW = 'true'
$env:T093_TEST_TIMEOUT_MS = '600000'
$env:T093_STREAM_TIMEOUT_MS = '300000'
$env:T093_BROWSER_TIMEOUT_MS = '120000'
$env:DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/test_db'
& '.\apps\web\node_modules\.bin\playwright.CMD' test 'apps/web/tests/chat-t093-real-flow.spec.ts' --config='apps/web/tests/playwright.config.ts' --reporter=line
$code = $LASTEXITCODE
Write-Output ('t093_playwright_exit=' + $code)
exit $code
```

Result: exit 1; 1 Chromium test executed, 0 passed, 1 failed. The run progressed past the signed search, `ACTION_HANDOFF`, checkout, and concurrent booking-intent assertions. It failed at the final chat persistence check because the test uses truthiness for `contentCiphertext`; the empty plaintext agent message now has a valid empty ciphertext string plus non-empty nonce, auth tag, and key version, so that assertion evaluates false. This is a test compatibility issue with the approved empty-content crypto behavior. No test edit or retry was made under the fixture task’s scope, and a complete passing T093 result must not be claimed.

Playwright cleaned up its owned servers; ports 3000-3003 were clear. The pre-existing Docker PostgreSQL and Redis services remained running.

## Final post-atomic T093 verification record — 2026-09-09

This is the final post-atomic run. The source checkpoint is `.scratch/phase4-atomic-fix-report.md`; the approved `/dashboard` and ciphertext-envelope assertions were already present, and no source or test files were changed for this run. Read-only preflight confirmed local PostgreSQL/Redis readiness and the retained SGN/HAN reference rows in `test_db`.

Exact full command and environment:

```powershell
$ErrorActionPreference = 'Continue'
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
$env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'
$env:T093_REAL_FLOW = 'true'
$env:T093_TEST_TIMEOUT_MS = '600000'
$env:T093_STREAM_TIMEOUT_MS = '300000'
$env:T093_BROWSER_TIMEOUT_MS = '120000'
$env:DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/test_db'
& '.\apps\web\node_modules\.bin\playwright.CMD' test 'apps/web/tests/chat-t093-real-flow.spec.ts' --config='apps/web/tests/playwright.config.ts' --reporter=line
$code = $LASTEXITCODE
Write-Output ('t093_playwright_exit=' + $code)
exit $code
```

Observed tool output: `1 passed (12.2m)` followed by `t093_playwright_exit=0`; final exit code is 0. Independent artifact read-back from `C:\Booking Systems\apps\web\test-results\.last-run.json` is `{"status":"passed","failedTests":[]}` (last write 2026-09-09 12:32:55). The flow asserted one signed search and exactly one `ACTION_HANDOFF`; one winning booking intent with concurrent losers rejected with 409; one consumed handoff linked to that intent; zero payment rows and payment calls; supplier call count 2; encrypted and plaintext-free encrypted message counts each at least 4; no handoff token/provider identifiers/attestations leaked through browser-visible channels; and checkout at `/checkout/passengers`.

The T093-owned servers were cleaned up; the pre-existing Docker PostgreSQL and Redis services remained running. Earlier post-atomic notes were written by a concurrent report regeneration and landed before the historical failed fixture retry; this EOF record is the persisted final closure evidence.
