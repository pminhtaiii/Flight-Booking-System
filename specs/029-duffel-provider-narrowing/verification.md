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
- Characterized upstream 404/410 expired offer behavior, database row purge, and recovery metadata in `duffel.service.spec.ts` and `flights.service.spec.ts`.

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
  - Updated and characterized all 8 flight detail test scenarios (successful retrieval, price drift detection, 404 purge, 410 purge, purge failure resilience, upstream 500 error mapping, DuffelTimeoutError translation without DB purge) to mock and assert `duffelService.getOfferById`.
- Verified zero instances of private SDK bracket access remain in `apps/api/src`.
- Confirmed full clean build and typecheck with zero compiler warnings or errors.

---

### Invariants Verification
- **Zero `any` in new code or test fixtures**: All added/modified code uses strictly typed or unknown records (`Record<string, unknown>`, typed jest mocks).
- **No functional regressions**: All 260 characterization tests passed without changes to public interfaces or business behaviors.
- **Phase 1 Convergence**: Tasks T001, T002, T003, and T004 in `specs/029-duffel-provider-narrowing/tasks.md` are marked `[x]`.
