# Feature 012 Tasks & GitHub Issue/PR Mapping

Tracking map for the Cancellation & Refund Management feature implementation across 6 sequential PRs / GitHub issues.

## PR / Issue Dependency Pipeline

```
#67 / PR 0 (012a-cancellation-refund-specs) Specs & Documentation [PR #68]
  │
  ▼
#62 / PR 1 (012b-schema-and-quote-api) Schema & Quote API
  │
  ▼
#63 / PR 2 (012c-cancellation-transaction) Supplier Cancellation & Inline Refund
  ├──▶ #64 / PR 3 (012d-refund-recovery-worker) Recovery Worker & Admin Escalation ──┐
  │                                                                                 ├──▶ #66 / PR 5 (012f-e2e-test-suite) E2E Tests
  └──▶ #65 / PR 4 (012e-frontend-cancellation-ux) Frontend Experience & Time-Aware UX ─┘
```

---

## Issue & PR Registry

| PR       | Branch Name                      | Title                                                             | Issue Link                                                           | PR Link                                                            | Blocked By | Status   |
| -------- | -------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------- | -------- |
| **PR 0** | `012a-cancellation-refund-specs` | Documentation & Design Specs for Cancellation & Refund Management | [#67](https://github.com/pminhtaiii/Flight-Booking-System/issues/67) | [#68](https://github.com/pminhtaiii/Flight-Booking-System/pull/68) | None       | Complete |
| **PR 1** | `012b-schema-and-quote-api`      | Schema Migration & Cancellation Quote API                         | [#62](https://github.com/pminhtaiii/Flight-Booking-System/issues/62) | Pending                                                            | #67        | Complete |
| **PR 2** | `012c-cancellation-transaction`  | Supplier-First Cancellation & Inline Refund Transaction           | [#63](https://github.com/pminhtaiii/Flight-Booking-System/issues/63) | Pending                                                            | #62        | Complete |
| **PR 3** | `012d-refund-recovery-worker`    | Background Refund Recovery Worker & Admin Escalation              | [#64](https://github.com/pminhtaiii/Flight-Booking-System/issues/64) | Pending                                                            | #63        | Complete |
| **PR 4** | `012e-frontend-cancellation-ux`  | Frontend Cancellation Experience & Time-Aware UX                  | [#65](https://github.com/pminhtaiii/Flight-Booking-System/issues/65) | Pending                                                            | #63        | Complete |
| **PR 5** | `012f-e2e-test-suite`            | End-to-End Verification & Test Suite                              | [#66](https://github.com/pminhtaiii/Flight-Booking-System/issues/66) | Pending                                                            | #64, #65   | Complete |

---

## PR Detailed Specifications

### [PR 0 / Issue #67 / PR #68] Documentation & Design Specs

- **Branch**: `012a-cancellation-refund-specs`
- **Target Branch**: `development`
- **Scope**:
  - `CONTEXT.md` glossary additions (`Cancellation Pending`, `Cancellation Deadline`).
  - `docs/adr/0001-cancellation-and-refund-failure-handling.md` & relocated research ADRs.
  - `specs/012-cancellation-refund-recovery/` (`PRD.md`, `plan.md`, `data-model.md`, `contracts/api.md`, `quickstart.md`, `tasks.md`).

### [PR 1 / Issue #62] Schema Migration & Cancellation Quote API

- **Branch**: `012b-schema-and-quote-api`
- **Target Branch**: `development`
- **Scope**:
  - `BookingStatus` (`CANCELLATION_PENDING`, `CANCELLED_PENDING_REFUND`, `CANCELLED_AND_REFUNDED`, `CANCELLED_NO_REFUND`).
  - `RefundStatus` (`REFUND_PROCESSING`, `REFUND_RETRY_SCHEDULED`, `REFUND_FAILED_NEEDS_ATTENTION`).
  - `cancellationDeadline`, `cancellationRefundable` on `Booking`.
  - `airlineRefundAmount`, `customerRefundAmount` on `Refund`.
  - `POST /api/bookings/:bookingId/cancellation-quote` endpoint.

### [PR 2 / Issue #63] Supplier-First Cancellation & Inline Refund Transaction

- **Branch**: `012c-cancellation-transaction`
- **Scope**:
  - `POST /api/bookings/:bookingId/cancel` endpoint using CAS update (`UPDATE ... WHERE status = 'CONFIRMED' OR (status = 'CANCELLATION_PENDING' AND updatedAt < NOW() - INTERVAL '2 minutes')`).
  - Remote-first Duffel crash recovery check (queries Duffel order state before attempting quote creation/confirmation to safely resolve crashed or retried `CANCELLATION_PENDING` attempts).
  - Layer 1 inline Stripe retries (1s, 3s, 5s).
  - Atomic `finalizeRefundSuccess()` transaction for `Refund`, `Payment`, `Booking`, and reverse ledger.

### [PR 3 / Issue #64] Background Refund Recovery Worker & Admin Escalation

- **Branch**: `012d-refund-recovery-worker`
- **Scope**:
  - Layer 2 `@Cron('*/1 * * * *')` worker in `PaymentCronService`.
  - Stripe Error Classification Gate (transient vs deterministic).
  - 22-hour idempotency key safety rail forcing escalation to `REFUND_FAILED_NEEDS_ATTENTION`.
  - `POST /api/admin/refunds/:refundId/resolve` endpoint.

### [PR 4 / Issue #65] Frontend Cancellation Experience & Time-Aware UX

- **Branch**: `012e-frontend-cancellation-ux`
- **Scope**:
  - "Cancel Booking" button on `BookingDetail.tsx` gated by `cancellationDeadline > NOW()`.
  - Cancellation confirmation modal showing quote breakdown.
  - State rendering: `CANCELLED_PENDING_REFUND`, `CANCELLED_AND_REFUNDED`, `CANCELLED_NO_REFUND`.
  - 48-hour time-aware support escalation message.

### [PR 5 / Issue #66] End-to-End Verification & Test Suite

- **Branch**: `012f-e2e-test-suite`
- **Scope**:
  - `apps/api/test/cancellation.e2e-spec.ts` (CAS concurrency, Duffel timeouts, Stripe transient blips, worker recovery, 22h stale keys).
  - `apps/web/tests/cancellation.spec.ts` (Playwright modal & status rendering).
