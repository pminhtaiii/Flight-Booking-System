# Validation quickstart

Run these checkpoints while implementing [the plan](./plan.md). All commands assume PowerShell at the repository root. Use mocked Duffel endpoints for focused tests; use a dedicated disposable PostgreSQL database for migration checks. Do not point migration checks at a database containing valuable data.

## Prerequisites

```powershell
pnpm install --frozen-lockfile
docker compose up -d
```

Set the existing test environment/secrets as described in `context/testing.md`. `DUFFEL_API_URL` may point to the repository mock server; its URL validation and base path behavior are part of the core checkpoint. The implementation must use the same installed `@duffel/api` version and no new dependency.

## 0. Baseline and private-access seal

```powershell
pnpm --filter @api/backend exec jest --runInBand src/duffel/duffel.service.spec.ts src/flights/flights.service.spec.ts src/flights/flight-search-orchestrator.service.spec.ts
pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit
```

Expected: baseline tests and compile pass; direct `FlightsService['duffel']` lookup is replaced by a public capability method. Characterization fixtures pin search order/hash/cache, detail expiry/price drift, monthly-budget baseline, and intended daily-budget cases separately.

## 1. Core and search checkpoint

```powershell
pnpm --filter @api/backend exec jest --runInBand src/supplier/core src/supplier/search src/flights src/agent-gateway/attested-flight-search
pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit
```

Expected: one SDK configuration, validated mock `DUFFEL_API_URL`, same search result and stored raw evidence, same 404/410 detail outcome, cache hit with zero provider/budget calls. Booking readiness, agent readiness, and chat handoff consume normalized stored offers with unchanged passenger/expiry/segment behavior. Atomic concurrency checks cap daily total at 1,500, user search at 1,000, agent search at 500. The old monthly search and reconciliation counters are unused; a skipped sync charges zero. Parallel seat-map calls and manual order retries are counted per attempt when those adapters land.

## 2. Ancillary checkpoint

```powershell
pnpm --filter @api/backend exec jest --runInBand src/supplier/ancillary src/ancillaries src/payment/ancillary-payment-validation.service.spec.ts
pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit
```

Expected: catalog, cache/freshness, missing-map fallback, passenger scoping, repricing, and payment-bound totals match baseline. No ancillary consumer imports the old `DuffelService`.

## 3. Order checkpoint

```powershell
pnpm --filter @api/backend exec jest --runInBand src/supplier/order src/payment-fulfillment src/cancellation src/booking-lifecycle src/disruption
pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit
```

Expected: fulfillment port signature unchanged; one remote order on replay; fencing blocks stale ownership; cancellation quote/refund, recovery, and sync match baseline; persisted order evidence contains no passenger PII. A last-slot order creation followed by capture failure and budget-denied cancellation retains PROCESSING/authorized hold and retryable order-created evidence without completing idempotency in both inline and 25-second background handoff paths. The stale sweeper skips until the PII-free defer key's retry time and does not void/fail while cancellation is unconfirmed; after the next allowed attempt it cancels or confirms already cancelled, then voids/fails exactly once. `DuffelService` and `DuffelModule` can then be deleted with no remaining consumers.

## 4. Rename and migration checkpoint

Use a fresh dedicated database, for example by setting `DATABASE_URL` to a test database URL before the commands below. Apply the existing migration chain plus the new forward migration; do not reset a shared database.

```powershell
pnpm --filter @api/backend exec prisma migrate deploy
pnpm --filter @api/backend exec prisma generate
pnpm --filter @api/backend exec prisma migrate status
pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit
pnpm --filter @shared/types test
```

Expected: migration status is clean; physical non-webhook columns and indexes use supplier names, webhook table retains Duffel names, and no `@map` alias preserves old names. A second check on a database already at the previous migration verifies existing row values and uniqueness survive. Legacy `Booking.flightSnapshot` JSON reads successfully; old strict agent search snapshots fail closed and request a fresh search.

## 5. Public contract and security checkpoint

```powershell
pnpm --filter @api/backend exec jest --runInBand src/agent-gateway/selection-attestation.service.spec.ts src/agent-gateway/attested-flight-search src/booking-management src/disruption/webhook
pnpm --filter @web/frontend typecheck
pnpm --filter @web/frontend lint
pnpm --filter @web/frontend build
$env:UV_CACHE_DIR = 'C:\Booking Systems\.uv-cache'
uv run --package agent pytest apps/agent/tests -m 'not redis_integration'
```

Expected: current HTTP/SSE route and JSON fixtures pass; `sel_v1_` signed payload bytes and verification are unchanged; web views do not expose raw supplier identities; checkout rejects both legacy and neutral supplier ID injection; webhook HMAC and PII redaction stay intact. Before changing any Next.js code, read the matching installed Next.js guide in `node_modules/next/dist/docs/` as required by `AGENTS.md`.

## 6. Full pre-PR gate and static audit

Run the change-aware API, web, agent, and CI gates from `context/testing.md`, including full API Jest and relevant PostgreSQL E2E suites. Then inspect the reference census:

```powershell
rg -n "DuffelService|DuffelModule|\['duffel'\]|@duffel/api" apps/api/src packages/shared/src apps/web apps/agent/src
rg -n -i 'duffel' apps/api/src packages/shared/src apps/web apps/agent/src apps/api/prisma/schema.prisma
```

Expected: SDK imports occur only in supplier concrete implementation; no monolith/private SDK reference remains. Every remaining Duffel name is a concrete SDK/webhook name or an enumerated legacy wire compatibility field/test. Historic migration SQL is outside this census. Update affected `context/` documents only after implementation is verified.
