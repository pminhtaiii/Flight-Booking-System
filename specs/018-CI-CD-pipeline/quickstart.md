# Quickstart: Validate and Roll Out the PR CI Pipeline

## Prerequisites

- Docker Desktop, Node 20, pnpm 10.34.5, uv 0.12.0/Python 3.11, and actionlint 1.7.12 are available.
- GitHub Actions is enabled, `development` exists, and an administrator is available for the final branch-rule handoff.
- Do not configure `ci-status` as required until it has appeared successfully on a test PR.

## Static contract validation

```powershell
node --test tests/ci/ci-workflow.contract.test.mjs
actionlint .github/workflows/ci.yml
pnpm exec prettier --check .github/workflows/ci.yml specs/018-CI-CD-pipeline
```

Expected: contract tests, actionlint, and formatting all pass. `.gitattributes` is validated through the contract/policy tests, not Prettier.

## API gate and unit suite

```powershell
$env:DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/test_db?schema=public'
pnpm install --frozen-lockfile
pnpm exec eslint "apps/api/**/*.ts" "packages/shared/**/*.ts" --max-warnings 0
pnpm --filter @shared/types build
pnpm --filter @api/backend exec prisma generate
pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit
$env:NODE_OPTIONS = "--require=`"$PWD/tests/ci/node-network-guard.cjs`""
pnpm --filter @api/backend test -- --runInBand
```

The network guard is deliberately set after install so it cannot block package registry traffic.

## API E2E

```powershell
docker compose up -d
$postgresReady = $false; $redisReady = $false
for ($attempt = 1; $attempt -le 30; $attempt++) {
  docker compose exec -T postgres pg_isready -U postgres -d flight_booking; $postgresReady = $LASTEXITCODE -eq 0
  docker compose exec -T redis redis-cli ping; $redisReady = $LASTEXITCODE -eq 0
  if ($postgresReady -and $redisReady) { break }; Start-Sleep -Seconds 2
}
if (-not ($postgresReady -and $redisReady)) { throw 'PostgreSQL or Redis did not become ready' }
$env:NODE_ENV = 'test'; $env:DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/flight_booking?schema=public'; $env:REDIS_URL = 'redis://127.0.0.1:6379/0'
$env:STRIPE_SECRET_KEY = 'sk_test_ci_not_a_secret'; $env:STRIPE_WEBHOOK_SECRET = 'whsec_ci_not_a_secret'; $env:JWT_SECRET = 'ci-not-a-secret-jwt'
$env:AGENT_SERVICE_API_KEY = 'ci-not-a-secret-agent-key'; $env:CLAIM_TOKEN_SECRET = 'ci-not-a-secret-claim-key'; $env:ATTESTATION_SECRET = 'ci-not-a-secret-attestation'
$env:ENCRYPTION_KEY = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; $env:CHAT_ENCRYPTION_KEY = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
$env:NODE_OPTIONS = "--require=`"$PWD/tests/ci/node-network-guard.cjs`""
pnpm --filter @shared/types build
pnpm --filter @api/backend exec prisma generate
pnpm --filter @api/backend exec prisma migrate deploy
pnpm --filter @api/backend test:e2e
```

## Web gate/build and Agent tests

Set `NEXTAUTH_SECRET`, `NEXTAUTH_URL=http://localhost:3000`, `NEXT_PUBLIC_API_URL=http://127.0.0.1:3001`, `NEXT_PUBLIC_AGENT_URL=http://127.0.0.1:3002`, explicit feature flags, a dummy install `DATABASE_URL`, then build shared, lint, route-check, typecheck, and build with the Node guard.

For Agent: `uv sync --locked --package agent`; start/poll Redis; then set `PYTHONPATH=$PWD/tests/ci/python`, `REDIS_URL=redis://127.0.0.1:6379/0`, `CI_REQUIRE_REDIS_TESTS=1`, and non-production Agent fixtures. Run Ruff, `pytest -m "not redis_integration"`, then `pytest -m redis_integration --strict-markers`. The marked group must be non-empty and unavailable Redis must fail rather than skip.

## PR and rollout scenarios

| Scenario | Expected service chains | Required result |
|---|---|---|
| API/Web/Agent-only | corresponding chain only | all relevant jobs success |
| Shared, workflow, policy, contract, script | API + Web + Agent | all relevant jobs success |
| Root Node / root Python | API+Web / Agent | matching chain success |
| Docs-only | none | `ci-status` success |
| Push or PR to `main` | none | workflow absent |

Also verify an intentionally failed relevant job, malformed filter output, and synthetic cancellation fail the summary. Push two commits quickly to one PR: the older run is cancelled and only the newest head SHA governs mergeability. Record five warm-cache full-run durations and their median. For rollback, remove/update the branch requirement before reverting the workflow.
