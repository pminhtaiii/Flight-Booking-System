# Feature 029 Verification: Narrow the Duffel Supplier Boundary

## Phase 1: Setup and Behavior Baseline (T001–T004)

Run from `C:\Booking Systems` on 2026-09-29. All commands exited with code 0.

### Verification Matrix

| Check | Command | Result |
| --- | --- | --- |
| **Phase 1 Jest Matrix (Full)** | `pnpm --filter @api/backend exec jest --runInBand src/duffel/duffel.service.spec.ts src/flights/flights.service.spec.ts src/flights/flight-search-orchestrator.service.spec.ts src/duffel/duffel-ancillary.service.spec.ts src/payment/ancillary-payment-validation.service.spec.ts src/duffel/duffel-fulfillment.adapter.spec.ts src/payment-fulfillment/payment-fulfillment.saga.spec.ts` | **PASS**: 7 suites passed, 260 tests passed, 0 failed (~48.34s). |
| **Quickstart Baseline Checkpoint** | `pnpm --filter @api/backend exec jest --runInBand src/duffel/duffel.service.spec.ts src/flights/flights.service.spec.ts src/flights/flight-search-orchestrator.service.spec.ts` | **PASS**: 3 suites passed, 128 tests passed, 0 failed (~22.43s). |
| **TypeScript Typecheck** | `pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit` | **PASS**: Exit 0; 0 compilation errors across backend API. |
| **Private SDK Indexing Census** | `Get-ChildItem -Path "apps/api/src" -Recurse -Filter "*.ts" \| Select-String -Pattern "duffelService\['duffel'\]"` | **PASS**: 0 matches found in `apps/api/src`. |
| **Broad Bracket Access Census** | `Get-ChildItem -Path "apps/api/src" -Recurse -Filter "*.ts" \| Select-String -Pattern "\['duffel'\]"` | **PASS**: 0 matches found in `apps/api/src`. |

---

### Task Implementation Details

#### T001: Flight Search & Offer Detail Baseline Characterization
- Characterized raw vs cached flight searches (user and agent scopes).
- Characterized deterministic UUID generation and result ordering based on search hash and rank.
- Characterized rate budget enforcement (caller and global limits).
- Characterized all 10 live offer detail scenarios (successful retrieval, price drift detection, 404 purge, 410 purge, purge failure resilience, upstream 500 error mapping, DuffelTimeoutError translation without DB purge, fallback to offerRecovery on purged offer, 404 for missing valid UUID, and 400 for invalid UUID format) in `duffel.service.spec.ts` and `flights.service.spec.ts`.

#### T002: Ancillary Catalog & Repricing Characterization
- Characterized seat-map caching, TTLs, and missing-map fallbacks in `duffel-ancillary.service.spec.ts`.
- Characterized service quarantine for invalid or missing seat/baggage records.
- Characterized priced-offer validation, passenger-scope checks, and amount/currency reconciliation in `ancillary-payment-validation.service.spec.ts`.

#### T003: Fulfillment Adapter & Payment Saga Compensation Characterization
- Characterized create/retrieve/cancel operations, order idempotency, and semaphore concurrency gating in `duffel-fulfillment.adapter.spec.ts`.
- Characterized PII redaction in persisted order snapshots and payment logs.
- Characterized compensation and replay paths, unconfirmed cancellation handling, and fencing in `payment-fulfillment.saga.spec.ts`.

#### T004: Seal Private SDK Access & Verify Baselines
- Replaced the private bracket escape hatch in `apps/api/src/flights/flights.service.ts`:
  ```typescript
  // Before:
  const duffelResponse = await this.duffelService['duffel'].offers.get(
    flightOffer.duffelOfferId,
  );
  liveOffer = duffelResponse.data;

  // After:
  liveOffer = (await this.duffelService.getOfferById(
    flightOffer.duffelOfferId,
  )) as Record<string, unknown>;
  ```
- Updated unit test mocks in `apps/api/src/flights/flights.service.spec.ts`:
  - Removed `mockOffersGet` and the nested `duffel: { offers: { get } }` mock shape.
  - Added typed `getOfferById: jest.Mock` to `duffelService`.
  - Updated and characterized all 10 flight detail test scenarios (successful retrieval, price drift detection, 404 purge, 410 purge, purge failure resilience, upstream 500 error mapping, DuffelTimeoutError translation without DB purge, fallback to offerRecovery, 404 for missing valid UUID, and 400 for invalid UUID format) to mock and assert `duffelService.getOfferById`.
- Verified zero instances of private SDK bracket access remain in `apps/api/src`.
- Confirmed full clean build and typecheck with zero compiler warnings or errors.

---

### Invariants Verification
- **Zero `any` in new code or test fixtures**: `liveOffer` in `flights.service.ts:getFlightDetail` continues to be declared as `Record<string, any>` internally; the cast to `Record<string, unknown>` at the public `getOfferById` callsite does not remove this internal type declaration (full cleanup scheduled for Phase 3). All new test fixtures and mocks avoid `any`.
- **No functional regressions**: All 260 characterization tests passed without changes to public interfaces or business behaviors.
- **Phase 1 Convergence**: Tasks T001, T002, T003, and T004 in `specs/029-duffel-provider-narrowing/tasks.md` are marked `[x]`.

---

## Phase 2: Foundational Duffel Core and Shared Budget (T005–T012)

Run from `C:\Booking Systems` on 2026-09-29. All commands exited with code 0.

### Verification Matrix

| Check | Command | Result |
| --- | --- | --- |
| **Phase 2 Core & Consumer Jest Matrix** | `pnpm --filter @api/backend exec jest --runInBand src/supplier/core/duffel-core.module.spec.ts src/supplier/core/duffel-rate-budget.service.spec.ts src/cache/cache.service.spec.ts src/duffel/duffel.service.spec.ts src/flights/flights.service.spec.ts src/disruption/sync/reconciliation.service.spec.ts` | **PASS**: 6 suites passed, 133 tests passed, 0 failed (~53.63s). |
| **TypeScript Typecheck** | `pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit` | **PASS**: Exit 0; 0 compilation errors across backend API. |
| **Obsolete Monthly Budget Census** | `Get-ChildItem -Path "apps/api/src" -Recurse -Filter "*.ts" \| Select-String -Pattern "budget:duffel:\$\{"` | **PASS**: 0 matches found in `apps/api/src`. |
| **Active Duffel Budget Key Census** | `Get-ChildItem -Path "apps/api/src" -Recurse -Filter "*.ts" \| Select-String -Pattern "budget:duffel:"` | **PASS**: All occurrences reference daily keys (`budget:duffel:daily:...`). No monthly counter remains active. |

---

### Task Implementation Details

#### T005: Core Module & SDK Provider Baseline Tests
- Verified singleton Duffel SDK instance construction.
- Validated `DUFFEL_ACCESS_TOKEN` validation, `DUFFEL_API_URL` parsing, base path normalization, and protocol rejection (non-http/https) in `duffel-core.module.spec.ts`.

#### T006: Budget Service & Atomic Cache Concurrency Tests
- Added concurrency and fail-closed tests in `duffel-rate-budget.service.spec.ts` and `cache.service.spec.ts`.
- Verified UTC midnight expiration, dual counter atomicity (global daily total + caller-specific limits), and Redis outage resilience.

#### T007: Atomic Check-and-Increment Operation
- Implemented `checkAndIncrWithLimits` in `apps/api/src/cache/cache.service.ts` using an atomic Lua script for Redis.
- Enforced fail-closed behavior when Redis is unavailable, returning a typed unavailable error.

#### T008: Singleton SDK Provider & DuffelCoreModule
- Implemented `duffelSdkProvider` providing `DUFFEL_SDK` in `apps/api/src/supplier/core/duffel-sdk.provider.ts`.
- Exported `DUFFEL_SDK` and `DuffelRateBudgetService` via `apps/api/src/supplier/core/duffel-core.module.ts`.

#### T009: Daily Rate Budget Reservation Service
- Implemented `DuffelRateBudgetService` with `reserveAttempt(extraConstraint?)`.
- Enforces daily UTC total cap of 1,500 attempts with optional caller constraints (e.g. user 1,000, agent 500).
- Emits typed errors with retry timestamp (next UTC midnight for quota exhaustion, bounded backoff for store outage).

#### T010: Route DuffelService Attempts Through Core Reservation
- Injected `DuffelRateBudgetService` into `DuffelService`.
- Routed raw flight search, live offer lookup, seat-map retrieval, priced offer fetch, order creation, order retrieval, cancellation quote, and order cancellation attempts through `reserveBudgetAttempt()`.
- Handled parallel seat-map/services and order retries with per-attempt metering.

#### T011: Migrate Disruption Reconciliation Off Monthly Budget
- Removed legacy monthly budget keys (`budget:duffel:${year}-${month}`) from `DuffelService` and `ReconciliationService`.
- Handled typed `RATE_LIMIT_EXCEEDED` errors in `ReconciliationService`, recording `budgetBlocked` metrics and deferring sync without decrement or double-charging.

#### T012: Wire DuffelCoreModule & Checkpoint Validation
- Imported and registered `DuffelCoreModule` in `apps/api/src/duffel/duffel.module.ts`.
- Typed `createCancellationQuote` with `DuffelCancellationQuote` ensuring type safety across consumer services.
- Ran the 6 core/duffel/flights/reconciliation test suites (133 tests passed).
- Confirmed clean TypeScript typecheck across backend API.
- Confirmed zero occurrences of obsolete monthly budget keys.

---

### Invariants Verification
- **Zero `any` in new code or test fixtures**: All newly created types and providers adhere to strict typing (`DuffelCancellationQuote`, `DuffelRateBudgetService`).
- **All Duffel attempts share daily budget**: Total daily attempts capped at 1,500 via atomic Redis Lua script; no monthly counter active.
- **Phase 2 Convergence**: Tasks T005 through T012 in `specs/029-duffel-provider-narrowing/tasks.md` are marked `[x]`. Phase 2 foundation is complete.

