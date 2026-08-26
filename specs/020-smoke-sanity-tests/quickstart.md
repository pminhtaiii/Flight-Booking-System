# Quickstart: Validate Whole-Stack Smoke and Sanity CI

## Prerequisites

- Docker Desktop with Compose
- Node.js 20 and pnpm 10.34.5
- uv 0.12.0 and Python 3.11
- Repository dependencies installed from `pnpm-lock.yaml` and `uv.lock`
- Ports 3000, 3001, 3002, 5432, 6379, and the configured mock port available

No Duffel, Stripe, Mimo, or deployment secret is required. Use only documented non-production local values.

## Static contract checks

```powershell
node --test tests/ci/ci-workflow.contract.test.mjs
node --test tests/smoke/wait-for-ready.unit.test.mjs tests/smoke/mock-server.unit.test.mjs
```

Expected: exit code 0. The workflow contract verifies trigger scope, path filters, dependency routing, smoke-before-sanity ordering, network guard, cleanup, and aggregate status.

## Prepare infrastructure and isolated database

```powershell
docker compose up -d
```

Use the guarded local reset command documented in `tests/smoke/README.md`. It must refuse to reset any database whose parsed name is not exactly `smoke_test`.

Then generate and deploy the schema against the isolated database:

```powershell
$env:DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/smoke_test?schema=public'
pnpm --filter @api/backend exec prisma generate
pnpm --filter @api/backend exec prisma migrate deploy
```

## Build required artifacts

```powershell
pnpm build:shared
pnpm --filter @api/backend build
pnpm --filter @web/frontend build
uv sync --locked --package agent
```

Provide the local-only environment contract from [contracts/test-harness.md](contracts/test-harness.md), including shared JWT/service secrets, loopback service URLs, feature flags, and loopback `DUFFEL_API_URL`/`STRIPE_API_URL`.

## Run the complete lifecycle

```powershell
node scripts/ci/run-smoke-sanity.mjs --mode=local
```

Expected sequence:

1. Mock, API, Agent, and Web processes start.
2. All readiness probes poll concurrently and finish within 120 seconds.
3. Eight smoke checks pass in under 15 seconds.
4. Sanity checks pass in under 60 seconds.
5. All harness-owned processes stop even if a phase fails.

## Run suites against an already-running stack

```powershell
node --test --test-reporter=spec tests/smoke/smoke.test.mjs
node --test --test-reporter=spec tests/smoke/sanity.test.mjs
```

Do not run sanity after a smoke failure when reproducing CI behavior.

## Failure validation

- Stop one service before readiness: expect a bounded timeout with service name, last status/error, and elapsed time.
- Send an unknown mock route: expect 404 and a safe warning.
- Send malformed provider input: expect a validation failure with no raw body in logs.
- Break a smoke assertion: expect sanity to be skipped and cleanup to run.
- Repeat a valid search: expect the same `results` and `searchHash`, `cached` false→true, and one Duffel mock request.

## CI-equivalent final gates

```powershell
node --test tests/ci/ci-workflow.contract.test.mjs
pnpm exec eslint "apps/api/**/*.ts" "packages/shared/**/*.ts" --max-warnings 0
pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit
pnpm --filter @web/frontend lint
pnpm --filter @web/frontend typecheck
pnpm --filter @web/frontend build
uv run --package agent ruff check apps/agent
uv run --package agent ruff format --check apps/agent
```

Finally run the full smoke/sanity lifecycle and require exit code 0.

## Cleanup

The orchestrator owns application/mock cleanup. Stop Compose infrastructure explicitly after local validation:

```powershell
docker compose down
```

Do not remove the shared development volume as part of ordinary local cleanup. CI may remove only its job-owned resources.
