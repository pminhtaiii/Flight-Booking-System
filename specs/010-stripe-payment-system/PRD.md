# PRD: Stripe Payment System (Feature B)

## Problem Statement

The Flight Booking System needs a robust and deterministic mechanism to process customer payments for flight bookings. We must ensure that customers are only charged when a flight is successfully booked on Duffel, that duplicate charges are strictly prevented, and that all financial state transitions (including holds, captures, refunds, and disputes) are strictly tracked in an auditable double-entry ledger. Furthermore, because network calls and webhooks are asynchronous and can fail or arrive out of order, the system requires self-healing capabilities and a background reconciliation process to prevent funds from being held indefinitely or states from silently drifting.

## Solution

Implement a Stripe-based payment system utilizing an Authorize-then-Capture flow. The system will hold funds upon user payment, and only capture them after a confirmed PNR creation via Duffel. This will be backed by a strictly enforced 11-state finite state machine, robust webhook handling (with self-healing and alert tiers), idempotent operations with recovery points for crash resilience, and a background reconciliation service for auto-expiring authorizations and detecting anomalies. A double-entry ledger will track all financial movements.

## User Stories

1. As a customer, I want to securely enter my payment details and pay for my selected flight, so that my flight is booked.
2. As a customer, I want to be notified if my payment fails, so that I can try a different payment method (up to 2 attempts total).
3. As a customer, I want my payment authorization to be voided if the flight booking fails, so that I am not charged for a flight I didn't get.
4. As a customer, I want to optionally save my payment method during checkout, so that I can reuse it for future bookings without re-entering details.
5. As a customer, I want to automatically receive a refund if a system error occurs (like a duplicate charge), so that my money is safe.
6. As a business operator, I want to ensure that webhook events from Stripe act as the source of truth, so that our database payment state accurately reflects reality.
7. As a business operator, I want out-of-order webhooks to self-heal via the Stripe API, so that we don't get false alerts or inconsistent state.
8. As a business operator, I want unexplainable webhook transitions to trigger an alert and drop, so that data corruption is avoided.
9. As a business operator, I want a background reconciliation process to sweep for stuck authorizations (e.g., 60-90 minutes) and auto-expire them, so that customer funds are not held indefinitely.
10. As a business operator, I want the reconciliation sweep to proactively verify payments that never received a resolving webhook, so that our state doesn't silently drift.
11. As an accountant, I want every payment and refund (excluding Stripe processing fees, which are deferred to v2) to be recorded in a double-entry ledger (Debits = Credits), so that financial records are strictly auditable.
12. As a system administrator, I want to track the pipeline via idempotency keys and recovery points, so that if the system crashes mid-pipeline, it safely resumes from the exact checkpoint.
13. As an admin, I want to be able to manually trigger a refund for a specific payment, so that I can handle customer support requests.
14. As a business operator, I want chargebacks (disputes) to be fully tracked and to return to the pre-dispute state if won, or transition to CHARGEBACK_LOST if lost, so that accounting remains accurate.

## Implementation Decisions

- Direct charges via Stripe (Platform is the merchant of record).
- Authorize-Then-Capture pattern to protect against Duffel booking failures.
- 11-state finite state machine (`CREATED`, `AUTHORIZED`, `SUCCEEDED`, `FAILED`, `EXPIRED`, `CANCELLED`, `REFUND_PENDING`, `PARTIALLY_REFUNDED`, `REFUNDED`, `DISPUTED`, `CHARGEBACK_LOST`) enforced strictly.
- Maximum of 2 payment attempts per BookingIntent. `FAILED` is a terminal state; retries spawn new PaymentIntents.
- Concurrency: Hybrid pessimistic claim (milliseconds lock on BookingIntent) + optimistic version checking across all external API calls.
- Source of Truth: Stripe webhooks, handling Tier 1 (self-healing out-of-order) and Tier 2 (alert+drop irreconcilable).
- Saved Methods: Stripe Customer created lazily before first payment; `setup_future_usage: 'off_session'` used when user opts in.
- Idempotency & Recovery: Idempotency keys track `recovery_point` to resume crashed pipelines (`started` -> `stripe_authorized` -> `duffel_order_created` -> `captured` -> `completed`).
- Background Reconciliation: Cron job auto-expires stuck authorizations, detects slipped double captures, issues auto-refunds with unique idempotency keys, and proactively checks incomplete payments.
- Double-Entry Ledger: 3-account setup for v1 (`CUSTOMER_RECEIVABLE`, `PLATFORM_REVENUE`, `DUFFEL_COST`).
- Schema additions: `Payment`, `IdempotencyKey`, `PaymentEvent` (immutable audit log), `LedgerEntry`, `Refund`, `PaymentMethod`.

## Testing Decisions

Good tests will test external behavior and end-to-end flows across defined seams without testing implementation details like private helper functions.

The system will be tested across four primary seams:

- **Seam 1: `PaymentService`**: Primary orchestrator seam. Tests cover the pipeline execution (create -> authorize -> Duffel PNR -> capture), state machine enforcement, optimistic versioning, and idempotency recovery points. External calls (Stripe/Duffel SDKs) are mocked here.
- **Seam 2: `PaymentWebhookService`**: Boundary between inbound Stripe webhooks and the FSM. Tests cover deduplication, Tier 1 self-healing, Tier 2 alert/drop, and dispute lifecycles.
- **Seam 3: `PaymentRefundService`**: Covers the dual-trigger refund logic (automated + admin) and partial refund loops.
- **Seam 4: `PaymentReconciliationService` (Background Sweep)**: Tests cover the timer-based load-bearing logic outside the request/response cycle. Verifies auto-expiry of stuck authorizations (60-90m sweep), detecting and auto-refunding duplicate captures, and proactive Stripe API checks for payments lacking resolving webhooks.

## Out of Scope

- Stripe Connect (marketplace splits).
- P&L reporting accounts in the ledger (like `STRIPE_FEES` and `REFUND_LIABILITY` - deferred to later).
- Email notifications for async booking confirmations (handled by a future notification service).
- Frontend payment UI components (covered in a separate frontend feature).

## Further Notes

- Tiered timeout escalation for Authorize-to-Capture: 0-30s (sync) -> 30s-1m (async handoff) -> 15m (admin alert) -> 30m-1h (auto-expire).
- Automated refunds must have the `requires_review` flag set to true for a 24h human check.
