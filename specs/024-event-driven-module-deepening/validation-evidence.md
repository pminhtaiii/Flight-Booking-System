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

---

## Phase 3 Slice 2 Verification: Tasks T007 & T008 (US1 Provider Adapters)

**Execution Date**: 2026-09-16  
**Scope**: Provider-blind adapter implementations with bounded concurrency admission:
- Task T007 [US1]: `StripePaymentAdapter` (`apps/api/src/common/stripe-payment.adapter.ts`), `StripeModule` binding (`PAYMENT_GATEWAY_PORT`).
- Task T008 [US1]: `DuffelFulfillmentAdapter` (`apps/api/src/duffel/duffel-fulfillment.adapter.ts`), `DuffelModule` binding (`FULFILLMENT_GATEWAY_PORT`).
- Reusable utility: `BoundedSemaphore` (`apps/api/src/payment-fulfillment/utils/bounded-semaphore.ts`).

### 1. Adapter Unit Test Results (CI Network Guard)

```powershell
$guard = (Convert-Path "$PWD/tests/ci/node-network-guard.cjs").Replace('\', '/'); $env:NODE_OPTIONS = "--require=`"$guard`""; pnpm --filter @api/backend test -- apps/api/src/payment-fulfillment/utils/bounded-semaphore.spec.ts apps/api/src/common/stripe-payment.adapter.spec.ts apps/api/src/duffel/duffel-fulfillment.adapter.spec.ts apps/api/src/idempotency/payment-idempotency.service.spec.ts; Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
```

```
PASS src/payment-fulfillment/utils/bounded-semaphore.spec.ts
PASS src/idempotency/payment-idempotency.service.spec.ts
PASS src/duffel/duffel-fulfillment.adapter.spec.ts
PASS src/common/stripe-payment.adapter.spec.ts

Test Suites: 4 passed, 4 total
Tests:       119 passed, 119 total
Snapshots:   0 total
```

### 2. Static Type & Linter Verification

- `pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit`: **Exit code 0** (0 errors)
- `pnpm exec eslint "apps/api/src/common/**/*.ts" "apps/api/src/duffel/**/*.ts" "apps/api/src/payment-fulfillment/**/*.ts" --max-warnings 0`: **Exit code 0** (0 errors, 0 warnings)

### 3. E2E Characterization Suite Regression Check

- `pnpm --filter @api/backend test:e2e -- test/payment-fulfillment.e2e-spec.ts`: **9 passed, 9 total** (Exit code 0)

### 4. Dual-Axis Code Review Sign-off

- Standards Review: 0 blocking violations; explicit logging added on order retrieval fallback; parameter types and return values fully typed.
- Spec Review: Status normalization includes `'invalid'` for `requires_payment_method` / unknown; void idempotency key (`${intentId}-stripe-void`) passed; positive integer validation on environment parameters verified.

---

## Phase 3 Slice 4 Verification: Task T014 (Nest Composition Architecture Gate)

**Execution Date**: 2026-09-17  
**Scope**: NestJS runtime composition tests verifying dependency injection tokens, provider uniqueness, acyclic module boundaries, direct SDK wrapper retention, and strict phase invariants in `apps/api/test/module-deepening.e2e-spec.ts`.

### 1. Composition Gate E2E Test Results (CI Network Guard)

- **Command**:
  ```powershell
  $env:NODE_OPTIONS = "--require=`"$($PWD.Path.Replace('\', '/'))/tests/ci/node-network-guard.cjs`""
  pnpm --filter @api/backend test:e2e -- module-deepening.e2e-spec.ts
  ```
- **Exit Code**: `0`
- **Duration**: 56.295s (test suite), 57.816s (wall clock)
- **Summary**:
  - Test Suites: **1 passed, 1 total**
  - Tests: **15 passed, 15 total**
  - Snapshots: **0 total**

```text
PASS test/module-deepening.e2e-spec.ts (56.295 s)
  Nest Composition Architecture Gate (US1 - T014)
    1. Gateway Port Resolution to Concrete Adapters
      √ resolves PAYMENT_GATEWAY_PORT to StripePaymentAdapter in AppModule (9 ms)
      √ resolves FULFILLMENT_GATEWAY_PORT to DuffelFulfillmentAdapter in AppModule (5 ms)
      √ resolves both ports within PaymentFulfillmentModule scope (3 ms)
      √ injects concrete adapters into PaymentFulfillmentSaga (1 ms)
      √ compiles standalone PaymentFulfillmentModule with ConfigModule and resolves ports (174 ms)
    2. Single Registration of PaymentMethodService
      √ registers PaymentMethodService in exactly one module across all active modules in AppModule (5 ms)
      √ declares PaymentMethodService in PaymentMethodsModule metadata, and NOT in PaymentModule or PaymentFulfillmentModule (2 ms)
      √ resolves the identical singleton instance of PaymentMethodService across all consuming modules (2 ms)
    3. Zero Circular Dependencies Between PaymentModule and PaymentFulfillmentModule
      √ verifies static module metadata: PaymentModule imports PaymentFulfillmentModule, PaymentFulfillmentModule does NOT import PaymentModule (25 ms)
      √ verifies zero direct or transitive import of PaymentModule from PaymentFulfillmentModule (1 ms)
      √ verifies runtime NestContainer dependency graph has no reverse link or cycle (2 ms)
    4. BookingRecoveryService Retains Direct SDK Wrappers
      √ injects direct StripeService and DuffelService into BookingRecoveryService constructor metadata (1 ms)
      √ holds direct SDK instances at runtime and does NOT expose saga ports or adapter instances (7 ms)
    5. Strict Phase Invariants (No Premature Phase 4 / US2 Leaks)
      √ does not register EventEmitterModule or EventEmitter2 in AppModule for US1 (1 ms)
      √ does not register BookingProjectionModule or BookingEventPublisherService in AppModule for US1 (1 ms)
```

### 2. Static Type & Linter Verification

- `pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit`: **Exit code 0** (0 errors)
- `pnpm exec eslint "apps/api/test/module-deepening.e2e-spec.ts"`: **Exit code 0** (0 errors)

### 3. Architecture Invariants Verified

| Invariant | Test Verification | Status |
|---|---|---|
| **Port Resolution** | `PAYMENT_GATEWAY_PORT` and `FULFILLMENT_GATEWAY_PORT` resolve to `StripePaymentAdapter` and `DuffelFulfillmentAdapter` across `AppModule`, scoped `PaymentFulfillmentModule`, and standalone fixture. | **PASSED** |
| **Provider Uniqueness** | `PaymentMethodService` registered exactly once across all active modules in `AppModule`, declared only in `PaymentMethodsModule`, resolving identical singleton instance across all consumers. | **PASSED** |
| **Acyclic Architecture** | `PaymentModule` imports `PaymentFulfillmentModule`. `PaymentFulfillmentModule` does NOT import `PaymentModule` directly or transitively (zero cycles in runtime NestContainer graph). | **PASSED** |
| **Direct Wrapper Retention** | `BookingRecoveryService` directly injects `StripeService` and `DuffelService` without routing through saga ports (`PAYMENT_GATEWAY_PORT`, `FULFILLMENT_GATEWAY_PORT`). | **PASSED** |
| **Strict Phase Invariants** | Zero Phase 4 items (`EventEmitterModule`, `BookingProjectionModule`, `DomainEventsModule`) present in `AppModule`. | **PASSED** |

---

## Phase 3 Slice 5 Verification: Task T013 (Comprehensive PostgreSQL E2E Failure, Resumption & Compensation Suite)

**Execution Date**: 2026-09-17  
**Scope**: Full PostgreSQL E2E failure, resumption, compensation, and idempotency suite in `apps/api/test/payment-fulfillment.e2e-spec.ts` and `apps/api/test/payment-idempotency.e2e-spec.ts`.

### 1. Payment Fulfillment E2E Suite Results

- **Command**:
  ```powershell
  $env:NODE_OPTIONS = "--require=`"$($PWD.Path.Replace('\', '/'))/tests/ci/node-network-guard.cjs`""
  pnpm --filter @api/backend test:e2e -- payment-fulfillment.e2e-spec.ts
  ```
- **Exit Code**: `0`
- **Duration**: 48.363s (test suite), 52.115s (wall clock)
- **Summary**:
  - Test Suites: **1 passed, 1 total**
  - Tests: **26 passed, 26 total**
  - Snapshots: **0 total**

```text
PASS test/payment-fulfillment.e2e-spec.ts (48.363 s)
  Payment Fulfillment (E2E Characterization)
    Scenario 1: HTTP 200 Immediate Success
      √ successfully confirms payment, creates duffel order, captures payment intent and marks booking CONFIRMED
    Scenario 2: HTTP 202 Tier 2 Handoff
      √ returns HTTP 202 with PENDING status and polling URL when execution exceeds 25s threshold
    Scenario 3: Idempotency Replay Asymmetry
      √ replays cached HTTP 200 response without duplicating Stripe or Duffel calls
      √ replays a completed failure with HTTP 200 and preserved failure body
      √ reconstructs legacy completed success row without cached responseBody with HTTP 200
      √ reconstructs legacy completed failure row without cached responseBody with HTTP 200
    Scenario 4: Validation Rejection
      √ rejects with 400 when Idempotency-Key header is missing
      √ rejects with 400 when request payload is invalid or missing paymentId
    Scenario 5: Controlled Compensation
      √ cancels Stripe hold, sets payment CANCELLED and booking FAILED on Duffel order failure
    Scenario 6: Fenced Checkpoint Resumption
      √ resumes from CHECKPOINT_AUTHORIZED (stripe_authorized): skips hold authorization and proceeds to Duffel order, Stripe capture, and confirmation
      √ resumes from CHECKPOINT_ORDER_CREATED (duffel_order_created): skips hold auth and Duffel order, proceeds to capture and confirmation
      √ resumes from CHECKPOINT_CAPTURED (captured): completes canonical confirmation without re-invoking capture or Duffel order
    Scenario 7: Duplicate Remote Effects & Replay Invariants
      √ returns 409 Conflict when payment confirmation is already in-flight under active lease without duplicate provider calls
    Scenario 8: Atomic Completion & Transaction Rollback
      √ verifies that Booking CONFIRMED, Payment SUCCEEDED, and balanced ledger entries commit atomically in one transaction
      √ rolls back completely on DB failure during post-capture confirmation without canceling payment or order
    Scenario 9: Stale Owner Takeover & CAS Eviction
      √ aborts and prevents provider call when ownership is lost before hold authorization
      √ aborts and prevents Duffel order creation when ownership is lost before createOrder
      √ aborts and prevents Stripe capture when ownership is lost before capturePayment
      √ aborts compensation and prevents voidHold when ownership is lost during compensation
      √ aborts gracefully in background execution after 25s handoff when ownership is taken over
    Scenario 10: Capture Throw Matrix
      √ proceeds to complete canonical booking when capture throws but subsequent status check reveals captured (succeeded)
      √ cancels Duffel order, voids hold, and marks booking FAILED when capture throws and subsequent status check reveals authorized (requires_capture)
      √ cancels Duffel order, voids hold, and marks booking FAILED when capture throws and subsequent status check reveals voided (canceled)
      √ leaves state recoverable without canceling order or payment when capture throws and status check is unavailable
    Scenario 11: Failed Compensation & DB Failure Handling
      √ safely handles failed hold voiding during Duffel failure compensation without leaking internal stack traces
      √ preserves capture and does not cancel payment when post-capture DB confirmation fails
```

### 2. Payment Idempotency E2E Suite Results

- **Command**:
  ```powershell
  $env:NODE_OPTIONS = "--require=`"$($PWD.Path.Replace('\', '/'))/tests/ci/node-network-guard.cjs`""
  pnpm --filter @api/backend test:e2e -- payment-idempotency.e2e-spec.ts
  ```
- **Exit Code**: `0`
- **Duration**: 36.839s (test suite), 38.315s (wall clock)
- **Summary**:
  - Test Suites: **1 passed, 1 total**
  - Tests: **8 passed, 8 total**
  - Snapshots: **0 total**

```text
PASS test/payment-idempotency.e2e-spec.ts (36.839 s)
  Payment Idempotency (E2E)
    POST /api/bookings/payment/create - Idempotency
      √ replays cached response when same idempotency key is used (only 1 Payment in DB)
      √ returns 422 when same key is used with different payload
      √ returns 400 when Idempotency-Key header is missing
    Recovery point resumption - POST /api/bookings/payment/confirm
      √ resumes from stripe_authorized recovery point
      √ replays completed result without calling Stripe or Duffel again
    Acquisition Edge Cases and Stale Lock CAS Eviction
      √ returns 409 Conflict when request is actively in progress within 5-minute lease
      √ successfully acquires and takes over stale lock when existing lockedAt is older than 5 minutes
      √ returns 409 Conflict when key is used across different customers (customerId mismatch)
```

### 3. Strict Invariants Verified

| Invariant | Test Verification | Status |
|---|---|---|
| **Zero DB locks across provider calls** | No financial database transactions held during Stripe or Duffel invocations. | **PASSED** |
| **Known capture never cancels** | Capture failures reconciled as captured or DB errors after capture never cancel Duffel order or void payment hold. | **PASSED** |
| **Same-promise handoff** | 25s threshold returns 202 while same promise completes in background. | **PASSED** |
| **CAS Eviction & Stale Owner Fencing** | Lease takeover before any provider call or during compensation causes immediate abort with zero subsequent effects. | **PASSED** |
| **Atomic Completion & Rollback** | Payment SUCCEEDED, Booking CONFIRMED, and dual ledger entries commit together; post-capture DB errors rollback completely without orphan state. | **PASSED** |
| **Capture Throw Matrix** | All 3 paths (`captured`, `authorized/voided`, `unavailable/unknown`) follow strict safety contracts. | **PASSED** |

---

## Phase 4 — US2: Event-Driven Safe Booking Projection (T016)

### 1. Schema Migration & Prisma Generation Evidence

- **Migration**: `20260915000000_booking_projection_versions`
- **Columns Added**:
  - `bookings.version`: `INTEGER NOT NULL DEFAULT 1`
  - `booking_agent_projections.source_version`: `INTEGER NOT NULL DEFAULT 0`
- **Deployment Command**:
  ```powershell
  Push-Location apps/api
  & '.\node_modules\.bin\prisma.CMD' generate
  & '.\node_modules\.bin\prisma.CMD' migrate deploy
  Pop-Location
  ```
- **Exit Code**: `0`
- **Output**:
  ```text
  ✔ Generated Prisma Client (v5.22.0) to .\..\..\node_modules\.pnpm\@prisma+client@5.22.0_prisma@5.22.0\node_modules\@prisma\client in 904ms
  Applying migration `20260915000000_booking_projection_versions`
  All migrations have been successfully applied.
  ```

---

### 2. Booking & Projection Version Migration E2E Suite Results

- **Command**:
  ```powershell
  $env:NODE_OPTIONS = "--require=`"$($PWD.Path.Replace('\', '/'))/tests/ci/node-network-guard.cjs`""
  pnpm --filter @api/backend test:e2e -- booking-projection-version-migration.e2e-spec.ts
  ```
- **Exit Code**: `0`
- **Duration**: 26.635s (test suite), 27.87s (wall clock)
- **Suite Summary**:
  - Test Suites: **1 passed, 1 total**
  - Tests: **5 passed, 5 total**
  - Snapshots: **0 total**

- **Terminal Output**:
  ```text
  PASS test/booking-projection-version-migration.e2e-spec.ts (26.635 s)
    Booking & BookingAgentProjection Version Migration (E2E)
      Default Values Verification
        √ verifies new Booking row has default version = 1 (46 ms)
        √ verifies new BookingAgentProjection row has default sourceVersion = 0 (20 ms)
        √ verifies PostgreSQL column defaults apply when inserted via raw SQL without specifying version columns (111 ms)
      Foreign Key & Relation Preservation
        √ verifies existing foreign keys and one-to-one references are preserved with new columns present (71 ms)
      Legacy-Writer Compatibility Fixture
        √ verifies that updates omitting version leave Booking.version intact, unchanged (1), and valid (49 ms)

  Test Suites: 1 passed, 1 total
  Tests:       5 passed, 5 total
  Snapshots:   0 total
  Time:        27.87 s
  Ran all test suites matching /booking-projection-version-migration.e2e-spec.ts/i.
  ```

---

### 3. Migration Invariants Verified

| Invariant | Test Verification | Status |
|---|---|---|
| **Booking default version** | New and raw SQL inserted `Booking` rows default to `version = 1`. | **PASSED** |
| **BookingAgentProjection default sourceVersion** | New and raw SQL inserted `BookingAgentProjection` rows default to `source_version = 0`. | **PASSED** |
| **Foreign key & relation preservation** | One-to-one relations (`Booking.agentProjection`, `BookingAgentProjection.booking`, `Booking.user`, `Booking.bookingIntent`) remain intact. | **PASSED** |
| **Legacy-writer compatibility** | Legacy updates (Prisma and raw SQL) omitting `version` leave `Booking.version` intact and unchanged at `1`. | **PASSED** |
| **Typecheck & ESLint Gate** | Zero TypeScript compilation errors and zero ESLint warnings across backend. | **PASSED** |

---

## Phase 4 Slice 3 — Projection Consumer Subsystem (Tasks T021–T023)

### Overview
This section records verification evidence for the asynchronous projection consumer pipeline implemented in Slice 3:
1. `BookingEventHydratorService` (`apps/api/src/domain-events/`): cycle-scoped promise deduplication cache.
2. `BookingProjectionService` & `BookingProjectionRepository` (`apps/api/src/booking-projection/`): safe flight extraction with strict no-stale-fallback invariant and atomic guarded upsert.
3. `BookingProjectionListener`, `BookingProjectionMetrics`, and `BookingProjectionModule` (`apps/api/src/booking-projection/`): `@OnEvent('booking.*')` subscription, complete error isolation, and bounded telemetry.

---

### Verification Commands & Execution Logs

#### 1. ESLint Gate
- **Command**:
  ```powershell
  pnpm exec eslint "apps/api/**/*.ts" --max-warnings 0
  ```
- **Exit Code**: `0`
- **Output**: Clean pass, 0 errors, 0 warnings.

#### 2. TypeScript Compiler Gate
- **Command**:
  ```powershell
  pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit
  ```
- **Exit Code**: `0`
- **Output**: Clean pass, 0 errors.

#### 3. Hydrator & Projection Unit Test Suites
- **Command**:
  ```powershell
  $env:NODE_OPTIONS = '--require="c:/Booking Systems/tests/ci/node-network-guard.cjs"'; pnpm --filter @api/backend test -- apps/api/src/domain-events/booking-event-hydrator.service.spec.ts apps/api/src/booking-projection/
  ```
- **Exit Code**: `0`
- **Duration**: ~55s
- **Suite Summary**:
  - Test Suites: **5 passed, 5 total**
  - Tests: **55 passed, 55 total**
  - Snapshots: **0 total**
- **Terminal Output**:
  ```text
  PASS src/booking-projection/booking-projection.metrics.spec.ts
  PASS src/domain-events/booking-event-hydrator.service.spec.ts
  PASS src/booking-projection/booking-projection.service.spec.ts
  PASS src/booking-projection/booking-projection.listener.spec.ts
  PASS src/booking-projection/booking-projection.repository.spec.ts

  Test Suites: 5 passed, 5 total
  Tests:       55 passed, 55 total
  Snapshots:   0 total
  Time:        55.244 s
  ```

---

### Invariants Verified

| Invariant | Test Verification | Status |
|---|---|---|
| **Booking Events Only** | Listener subscribes strictly to `@OnEvent('booking.*')`. Does NOT subscribe to `refund.settled`. | **PASSED** |
| **Cycle-Scoped Deduplication** | Concurrent calls share single DB fetch; cache clears via `.finally()`. Subsequent cycles trigger fresh read. | **PASSED** |
| **No Stale Fallback** | Malformed/empty authoritative revision throws `MalformedRevisionError`; never falls back to initial `flightSnapshot`. | **PASSED** |
| **Monotonic Version Guard** | Repository conditionally upserts only when `source_version < EXCLUDED.source_version`. Out-of-order writes safely ignored. | **PASSED** |
| **Stable Agent Reference** | Concurrent winner's `agentReference` is immutable across updates. | **PASSED** |
| **Listener Error Isolation** | Hydrator, mapping, or database exceptions caught and logged with structured context without bubbling or crashing. | **PASSED** |
| **Bounded Telemetry** | Metrics use safe labels without PII, booking IDs, or user IDs. | **PASSED** |
| **Untouched Slice 4 Callers** | Producers (Saga, Recovery, Cancellation, Disruption, Settlement) remain untouched. | **PASSED** |




