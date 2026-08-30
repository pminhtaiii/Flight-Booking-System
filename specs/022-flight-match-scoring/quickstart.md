# Quickstart: Validate Flight Match Scoring

This is a validation guide, not implementation code. Complete the tasks in `tasks.md` first.

## Prerequisites

- Node.js, pnpm, PostgreSQL, and Redis configured as documented in `AGENTS.md`.
- Existing dependencies installed; this feature adds no third-party package.
- Test environment variables for API and web services configured.
- Docker Desktop running for migration/API E2E validation.

## 1. Start dependencies and apply the additive migration

```powershell
docker compose up -d
Push-Location apps/api
& '.\node_modules\.bin\prisma.CMD' generate
$env:DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/test_db'
& '.\node_modules\.bin\prisma.CMD' migrate deploy
& '.\node_modules\.bin\prisma.CMD' migrate status
Pop-Location
```

Expected outcome: the traveler-profile scoring fields exist, existing profiles remain readable with null defaults, and no score table or score column exists.

## 2. Run pure policy and shared-contract tests

```powershell
pnpm --filter @shared/types test
Push-Location apps/api
& '.\node_modules\.bin\jest.CMD' --runInBand `
  src/flight-match/flight-match-scorer.service.spec.ts `
  src/flight-match/category-ranker.service.spec.ts `
  src/flight-match/flight-match.policy.spec.ts
Pop-Location
```

Expected outcome:

- Golden outputs are deterministic.
- All eight dimensions and four match levels are covered.
- Missing preferences, zero variance, personalized caps, exact total weights, blacklists, single/all-ineligible sets, overnight windows, and stable tie-breaks pass.
- Input-freezing tests show neither scorer nor ranker mutates offers/preferences.

## 3. Run profile and search API tests

```powershell
Push-Location apps/api
& '.\node_modules\.bin\jest.CMD' --runInBand `
  src/profile/profile.service.spec.ts `
  src/profile/profile.controller.spec.ts `
  src/flights/flights.service.spec.ts `
  src/agent-gateway/attested-flight-search/attested-flight-search.service.spec.ts

& '.\node_modules\.bin\jest.CMD' --config '.\test\jest-e2e.json' --runInBand `
  test/traveler-profile-flight-match-migration.e2e-spec.ts `
  test/flights-match-scoring.e2e-spec.ts `
  test/agent-flight-match-parity.e2e-spec.ts
Pop-Location
```

Expected outcome:

- Profile validation and revision CAS cover every new field.
- `MATCHED` and `RANKED` responses follow `contracts/flight-search.openapi.yaml`.
- Cached and uncached paths recompute current-profile scores without extra Duffel calls.
- Browser and agent paths have the same mode and relative deterministic ranking.
- Blacklisted offers remain visible with null scores.

## 4. Run web server-boundary and browser tests

```powershell
& '.\node_modules\.bin\tsx.CMD' --test `
  apps/web/lib/server/flight-search.spec.ts `
  apps/web/components/search/flight-match-explanations.spec.ts

& '.\apps\web\node_modules\.bin\playwright.CMD' test `
  'apps/web/tests/flight-match-scoring.spec.ts' `
  'apps/web/tests/traveler-profile.spec.ts' `
  --config='apps/web/tests/playwright.config.ts' `
  --reporter=line
```

Expected outcome:

- Strict schemas accept only the additive safe contract.
- `MATCHED` shows score, level, breakdown, and constraint states.
- `RANKED` shows no match claims and offers a profile-completion path.
- Unknown explanation keys use a safe fallback.
- No access token, backend URL, provider ID, PII, unallowlisted profile value, or raw explanation HTML reaches the browser bundle/DOM/storage.

## 5. Run agent projection tests

```powershell
$env:PYTHONPATH = "$PWD/tests/ci/python;$PWD/apps/agent/src"
$env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'
uv run --package agent pytest `
  apps/agent/tests/test_tools.py `
  apps/agent/tests/test_search_snapshot.py `
  apps/agent/tests/test_trusted_search_snapshot_lifecycle.py
```

Expected outcome: the agent narrates safe precomputed facts from the immediate response, preserves API ordering/mode, cannot score/reorder/leak profile/provider data, and persists no score fact in the trusted Redis snapshot.

## 6. Run static and build gates

```powershell
pnpm exec eslint "apps/api/**/*.ts" "packages/shared/**/*.ts" --max-warnings 0
pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit
pnpm --filter @web/frontend lint
pnpm --filter @web/frontend typecheck
pnpm --filter @web/frontend build
$env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'
uv run --package agent ruff check apps/agent
uv run --package agent ruff format --check apps/agent
```

Expected outcome: every gate exits 0.

## 7. Verify performance and non-persistence invariants

Run the scorer benchmark fixture for 20 offers and the search cache call-count test.

Expected outcome:

- Warm scorer p95 is below 20 ms for 20 offers.
- Cached search performs zero additional Duffel calls; uncached behavior matches the existing one-call path.
- Repository/database/Redis inspection finds no match-score persistence, score cache key, or cleanup job.
