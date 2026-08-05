# Research: Stripe Payment System

**Feature**: 010-stripe-payment-system | **Date**: 2026-07-12

All research questions were resolved during the grilling session. Full decisions documented in [research/payment-system-decisions.md](../../research/payment-system-decisions.md).

---

## R1: Stripe Integration Mode

**Decision**: Direct charges. Platform is merchant of record.
**Rationale**: No third-party sellers or partners exist. Duffel costs are internal accounting.
**Alternatives considered**: Stripe Connect (destination charges, separate charges and transfers) — rejected due to unnecessary complexity.

## R2: Payment Lifecycle Model

**Decision**: 11-state finite state machine with enforced transitions.
**Rationale**: Covers all payment, refund, and dispute scenarios with clear terminal states and recovery paths.
**Key design**: FAILED is terminal (new PaymentIntent required). Dispute resolution returns to pre-dispute state. PARTIALLY_REFUNDED can loop back to REFUND_PENDING.
**Alternatives considered**: Simpler 6-state model — rejected because it collapsed authorization/capture and had no dispute resolution paths.

## R3: Authorize-Then-Capture Pattern

**Decision**: Separate authorization and capture with tiered timeout escalation.
**Rationale**: Prevents charging customers for failed Duffel bookings. The 4-tier escalation (30s sync → 1min async → 15min admin → 60-90min expire) balances customer experience with investigation time.
**Alternatives considered**: Single-step charge (no auth-capture split) — rejected because Duffel failures would leave customers charged with no ticket.

## R4: Concurrency Control

**Decision**: Hybrid pessimistic claim (milliseconds, DB-level) + optimistic version checks (all external calls).
**Rationale**: Short pessimistic lock claims the pipeline without holding locks across network calls. Optimistic checks detect mid-pipeline conflicts.
**Alternatives considered**: Redis distributed locks — rejected because PostgreSQL handles coordination within the same boundary. Pure pessimistic (long-held locks) — rejected because it would block across Stripe/Duffel calls.

## R5: Webhook Processing Strategy

**Decision**: Two-tier handling. Tier 1: self-healing reconciliation for out-of-order events. Tier 2: alert + drop for irreconcilable transitions.
**Rationale**: Not all invalid transitions are errors — some are timing issues. Self-healing via Stripe API verification avoids false alerts.
**Alternatives considered**: Blanket alert + drop — rejected because it would generate noise for recoverable ordering issues. Dead-letter queue — rejected as over-engineered for current scale.

## R6: Refund Architecture

**Decision**: Dual triggers (SYSTEM_AUTOMATED + ADMIN). Every automated refund gets its own idempotency key.
**Rationale**: Automated refunds for detectable errors (duplicate charges). Admin refunds for ambiguous cases. Idempotency prevents refund duplication.
**Alternatives considered**: Admin-only — rejected because some errors (duplicate charges) must be refunded immediately without human delay.

## R7: Idempotency and Recovery

**Decision**: `idempotency_keys` table with `recovery_point` column for pipeline checkpoint tracking.
**Rationale**: Enables crash recovery at any pipeline step. `recovery_point` is the internal resumption cursor; `payments.status` is the external business state. They move together at different granularities.
**Alternatives considered**: Stateless retry (re-run entire pipeline) — rejected because it could double-charge or double-create PNRs.

## R8: Double-Entry Ledger

**Decision**: 3-account ledger for v1 (CUSTOMER_RECEIVABLE, PLATFORM_REVENUE, DUFFEL_COST).
**Rationale**: Self-balancing audit trail. Debits always equal credits per transaction_id.
**Deferred**: STRIPE_FEES (visible on dashboard), REFUND_LIABILITY (captured by refunds.status).

## R9: Saved Payment Methods

**Decision**: Lazy Stripe Customer creation at first payment. Explicit checkbox opt-in for card saving.
**Rationale**: Avoids polluting Stripe with non-paying users. Customer creation is idempotent and synchronous before PaymentIntent creation so `setup_future_usage` works from the start.
