# T025 Catalog Contract and Missing Seat-Map Regression

Status: DONE

## Implemented

- Added the supplier-path catalog contract suite at `apps/api/src/supplier/ancillary/duffel-ancillary.service.spec.ts`.
- Added the HTTP E2E contract at `apps/api/test/ancillary-catalog.e2e-spec.ts`.
- Updated `DuffelService.getSeatMapsAndServices` so only the seat-map operation treats numeric `status`, numeric `statusCode`, or `HttpException.getStatus()` equal to 404 as `{ data: [] }`. Offer failures and other seat-map failures continue through the existing error mapping.
- Marked T025 complete in `specs/029-duffel-provider-narrowing/tasks.md`.

## TDD evidence

RED, before the production edit:

```text
cd apps/api
$env:NODE_OPTIONS='--require="C:/Booking Systems/tests/ci/node-network-guard.cjs"'
./node_modules/.bin/jest.CMD --config jest.config.json --runInBand src/supplier/ancillary/duffel-ancillary.service.spec.ts

FAIL .../duffel-ancillary.service.spec.ts
Tests: 1 failed, 1 total
HttpException: Seat map not found
at DuffelService.getSeatMapsAndServices (.../src/duffel/duffel.service.ts:704:21)
```

The RED was the expected legacy 502 `UPSTREAM_UNAVAILABLE` path for a seat-map-only 404.

GREEN after the minimal seat-map promise fallback:

```text
./node_modules/.bin/jest.CMD --config jest.config.json --runInBand src/supplier/ancillary/duffel-ancillary.service.spec.ts

PASS .../duffel-ancillary.service.spec.ts
Tests: 14 passed, 14 total
```

The focused supplier contract covers cache TTL 4 hits, TTL 3/0 misses, force refresh, concurrent upstream starts, first and second reservation denial, empty maps, 404 status variants, baggage retention, and non-404 propagation.

## Verification

```text
./node_modules/.bin/jest.CMD --config test/jest-e2e.json --runInBand test/ancillary-catalog.e2e-spec.ts
PASS .../test/ancillary-catalog.e2e-spec.ts
Tests: 2 passed, 2 total

./node_modules/.bin/jest.CMD --config jest.config.json --runInBand src/duffel/duffel-ancillary.service.spec.ts src/supplier/ancillary/duffel-ancillary.service.spec.ts
Test Suites: 2 passed, 2 total
Tests: 52 passed, 52 total

./node_modules/.bin/tsc.CMD -p tsconfig.json --noEmit
exit code 0

../../node_modules/.bin/eslint.CMD src/duffel/duffel.service.ts src/supplier/ancillary/duffel-ancillary.service.spec.ts --max-warnings 0
exit code 0

../../node_modules/.bin/eslint.CMD test/ancillary-catalog.e2e-spec.ts --no-ignore --max-warnings 0
exit code 0
```

The E2E uses the real controller, `AncillariesService`, `AncillaryCatalogService`, `DuffelService`, and `DuffelRateBudgetService`; only the database, cache, SDK, and auth guard boundaries are doubled. It verifies HTTP 200 with a missing seat map and retained baggage, plus HTTP 429 with zero upstream SDK calls. Environment variables and Jest mocks are restored in cleanup.

## Files

- `apps/api/src/supplier/ancillary/duffel-ancillary.service.spec.ts`
- `apps/api/test/ancillary-catalog.e2e-spec.ts`
- `apps/api/src/duffel/duffel.service.ts`
- `specs/029-duffel-provider-narrowing/tasks.md`

## Self-review

- No explicit `any` was added.
- External doubles are narrow and use documented `unknown` assertions at the SDK/Prisma/Cache boundaries.
- Reservations remain before both SDK calls; the offer promise is unchanged; timeout and normalizer paths are unchanged.
- No context documentation update was needed for this test-only plus fallback slice; T027 owns the broader completion documentation.
- The requested absolute TDD skill path was absent; the repository copy at `C:/Booking Systems/.agents/skills/tdd/SKILL.md` was read and followed.
