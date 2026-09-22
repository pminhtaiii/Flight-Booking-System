# Quickstart: Validate Booking Umbrella Deletion

## Prerequisites

- Verify the merged feature 024 source provides `BookingStateModule`, root `EventEmitterModule.forRoot`, and owner-token `CacheService` lock helpers.
- Dependencies installed; API test environment available. For full E2E, start PostgreSQL and Redis with `docker compose up -d` and follow [context/workflow.md](../../context/workflow.md).
- Before editing Next route handlers, read the installed route-handler guide under `node_modules/next/dist/docs/`.

## Controller ownership checkpoint (US1)

1. Run API booking and cancellation unit/E2E suites. Confirm the five existing methods still return the same successful payloads and reject unauthenticated and non-owner calls.
2. Check that `AppModule` imports management and cancellation directly, their modules register their own controllers, and no source/test imports `BookingModule`, `BookingController`, or `booking/dto`.
3. Confirm the old URL paths still work at this checkpoint.

## Asynchronous read checkpoint (US2)

1. In unit/E2E tests, hold provider reconciliation for at least ten seconds. Read list and detail for a stale `PROCESSING` booking; both complete before provider repair and return current known state.
2. Verify a fresh or terminal booking causes no event. Verify a departed `CONFIRMED` booking still returns `COMPLETED` through the local completion check.
3. Deliver duplicate events and race an event against the ten-minute sweep for one ID. Confirm one active worker while a lease is live; a changed/terminal record is skipped; an expired first worker cannot release a successor's lease.
4. Simulate lease expiry and Redis fallback. Verify duplicate attempts cannot repeat unsafe Duffel/Stripe actions or regress booking/payment state. Force listener failure; GET succeeds and the sweep still repairs eligible records through the same locked helper.
5. Emit `booking.reconciliation.requested` through the registered event emitter and confirm the wildcard projection listener performs no hydration, upsert, or projection metrics; committed transition events still project normally.

## Route checkpoint (US3)

1. Exercise GET and POST `/bookings/:bookingId/cancellation` and POST `/bookings/:bookingId/cancellation/quote` with an owner and non-owner.
2. Use the booking detail UI to request status, quote, and execute. Confirm all web requests stay under `/api/booking-management/` and target the new paths.
3. Confirm old irregular routes are not registered or called. Verify quote expiry, refund transitions, and error mappings remain intact.
4. Directly call the new Next route handlers to verify GET/POST method exports, quote POST forwarding, and outcome-to-status mapping; mocked browser interception alone does not cover those handlers.
5. Check that the ZAP registry and route contract test target `POST /bookings/:id/cancellation`, the OpenAPI fixture targets `POST /bookings/{id}/cancellation`, and none of the three files retains its corresponding legacy `/cancel` path. Run `node --test tests/security/zap/routes-config.test.mjs`.

## Final gates

Run the repository's API and web lint/typecheck/build gates and relevant Jest/Playwright booking and cancellation suites from [context/workflow.md](../../context/workflow.md). Record command exits and any environment limits in implementation evidence; do not mark a suite passing from assertions alone if its runner fails during teardown.

## Stale Fixture Deletion Rationale (T035)

The compiled fixture `apps/api/test/cancellation.e2e-spec.js` was removed. The Jest E2E configuration `apps/api/test/jest-e2e.json` uses `ts-jest` with `"testRegex": ".e2e-spec.ts$"` to execute TypeScript test files directly. No Jest or CI configuration referenced the generated `.js` fixture; keeping it introduced file redundancy, risked out-of-sync route assertions, and polluted codebase searches.

## Verification Evidence (Phase 5 / Slice 1 Checkpoint: Tasks T026, T030, T035)

Executed on 2026-09-22:

| Gate / Command | Exit Code | Result Summary |
| --- | :---: | --- |
| `pnpm exec eslint "apps/api/**/*.ts" --max-warnings 0` | `0` | Clean, 0 warnings/errors across `apps/api`. |
| `pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit` | `0` | Clean compile, 0 TypeScript diagnostic errors. |
| Focused API Unit Test (with `node-network-guard.cjs`):<br>`Push-Location apps/api; $env:NODE_OPTIONS = '-r ../../tests/ci/node-network-guard.cjs'; pnpm test -- src/cancellation/cancellation.controller.spec.ts; Pop-Location` | `0` | **1 test suite passed, 13 tests passed, 0 failures** (Time: 17.874s). Verified routing metadata for `@Controller('bookings/:bookingId/cancellation')`, `@Get()`, `@Post('quote')`, `@Post()`, `ParseUUIDPipe`, and service delegation. |
| API Cancellation E2E Test:<br>`pnpm --filter @api/backend test:e2e -- cancellation.e2e-spec.ts` | `0` | **1 test suite passed, 11 tests passed, 0 failures** (Time: 29.035s). Verified normalized sub-resource paths, full cancellation flow, and explicit 404 rejections for removed legacy sibling routes (`:bookingId/cancellation-quote`, `:bookingId/cancel`). |


