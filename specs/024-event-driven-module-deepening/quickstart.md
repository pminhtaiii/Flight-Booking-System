# Validation and Rollout Guide

These commands are for implementation validation. They have not been executed as runtime evidence during planning. Run from repository root in PowerShell. Use a disposable test database and controlled providers; never live card or supplier purchase credentials.

## Prerequisites

Node >=20, pnpm >=9, installed workspace dependencies, Docker PostgreSQL/Redis and the existing test environment configuration from `TEST_INFRA.md`. New suites listed below are created by tasks.md. Follow existing provider stubs and privacy-safe diagnostics; do not add production test hooks.

## Database preparation

```powershell
docker compose up -d
$databaseExists = docker compose exec -T postgres psql -U postgres -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='test_db'"
if ($databaseExists.Trim() -ne '1') {
  docker compose exec -T postgres createdb -U postgres test_db
}
$env:NODE_ENV = 'test'
$env:DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/test_db'
pnpm --filter @api/backend exec prisma generate
pnpm --filter @api/backend exec prisma migrate deploy
pnpm --filter @api/backend exec prisma migrate status
```

Provision test_db using the established test fixture if absent. Migration E2E must separately create a pre-feature schema fixture, add historical booking/projection rows, apply the new migration, and prove defaults 1/0, preserved reference and successful repair. Running migrate deploy on an empty DB alone does not prove upgrade behavior.

## Static and unit gates

```powershell
node --test tests/ci/ci-workflow.contract.test.mjs
pnpm exec eslint "apps/api/**/*.ts" "packages/shared/**/*.ts" --max-warnings 0
pnpm --filter @shared/types test
pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit
$env:NODE_OPTIONS = "--require=$PWD/tests/ci/node-network-guard.cjs"
pnpm --filter @api/backend test -- --runInBand
Remove-Item Env:NODE_OPTIONS
```

Run each command separately, inspect its exit code and stop on failure. The unit network guard intentionally does not carry into database E2E or smoke.

## Focused database/HTTP verification

```powershell
pnpm --filter @api/backend exec jest --config test/jest-e2e.json --runInBand --runTestsByPath test/payment-fulfillment.e2e-spec.ts test/booking-events.e2e-spec.ts test/booking-projection-reconciliation.e2e-spec.ts test/booking-projection-version-migration.e2e-spec.ts test/module-deepening.e2e-spec.ts
pnpm --filter @api/backend exec jest --config test/jest-e2e.json --runInBand --runTestsByPath test/payment-idempotency.e2e-spec.ts test/payment.e2e-spec.ts test/refund-settlement.e2e-spec.ts test/booking-agent-projection-privacy.e2e-spec.ts test/booking-projection-backfill.e2e-spec.ts test/characterization/booking-characterization.e2e-spec.ts test/characterization/refund-characterization.e2e-spec.ts
```

Tests build actual Nest modules and await app.init() so listeners exist. Stub only external providers; real PostgreSQL proves transactions, ownership fencing and conditional upsert. Use controlled scheduler hooks in the test harness and bounded observable polling, not arbitrary sleeps.

| Scenario | Required observable result |
|---|---|
| Happy path/replay | One order and capture; expected HTTP body/status; canonical bundle and ledger balanced |
| Slow provider | 202 after existing threshold; same execution completes; polling succeeds |
| Capture ambiguity | Known success never cancels; unknown leaves order/payment recoverable |
| Ownership takeover | Old fence cannot change checkpoint/result; newer owner remains intact |
| Rollback/nested/retry | No precommit or rollback event; only committed attempt observed |
| Every mutation in booking-events.md | Actual latest status/revision and sourceVersion projected |
| Reverse hydration completion | Version never decreases; reference stable; coherent flight data |
| Dropped event/missing row | Reconciliation repairs without external calls |
| >100 rows and malformed head | Cursor reaches later IDs; max 100 candidates and five repairs |
| Migration/backfill | 1/0 defaults, stable reference, guarded reruns and rollback/reactivation recovery |
| Privacy | Existing owner boundaries and safe field allowlist unchanged |
| Module boot | No new forwardRef cycle, one lifecycle provider, one root event registration |

## Whole-stack regression

```powershell
pnpm run test:smoke:all
```

Use the existing harness's local orchestration and mock-provider environment. Adapt its booking readiness waits to eventual projection completion if required, retaining deterministic bounded assertions. Preserve previous payment/booking behavior and final runner exit code 0. If changed files extend to web/agent/shared contracts, run their change-aware gates in AGENTS.md too.

## Operational rehearsal

1. Stop legacy API writers; apply additive migration and deploy the complete projection slice (US2+US3). US1 may already be deployed.
2. Suppress one event in the test harness, then observe projection repair during a scheduled/manual test invocation.
3. Inspect `booking_projection.failure` and `projection_reconciliation.{stale_found,repaired,failed,duration}` plus skipped/current counts. Logs contain eventId, bookingId, sourceVersion and safe codes only; IDs are not metric labels.
4. Verify cursor completes a full traversal and every repairable test row is current. Persistent failures remain visible and stale, not marked repaired.
5. Rehearse rollback/reactivation as specified in plan.md. Never drop additive columns or modify financial history for rollback.

Record commands, exit codes, suite counts, scenario coverage and any skip/failure in `specs/024-event-driven-module-deepening/validation-evidence.md` during implementation. Planning convergence evidence belongs separately in reviews/convergence.md.
