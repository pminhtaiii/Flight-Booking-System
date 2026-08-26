# Booking Module Split Operational Runbook

This operational runbook governs the architecture deepening and modular extraction of the monolithic `BookingService` into three independent, cohesive submodules under `apps/api/src/`:
1. `BookingLifecycleModule` (`BookingLifecycleService` and `BookingRecoveryService`): Provider-blind lifecycle state transitions, pipeline outcomes, and background recovery.
2. `BookingManagementModule` (`BookingManagementService`): Owner read models, disruption summaries, and itinerary revision queries.
3. `CancellationModule` (`CancellationService`): Cancellation quotes, optimistic quote locking, supplier cancellations, and obligation generation.

The umbrella `BookingModule` (`apps/api/src/booking/booking.module.ts`) composes these three submodules with zero cyclic dependencies.

---

## 1. Preflight Checks & Prerequisites

### 1.1 Architectural Invariants
- **Zero Cyclic Dependencies**: There must be zero circular dependencies between the Booking domain and the Payment domain (`PaymentModule`).
- **Provider-Blind Lifecycle Core**: `BookingLifecycleService` manages pure database state transitions and does not call external provider APIs (Duffel or Stripe). Provider-specific reconciliation is isolated in `BookingRecoveryService`.
- **Tenant Query Isolation**: `BookingManagementService` must enforce strict owner filtering on every query (`where: { id: bookingId, userId }`), returning null/404 for unowned bookings.
- **Financial Boundary**: `CancellationService` never writes ledger entries, updates payment records, or performs terminal financial settlements. It creates `CancellationRefundObligation` records and delegates refund execution exclusively to `PaymentRefundService`.

### 1.2 Environment & Build Verification
Verify that the TypeScript build and NestJS dependency injection graph compile cleanly without unresolved tokens:

```powershell
docker compose up -d

Push-Location apps/api
pnpm run build
if ($LASTEXITCODE -ne 0) { throw 'API build failed.' }
Pop-Location
```

### 1.3 Independent Module Test Verification
Execute unit and characterization test suites for all three extracted services:

```powershell
Push-Location apps/api
& '.\node_modules\.bin\jest.CMD' --runInBand `
  src/booking-lifecycle/booking-lifecycle.service.spec.ts `
  src/booking-management/booking-management.service.spec.ts `
  src/cancellation/cancellation.service.spec.ts

& '.\node_modules\.bin\jest.CMD' --config ./test/jest-e2e.json --runInBand `
  test/booking.e2e-spec.ts `
  test/cancellation.e2e-spec.ts `
  test/characterization/booking-lifecycle.characterization.spec.ts
Pop-Location
```

Every test must pass with 0 failures before deployment.

---

## 2. Mismatch Abort Conditions & Safeguards

### 2.1 Static Import Cycle Guards
Run an automated circular dependency check across the backend codebase using `madge`:

```powershell
Push-Location apps/api
npx madge --circular --extensions ts ./src
if ($LASTEXITCODE -ne 0) { throw 'Circular dependency detected in API source.' }
Pop-Location
```

**Abort Trigger**: If any circular dependency is detected—especially between `BookingModule`, `BookingLifecycleModule`, `CancellationModule`, and `PaymentModule`—abort deployment immediately.

**Acyclic Verification Checklist**:
- `BookingLifecycleModule` imports: `PrismaModule`, `DuffelModule`, `AgentGatewayModule`. (Zero imports of `PaymentModule`).
- `BookingManagementModule` imports: `PrismaModule`. (Zero imports of `PaymentModule`).
- `CancellationModule` imports: `PrismaModule`, `DuffelModule`, `PaymentModule`, `AgentGatewayModule`.
- `PaymentModule` imports: `BookingLifecycleModule`, `RefundModule`, `RefundSettlementModule`. (Zero imports of `BookingModule` or `CancellationModule`).
- `BookingModule` imports: `BookingLifecycleModule`, `BookingManagementModule`, `CancellationModule`. (Zero exports of `BookingService`).

### 2.2 Transaction Boundary Safeguards
- `createBooking` executes inside an atomic database transaction (`prisma.$transaction`) with unique constraint on `bookingIntentId`.
- Duplicate intent submissions must converge idempotently on the existing booking without creating orphan rows.
- Stale status protection: An existing `CONFIRMED`, `CANCELLED`, or `COMPLETED` booking must NEVER be transitioned to `FAILED` by delayed asynchronous error handlers.

### 2.3 Fallback Recovery Triggers
- `BookingRecoveryService.reconcileStaleBookings()` runs as a scheduled cron sweep.
- It identifies bookings stuck in `PROCESSING` status for longer than 5 minutes (`createdAt < NOW() - 5m`).
- Reconciles state by inspecting Stripe PaymentIntent status and Duffel Order status:
  - If Stripe captured + Duffel order exists: Recover to `CONFIRMED`.
  - If Stripe cancelled / not captured: Recover to `FAILED` with reason `PROCESSING_TIMEOUT`.
- Emits structured audit log `booking_stale_recovered`.

---

## 3. Observability, Metrics & Alert Thresholds

### 3.1 Prometheus Metrics

| Metric Name | Type | Labels | Purpose |
|---|---|---|---|
| `booking_status_transitions_total` | Counter | `from_status`, `to_status` | Tracks all booking state machine transitions |
| `booking_stale_processing_count` | Gauge | — | Current count of bookings in `PROCESSING` > 5m |
| `cancellation_quote_duration_seconds` | Histogram | `outcome` | Latency of Duffel cancellation quote retrieval |
| `cancellation_execution_total` | Counter | `outcome`, `airline_code` | Completed supplier cancellations |
| `booking_read_duration_seconds` | Histogram | `view_type` (`list`, `detail`) | Management read query latency |

### 3.2 Alert Thresholds

| Alert | Condition | Severity | Action |
|---|---|---|---|
| StaleProcessingBookingAlert | `booking_stale_processing_count > 0` for 10m | P1 (Critical) | Inspect `BookingRecoveryService` sweep logs; verify Stripe/Duffel API status. |
| CancellationFailureSpike | `rate(cancellation_execution_total{outcome="FAILED"}[10m]) > 0.05` | P2 (High) | Verify Duffel API credentials and order cancellation quote validity. |
| BookingTransitionAnomaly | Transition from `CONFIRMED` to `FAILED` attempted | P1 (Critical) | Terminal state violation. Review transaction logs and freeze downstream mutations. |
| UnhandledCycleError | NestJS DI bootstrap error `Circular dependency` | P0 (Blocker) | Deployment fails container health check; roll back immediately. |

---

## 4. Observation Window Guidelines

### 4.1 Duration & Scope
- Monitor the split modules for **7 consecutive calendar days** post-deployment.
- Ensure that the observation window encompasses at least one high-volume booking traffic peak.

### 4.2 Daily Verification Checklist
1. Review `booking_status_transitions_total`: Confirm regular progression `PROCESSING -> CONFIRMED`.
2. Verify `booking_stale_processing_count` remains at 0 outside transient 1-2 minute creation spikes.
3. Confirm tenant isolation: Check application access logs for any 403/404 cross-account access attempts.
4. Verify `CancellationRefundObligation` records created by `CancellationService` contain integer minor units (`totalAmount`, `airlineRefundAmount`) matching quote amounts.

---

## 5. Rollback Procedures & Exact Commit Boundaries

### 5.1 Exact Commit Boundaries
- **Module Split Implementation**: Commit `5daec2f` (`feat(cancellation): extract CancellationModule and rewire BookingController (Slice 2C Batch 1)`).

### 5.2 Zero Schema Impact
The booking module split is a pure software architectural refactoring. It introduces **zero database schema migrations** and alters no table columns or constraints. Rollback is strictly an application container deployment.

### 5.3 Rollback Procedure
If unexpected dependency injection errors, routing failures, or transaction regressions occur in production:
1. Re-deploy the application container from the commit immediately preceding `5daec2f`.
2. Verify container startup and check that the monolithic `BookingService` initializes cleanly.
3. Re-run API E2E tests:
   ```powershell
   Push-Location apps/api
   & '.\node_modules\.bin\jest.CMD' --config ./test/jest-e2e.json --runInBand test/booking.e2e-spec.ts
   Pop-Location
   ```
4. Confirm health check returns `HTTP 200 OK`.

---

## 6. Post-Rollout Cleanup Eligibility

### 6.1 Deprecation & Deletion Milestones
1. **Transitional Delegation Methods**: Any compatibility forwarders remaining in `BookingService` (e.g. methods that delegate to `BookingManagementService` or `CancellationService`) are marked `@deprecated`.
2. **Eligibility for Final Deletion**:
   - 7-day observation window completed with zero P1/P2 incidents.
   - Monorepo grep confirms 0 external consumers import `BookingService` directly.
   - All tests and controllers inject `BookingLifecycleService`, `BookingManagementService`, or `CancellationService` directly.
3. **Decommissioning**: Remove unused `BookingService` provider entirely from `BookingModule` and delete obsolete legacy spec files.
