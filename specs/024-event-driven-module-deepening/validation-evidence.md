# Validation Evidence: Event-Driven Module Deepening

## Phase 1 — Baseline Characterization Validation

### Overview
This document records pre-change baseline verification evidence for the payment fulfillment subsystem prior to refactoring and module deepening. In accordance with the pre-change characterization protocol (FR-001, FR-002, FR-005, FR-014), the baseline suite exercises the existing `PaymentController` and `PaymentService` integration using controlled mock providers in `apps/api/test/payment-fulfillment.e2e-spec.ts`.

---

### Invariant Verification: Runtime Immutability

- **Strict Invariant**: 0 files modified in `apps/api/src/`.
- **Command**: `git status --porcelain apps/api/src/`
- **Output**: *(empty)*
- **Status**: **VERIFIED**. All runtime production source code in `apps/api/src/` remains completely unmodified during Phase 1 baseline characterization.

---

### Verification Commands & Execution Logs

#### 1. TypeScript Compile Gate

- **Command**:
  ```powershell
  pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit
  ```
- **Exit Code**: `0`
- **Duration**: ~97s
- **Output**:
  ```text
  [WARN] The "pnpm" field in package.json is no longer read by pnpm. The following keys were ignored: "pnpm.auditConfig". See https://pnpm.io/settings for the new home of each setting.
  ```

---

#### 2. Payment Fulfillment Characterization E2E Suite

- **Command**:
  ```powershell
  $env:NODE_OPTIONS = "--require=`"$($PWD.Path.Replace('\', '/'))/tests/ci/node-network-guard.cjs`""
  pnpm --filter @api/backend test:e2e -- payment-fulfillment.e2e-spec.ts
  ```
  *(Note on Windows environment: PowerShell `$PWD` contains spaces (`C:\Booking Systems`), requiring quotes inside `NODE_OPTIONS` so Node's CLI pre-loader treats `--require` as a single argument rather than splitting at the space.)*

- **Exit Code**: `0`
- **Duration**: 52.842s (test suite time), ~54s wall clock (54.223 s)
- **Suite Summary**:
  - Test Suites: **1 passed, 1 total**
  - Tests: **9 passed, 9 total**
  - Snapshots: **0 total**

- **Terminal Output**:
  ```text
  [WARN] The "pnpm" field in package.json is no longer read by pnpm. The following keys were ignored: "pnpm.auditConfig". See https://pnpm.io/settings for the new home of each setting.
  $ jest --config ./test/jest-e2e.json --runInBand "payment-fulfillment.e2e-spec.ts"
  (node:12064) [DEP0169] DeprecationWarning: `url.parse()` behavior is not standardized and prone to errors that have security implications. Use the WHATWG URL API instead. CVEs are not issued for `url.parse()` vulnerabilities.
  (Use `node --trace-deprecation ...` to show where the warning was created)
  [Nest] 12064  - 14:44:12 16/09/2026   ERROR [PaymentService] Duffel booking failed: Duffel booking failed
  Error: Duffel booking failed
      at Object.<anonymous> (C:\Booking Systems\apps\api\test\payment-fulfillment.e2e-spec.ts:549:28)
    console.error
      THROWN ERROR: Duffel booking failed: Duffel booking failed. Payment hold released.

        1441 |           );
        1442 |
      > 1443 |           console.error('THROWN ERROR:', failureResponse.error);
             |                   ^
        1444 |           throw new HttpException(failureResponse, HttpStatus.BAD_GATEWAY);
        1445 |         }
        1446 |

        at PaymentService.executeConfirmPayment (../src/payment/payment.service.ts:1443:19)
        at ../src/payment/payment.service.ts:948:24
        at PaymentService.confirmPayment (../src/payment/payment.service.ts:961:20)
        at PaymentController.confirmPayment (../src/payment/payment.controller.ts:74:20)
        at ../../../node_modules/.pnpm/@nestjs+core@10.4.22_@nestj_558ae3c7cf983d845eb445c3b6d17e96/node_modules/@nestjs/core/router/router-execution-context.js:46:28
        at ../../../node_modules/.pnpm/@nestjs+core@10.4.22_@nestj_558ae3c7cf983d845eb445c3b6d17e96/node_modules/@nestjs/core/router/router-proxy.js:9:17

  [Nest] 12064  - 14:44:12 16/09/2026   ERROR [PaymentService] Error in confirmPayment: Http Exception
  HttpException: Http Exception
      at PaymentService.executeConfirmPayment (C:\Booking Systems\apps\api\src\payment\payment.service.ts:1444:17)
      at C:\Booking Systems\apps\api\src\payment\payment.service.ts:948:24
      at PaymentService.confirmPayment (C:\Booking Systems\apps\api\src\payment\payment.service.ts:961:20)
      at PaymentController.confirmPayment (C:\Booking Systems\apps\api\src\payment\payment.controller.ts:74:20)
      at C:\Booking Systems\node_modules\.pnpm\@nestjs+core@10.4.22_@nestj_558ae3c7cf983d845eb445c3b6d17e96\node_modules\@nestjs\core\router\router-execution-context.js:46:28
      at C:\Booking Systems\node_modules\.pnpm\@nestjs+core@10.4.22_@nestj_558ae3c7cf983d845eb445c3b6d17e96\node_modules\@nestjs\core\router\router-proxy.js:9:17
  [Nest] 12064  - 14:44:12 16/09/2026   ERROR [HttpExceptionFilter] [HttpExceptionFilter] POST /api/bookings/payment/confirm - Http Exception
  {"timestamp":"2026-09-16T07:44:12.982Z","level":"error","service":"api","trace_id":null,"correlation_id":null,"message":"Http Exception","metadata":{"path":"/api/bookings/payment/confirm","method":"POST","status":502,"stack":"HttpException: Http Exception\n    at PaymentService.executeConfirmPayment (C:\\Booking Systems\\apps\\api\\src\\payment\\payment.service.ts:1444:17)\n    at C:\\Booking Systems\\apps\\api\\src\\payment\\payment.service.ts:948:24\n    at PaymentService.confirmPayment (C:\\Booking Systems\\apps\\api\\src\\payment\\payment.service.ts:961:20)\n    at PaymentController.confirmPayment (C:\\Booking Systems\\apps\\api\\src\\payment\\payment.controller.ts:74:20)\n    at C:\\Booking Systems\\node_modules\\.pnpm\\@nestjs+core@10.4.22_@nestj_558ae3c7cf983d845eb445c3b6d17e96\\node_modules\\@nestjs\\core\\router\\router-execution-context.js:46:28\n    at C:\\Booking Systems\\node_modules\\.pnpm\\@nestjs+core@10.4.22_@nestj_558ae3c7cf983d845eb445c3b6d17e96\\node_modules\\@nestjs\\core\\router\\router-proxy.js:9:17"}}
  [Nest] 12064  - 14:44:16 16/09/2026   ERROR [PaymentService] Duffel booking failed: Duffel booking failed
  Error: Duffel booking failed
      at Object.<anonymous> (C:\Booking Systems\apps\api\test\payment-fulfillment.e2e-spec.ts:779:28)
    console.error
      THROWN ERROR: Duffel booking failed: Duffel booking failed. Payment hold released.

        1441 |           );
        1442 |
      > 1443 |           console.error('THROWN ERROR:', failureResponse.error);
             |                   ^
        1444 |           throw new HttpException(failureResponse, HttpStatus.BAD_GATEWAY);
        1445 |         }
        1446 |

        at PaymentService.executeConfirmPayment (../src/payment/payment.service.ts:1443:19)
        at ../src/payment/payment.service.ts:948:24
        at PaymentService.confirmPayment (../src/payment/payment.service.ts:961:20)
        at PaymentController.confirmPayment (../src/payment/payment.controller.ts:74:20)
        at ../../../node_modules/.pnpm/@nestjs+core@10.4.22_@nestj_558ae3c7cf983d845eb445c3b6d17e96/node_modules/@nestjs/core/router/router-execution-context.js:46:28
        at ../../../node_modules/.pnpm/@nestjs+core@10.4.22_@nestj_558ae3c7cf983d845eb445c3b6d17e96/node_modules/@nestjs/core/router/router-proxy.js:9:17

  [Nest] 12064  - 14:44:16 16/09/2026   ERROR [PaymentService] Error in confirmPayment: Http Exception
  HttpException: Http Exception
      at PaymentService.executeConfirmPayment (C:\Booking Systems\apps\api\src\payment\payment.service.ts:1444:17)
      at C:\Booking Systems\apps\api\src\payment\payment.service.ts:948:24
      at PaymentService.confirmPayment (C:\Booking Systems\apps\api\src\payment\payment.service.ts:961:20)
      at PaymentController.confirmPayment (C:\Booking Systems\apps\api\src\payment\payment.controller.ts:74:20)
      at C:\Booking Systems\node_modules\.pnpm\@nestjs+core@10.4.22_@nestj_558ae3c7cf983d845eb445c3b6d17e96\node_modules\@nestjs\core\router\router-execution-context.js:46:28
      at C:\Booking Systems\node_modules\.pnpm\@nestjs+core@10.4.22_@nestj_558ae3c7cf983d845eb445c3b6d17e96\node_modules\@nestjs\core\router\router-proxy.js:9:17
  [Nest] 12064  - 14:44:16 16/09/2026   ERROR [HttpExceptionFilter] [HttpExceptionFilter] POST /api/bookings/payment/confirm - Http Exception
  {"timestamp":"2026-09-16T07:44:16.320Z","level":"error","service":"api","trace_id":null,"correlation_id":null,"message":"Http Exception","metadata":{"path":"/api/bookings/payment/confirm","method":"POST","status":502,"stack":"HttpException: Http Exception\n    at PaymentService.executeConfirmPayment (C:\\Booking Systems\\apps\\api\\src\\payment\\payment.service.ts:1444:17)\n    at C:\\Booking Systems\\apps\\api\\src\\payment\\payment.service.ts:948:24\n    at PaymentService.confirmPayment (C:\\Booking Systems\\apps\\api\\src\\payment\\payment.service.ts:961:20)\n    at PaymentController.confirmPayment (C:\\Booking Systems\\apps\\api\\src\\payment\\payment.controller.ts:74:20)\n    at C:\\Booking Systems\\node_modules\\.pnpm\\@nestjs+core@10.4.22_@nestj_558ae3c7cf983d845eb445c3b6d17e96\\node_modules\\@nestjs\\core\\router\\router-execution-context.js:46:28\n    at C:\\Booking Systems\\node_modules\\.pnpm\\@nestjs+core@10.4.22_@nestj_558ae3c7cf983d845eb445c3b6d17e96\\node_modules\\@nestjs\\core\\router\\router-proxy.js:9:17"}}
  PASS test/payment-fulfillment.e2e-spec.ts (52.842 s)
    Payment Fulfillment (E2E Characterization)
      Scenario 1: HTTP 200 Immediate Success
        √ successfully confirms payment, creates duffel order, captures payment intent and marks booking CONFIRMED (1546 ms)
      Scenario 2: HTTP 202 Tier 2 Handoff
        √ returns HTTP 202 with PENDING status and polling URL when execution exceeds 25s threshold (553 ms)
      Scenario 3: Idempotency Replay Asymmetry
        √ replays cached HTTP 200 response without duplicating Stripe or Duffel calls (1481 ms)
        √ replays a completed failure with HTTP 200 and preserved failure body (749 ms)
        √ reconstructs legacy completed success row without cached responseBody with HTTP 200 (388 ms)
        √ reconstructs legacy completed failure row without cached responseBody with HTTP 200 (337 ms)
      Scenario 4: Validation Rejection
        √ rejects with 400 when Idempotency-Key header is missing (556 ms)
        √ rejects with 400 when request payload is invalid or missing paymentId (658 ms)
      Scenario 5: Controlled Compensation
        √ cancels Stripe hold, sets payment CANCELLED and booking FAILED on Duffel order failure (1392 ms)

  Test Suites: 1 passed, 1 total
  Tests:       9 passed, 9 total
  Snapshots:   0 total
  Time:        54.223 s, estimated 92 s
  Ran all test suites matching /payment-fulfillment.e2e-spec.ts/i.
  ```

---

### Characterization Scenarios Verified

| Scenario | Test Description | Assertions & Behavior Verified | Status |
|---|---|---|---|
| **Scenario 1: HTTP 200 Immediate Success** | Fast-path order creation & capture | Synchronously completes `POST /api/bookings/payment/confirm`. Calls Duffel `createOrder`, Stripe `capturePaymentIntent`. Updates database `Payment` to `SUCCEEDED` and `Booking` to `CONFIRMED`. Returns HTTP 200 with `{ success: true, status: 'SUCCEEDED', bookingReference, duffelOrderId }`. | **PASSED** |
| **Scenario 2: HTTP 202 Tier 2 Handoff** | Slow downstream order creation handoff | Simulated Duffel latency exceeding Tier 2 threshold triggers graceful degradation. Returns HTTP 202 Accepted with `{ status: 'PENDING', message: 'Booking is being confirmed. Please poll status.', pollUrl: '/api/bookings/payment/:id/status' }`. Background execution completes asynchronously; polled `Payment` reaches terminal `SUCCEEDED` status and canonical `Booking` is confirmed `CONFIRMED`. | **PASSED** |
| **Scenario 3: Idempotency Replay Asymmetry** | Replay of cached keys and legacy reconstruction | **1. Replay cached HTTP 200**: Identical idempotency key and payload immediately returns cached HTTP 200 without duplicate provider calls.<br>**2. Replay completed failure**: Stored failure key (responseCode: 502) replays with HTTP 200 (controller does not forward stored responseCode) returning `{ success: false, error: ... }` without duplicate provider calls.<br>**3. Legacy success reconstruction**: Payment is SUCCEEDED, PaymentEvent has `duffel_order_created`, IdempotencyKey has `recoveryPoint: 'completed'` and `responseBody: null`. Confirm reconstructs HTTP 200 success response.<br>**4. Legacy failure reconstruction**: Payment is CANCELLED, IdempotencyKey has `recoveryPoint: 'completed'` and `responseBody: null`. Confirm reconstructs HTTP 200 failure response containing `'Payment hold released'`. | **PASSED** |
| **Scenario 4: Validation Rejection** | Header and payload validation gates | **Test A**: Request omitting `Idempotency-Key` header rejected with HTTP 400 (`Idempotency-Key header is required`).<br>**Test B**: Request omitting required payload field `paymentId` rejected with HTTP 400. | **PASSED** |
| **Scenario 5: Controlled Compensation** | Upstream failure triggers rollback | Downstream Duffel `createOrder` throws 502/failure. System triggers compensation: Stripe authorization hold released via `cancelPaymentIntent(payment.stripePaymentIntentId)`. Database `Payment` marked `CANCELLED` and `Booking` marked `FAILED`. Endpoint returns HTTP 502 Bad Gateway with hold released message. | **PASSED** |

---

### Conclusion & Phase 1 Sign-Off
Baseline characterization is fully established and passing under CI network isolation guards. All runtime files in `apps/api/src/` remain unaltered. The test harness in `apps/api/test/payment-fulfillment.e2e-spec.ts` serves as the regression anchor for Phase 2 (Foundation) and Phase 3 (US1: Safe payment orchestration).
