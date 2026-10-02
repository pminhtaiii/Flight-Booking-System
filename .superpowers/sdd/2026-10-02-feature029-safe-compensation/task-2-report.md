# T041 — Safe recovery deferral and retry timing

## Result

Implemented T041 in `BookingRecoveryService`. Stale recovery now accepts a nonempty top-level or nested order ID, defers created-order evidence with missing/empty/malformed IDs for 300 seconds, returns safely on payment-event lookup errors, and keeps cancellation failures non-destructive if writing the deferral key fails. Valid 429 `RATE_LIMIT_EXCEEDED` and `BUDGET_UNAVAILABLE` responses use positive integer retry seconds and a valid upstream `resetAt`; absent or invalid retry metadata and other errors use the 300-second fallback. A cancellation error message containing `already_cancelled` is no longer treated as proof. Only an explicit confirmed cancellation response records `duffel_order_cancelled`.

## TDD evidence

Each focused cycle used `pnpm --filter @api/backend exec jest --runInBand src/booking-lifecycle/booking-recovery.service.spec.ts --testNamePattern="<case>"`.

| Behavior | RED observation | GREEN result |
| --- | --- | --- |
| Nested `metadata.data.id` with pending cancellation | Cancellation was skipped and Stripe cancellation ran. | Nested ID reached cancellation; 300-second deferral preserved the booking and hold. |
| Created event with missing ID | Stripe cancellation ran. | Key `booking:recovery:defer:{bookingId}` was set with TTL 300; no cancel/fail. |
| Empty and malformed IDs | Existing missing-ID guard already covered these variants. | Each added case passed with TTL 300 and no cancel/fail. |
| Payment-event lookup rejection | Stripe cancellation ran after the catch logged the lookup failure. | Returning the current booking from the catch kept the hold and booking state. |
| `BUDGET_UNAVAILABLE` 429 with `retryAfterSeconds=60` and `resetAt=2026-10-02T01:01:00.000Z` | Used fallback `2026-10-02T01:05:00.000Z`, TTL 300. | Used upstream reset time, TTL 60. |
| `RATE_LIMIT_EXCEEDED` without reset time | Existing positive retry-metadata handling already computed the requested time. | At frozen time `2026-10-02T01:00:00.000Z`, used `2026-10-02T01:01:00.000Z`, TTL 60. |
| Invalid `retryAfterSeconds=0` | Existing validation already selected bounded fallback. | At frozen time `2026-10-02T01:00:00.000Z`, used `2026-10-02T01:05:00.000Z`, TTL 300. |
| Cache write failure after pending cancellation | Existing logged failure handling already returned without destructive compensation. | Rejection was logged; Stripe cancel and `failBooking` remained uncalled. |
| Bare `already_cancelled` error | Error text created a cancellation marker and Stripe cancellation ran. | Removed error-text confirmation; no marker, Stripe cancel, or booking failure; TTL 300. |
| Explicit already-cancelled provider evidence | Corrected fixture passed after returning `{ id: 'ord_123', status: 'CANCELLED' }`. | Existing marker and replay assertions remained intact. |

The two fixture corrections were explicitly approved on 2026-10-02 and carry comments beside the unit and E2E fixtures. Existing assertions were retained. Existing generic-error fallback, active-TTL skip, missing/expired-TTL retry, and confirmed-cancellation-before-release checks were reused.

## Final validation

- `pnpm --filter @api/backend exec jest --runInBand src/booking-lifecycle/booking-recovery.service.spec.ts` — exit 0; 1 suite, 55/55 tests passed.
- `pnpm --filter @api/backend test:e2e -- test/payment-fulfillment-safety.e2e-spec.ts` — exit 0; 1 suite, 2/2 tests passed. The E2E asserts the cancellation marker/provider confirmation precedes Stripe release and booking failure.
- `pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit` — exit 0.
- `pnpm --filter @api/backend lint` — exit 0.

## Self-review

- Preserved constructor injection, existing cache/cancellation services, and supplier module boundaries. Added no dependency or service.
- Added runtime narrowing for persisted order IDs; new code and tests contain no `any` or type assertions.
- A positive active TTL still skips recovery; a missing/expired key permits a safe recheck. Confirmed cancellation records the marker before release/failure. Unconfirmed cancellation, malformed order evidence, lookup failure, and cache failure cannot call Stripe cancellation or `failBooking`.
- Updated only T041 in `tasks.md`; synchronized `active-feature.md`, `progress-checker.md`, and the relevant supplier/recovery statements in `architecture.md`. T042–T043 and later phases remain pending.

**Status:** DONE. No unresolved T041 concerns.
