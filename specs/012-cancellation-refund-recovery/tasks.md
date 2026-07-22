# Feature 012 Tasks & GitHub Issue Mapping

Tracking map for the Cancellation & Refund Management feature implementation across 6 sequential PRs / GitHub issues.

## PR / Issue Dependency Pipeline

```
#67 [PR 0] Specs & Documentation
  │
  ▼
#62 [PR 1] Schema & Quote API
  │
  ▼
#63 [PR 2] Supplier Cancellation & Inline Refund
  ├──▶ #64 [PR 3] Recovery Worker & Admin Escalation ──┐
  │                                                   ├──▶ #66 [PR 5] E2E Tests
  └──▶ #65 [PR 4] Frontend Experience & Time-Aware UX ─┘
```

---

## Issue Registry

| PR / Issue | Title | Status | GitHub Link | Blocked By |
|---|---|---|---|---|
| **PR 0** | Documentation & Design Specs for Cancellation & Refund Management | Open | [#67](https://github.com/pminhtaiii/Flight-Booking-System/issues/67) | None |
| **PR 1** | Schema Migration & Cancellation Quote API | Open | [#62](https://github.com/pminhtaiii/Flight-Booking-System/issues/62) | #67 |
| **PR 2** | Supplier-First Cancellation & Inline Refund Transaction | Open | [#63](https://github.com/pminhtaiii/Flight-Booking-System/issues/63) | #62 |
| **PR 3** | Background Refund Recovery Worker & Admin Escalation | Open | [#64](https://github.com/pminhtaiii/Flight-Booking-System/issues/64) | #63 |
| **PR 4** | Frontend Cancellation Experience & Time-Aware UX | Open | [#65](https://github.com/pminhtaiii/Flight-Booking-System/issues/65) | #63 |
| **PR 5** | End-to-End Verification & Test Suite | Open | [#66](https://github.com/pminhtaiii/Flight-Booking-System/issues/66) | #64, #65 |

---

## PR Specifications

### [PR 0 / Issue #67] Documentation & Design Specs for Cancellation & Refund Management
- **Branch**: `docs/012-cancellation-refund-specs`
- **Target Branch**: `development`
- **Scope**:
  - Update `CONTEXT.md` with domain glossary terms: `Cancellation`, `Cancellation Pending`, `Refund Pending`, `Refund Escalation`, `Cancellation Deadline`.
  - Update `docs/adr/0001-cancellation-and-refund-failure-handling.md` and relocated research docs in `docs/adr/`.
  - Add `specs/012-cancellation-refund-recovery/` design specifications (`PRD.md`, `plan.md`, `data-model.md`, `contracts/api.md`, `quickstart.md`, `tasks.md`).

### [PR 1 / Issue #62] Schema Migration & Cancellation Quote API
- **Target Branch**: `development`
- **Scope**:
  - Update `BookingStatus` and `RefundStatus` enums in `apps/api/prisma/schema.prisma`.
  - Add `cancellationDeadline`, `cancellationRefundable`, `airlineRefundAmount`, `customerRefundAmount` fields.
  - Implement `POST /api/bookings/:bookingId/cancellation-quote` calling `duffel.orderCancellations.create`.

### [PR 2 / Issue #63] Supplier-First Cancellation & Inline Refund Transaction
- **Scope**:
  - `POST /api/bookings/:bookingId/cancel` endpoint using CAS update (`UPDATE ... WHERE status = 'CONFIRMED'`).
  - Remote-first Duffel crash recovery check.
  - Layer 1 inline Stripe retries (1s, 3s, 5s).
  - Atomic `finalizeRefundSuccess()` transaction for `Refund`, `Payment`, `Booking`, and reverse ledger.

### [PR 3 / Issue #64] Background Refund Recovery Worker & Admin Escalation
- **Scope**:
  - Layer 2 `@Cron('*/1 * * * *')` worker in `PaymentCronService`.
  - Stripe Error Classification Gate (transient vs deterministic).
  - 22-hour idempotency key safety rail forcing escalation to `REFUND_FAILED_NEEDS_ATTENTION`.
  - `POST /api/admin/refunds/:refundId/resolve` endpoint.

### [PR 4 / Issue #65] Frontend Cancellation Experience & Time-Aware UX
- **Scope**:
  - "Cancel Booking" button on `BookingDetail.tsx` gated by `cancellationDeadline > NOW()`.
  - Cancellation confirmation modal showing quote breakdown.
  - State rendering: `CANCELLED_PENDING_REFUND`, `CANCELLED_AND_REFUNDED`, `CANCELLED_NO_REFUND`.
  - 48-hour time-aware support escalation message.

### [PR 5 / Issue #66] End-to-End Verification & Test Suite
- **Scope**:
  - `apps/api/test/cancellation.e2e-spec.ts` (CAS concurrency, Duffel timeouts, Stripe transient blips, worker recovery, 22h stale keys).
  - `apps/web/tests/cancellation.spec.ts` (Playwright modal & status rendering).
