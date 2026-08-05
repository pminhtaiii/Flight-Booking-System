# Feature Specification: Stripe Payment System

**Feature Branch**: `010-stripe-payment-system`

**Created**: 2026-07-12

**Status**: Draft

**Input**: Grilling session decisions from [research/payment-system-decisions.md](../../research/payment-system-decisions.md)

> **Context**: Feature A (Booking Intent Foundation — spec 009) created the `BookingIntent` data model and pipeline. This feature (Feature B) adds Stripe payment processing with authorize-then-capture, a finite state machine lifecycle, webhook processing, saved payment methods, a refund system, double-entry ledger, and recovery point idempotency.

## User Scenarios & Testing

### User Story 1 - One-Time Payment for Flight Booking (Priority: P1)

A customer with a `BookingIntent` in `AWAITING_PAYMENT` state submits their card details to pay for a flight. The system authorizes the card, confirms the booking with Duffel, captures the payment, and transitions the booking to `CONFIRMED`.

**Why this priority**: This is the core revenue-generating flow. Without it, no bookings generate income.

**Independent Test**: Can be fully tested by creating a BookingIntent, submitting payment via Stripe test mode, and verifying the booking transitions to CONFIRMED with a valid PNR.

**Acceptance Scenarios**:

1. **Given** a BookingIntent in AWAITING_PAYMENT state, **When** the customer submits valid card details, **Then** the system creates a Stripe PaymentIntent, authorizes the card, calls Duffel to create PNR, captures the payment, and transitions the BookingIntent to CONFIRMED.
2. **Given** a BookingIntent in AWAITING_PAYMENT state, **When** the card authorization fails (declined), **Then** the Payment is marked FAILED (terminal), the BookingIntent remains in AWAITING_PAYMENT, and the customer is told they can try again.
3. **Given** a BookingIntent in AWAITING_PAYMENT state, **When** authorization succeeds but Duffel PNR creation fails, **Then** the authorization is voided, the customer's card is released, no charge occurs, and the Payment is marked CANCELLED.
4. **Given** a successful authorization, **When** Duffel does not respond within 30 seconds, **Then** the system transitions to async mode ("Confirming your flight…"), continues retrying in background, and applies the tiered escalation ladder (Tier 2 at 30s-1min, Tier 3 admin alert at 15min, Tier 4 auto-expire at 30min-1hr).

---

### User Story 2 - Webhook-Driven Payment Status Updates (Priority: P1)

Stripe webhooks arrive and update payment status. The system processes them idempotently, handles duplicates and out-of-order delivery, and uses the webhook as the source of truth.

**Why this priority**: Without webhook processing, payment status cannot be reliably confirmed. Tied for P1 with the payment flow itself.

**Independent Test**: Can be tested by sending mock Stripe webhook events to the webhook endpoint and verifying state transitions, deduplication, and self-healing reconciliation.

**Acceptance Scenarios**:

1. **Given** a Payment in AUTHORIZED state, **When** a `payment_intent.succeeded` webhook arrives, **Then** the Payment transitions to SUCCEEDED and a PaymentEvent audit row is appended.
2. **Given** a webhook with an event ID that already exists in `payment_events.stripe_event_id`, **When** the webhook is processed, **Then** the system returns 200 and skips processing (idempotent).
3. **Given** a Payment in CREATED state, **When** a `payment_intent.succeeded` webhook arrives (skipping AUTHORIZED — out-of-order), **Then** the system calls Stripe's PaymentIntent.retrieve() to verify, fast-forwards the DB state to SUCCEEDED, and logs the self-healing reconciliation (Tier 1).
4. **Given** a Payment in REFUNDED state, **When** a `payment_intent.succeeded` webhook arrives (irreconcilable), **Then** the system logs the event payload, alerts the admin, returns 200, and does NOT change the payment state (Tier 2).

---

### User Story 3 - Retry Payment (Second Attempt) (Priority: P2)

A customer whose first payment attempt failed can retry with a new payment attempt (new Stripe PaymentIntent) against the same BookingIntent, up to a maximum of 2 attempts total.

**Why this priority**: Directly impacts conversion rate — customers with transient card failures should get a second chance.

**Independent Test**: Can be tested by forcing a first payment to fail, then submitting a second payment and verifying it processes correctly. Also test that a third attempt is blocked.

**Acceptance Scenarios**:

1. **Given** a BookingIntent with `payment_attempt_count = 1` and a FAILED Payment, **When** the customer submits a new payment, **Then** a new Payment row (attempt_number = 2) is created with a new Stripe PaymentIntent.
2. **Given** a BookingIntent with `payment_attempt_count = 2` and both Payments FAILED, **When** the customer attempts another payment, **Then** the system rejects the request, the BookingIntent transitions to PAYMENT_EXHAUSTED, and the customer is told to start a new booking.
3. **Given** a BookingIntent, **When** two concurrent payment requests arrive for the same intent, **Then** only one succeeds in claiming the pipeline (pessimistic lock). The other receives a conflict error.

---

### User Story 4 - Save Payment Method for Reuse (Priority: P2)

A customer opts in to save their card details during payment. On future bookings, they can select a saved card instead of re-entering details.

**Why this priority**: Reduces checkout friction for repeat customers.

**Independent Test**: Can be tested by completing a payment with the "save card" checkbox enabled, then verifying the payment method appears in the customer's saved methods for a subsequent booking.

**Acceptance Scenarios**:

1. **Given** a customer with no Stripe Customer ID, **When** they submit their first payment, **Then** a Stripe Customer is created synchronously (with idempotency key `customer-create:{userId}`), saved to `User.stripeCustomerId`, and the PaymentIntent is created with `customer` and `setup_future_usage: 'off_session'`.
2. **Given** a customer with the "save card" checkbox unchecked, **When** they pay, **Then** no `setup_future_usage` is set and the card is not saved.
3. **Given** a customer with saved payment methods, **When** they start a new booking, **Then** the system returns their saved methods (card_brand, card_last4, is_default) for selection.
4. **Given** a retry of the Stripe Customer creation call (same idempotency key), **When** the retry executes, **Then** no duplicate Stripe Customer is created.

---

### User Story 5 - System-Error Refund (Priority: P2)

When the system detects a correctness error (e.g., duplicate charge, failed capture after authorization), it automatically initiates a refund. Admins can also manually trigger refunds for ambiguous cases.

**Why this priority**: Prevents financial loss for customers due to system errors. Critical for trust.

**Independent Test**: Can be tested by simulating a duplicate charge scenario and verifying the automated refund fires with its own idempotency key. Admin refunds can be tested via the admin-triggered endpoint.

**Acceptance Scenarios**:

1. **Given** a Payment that succeeded, **When** an admin triggers a full refund, **Then** a Refund record is created with `trigger_type = ADMIN`, the Payment transitions to REFUND_PENDING, and upon Stripe confirmation transitions to REFUNDED.
2. **Given** a system-detected duplicate charge, **When** the automated refund fires, **Then** a Refund is created with `trigger_type = SYSTEM_AUTOMATED`, `requires_review = true`, and a unique idempotency key `refund:{paymentId}:{reason}:{occurrence}`.
3. **Given** a Payment in SUCCEEDED state, **When** a partial refund of $100 out of $500 is confirmed, **Then** the Payment transitions to PARTIALLY_REFUNDED. A subsequent refund of the remaining $400 transitions it to REFUNDED.
4. **Given** an automated refund idempotency key that already exists, **When** the same automated refund triggers again, **Then** no duplicate refund is created.

---

### User Story 6 - Dispute Handling (Priority: P3)

When a customer's bank opens a chargeback/dispute, the system tracks it through resolution. The payment returns to its pre-dispute state if the platform wins, or transitions to CHARGEBACK_LOST if the platform loses.

**Why this priority**: Disputes are less frequent but must be handled correctly when they occur.

**Independent Test**: Can be tested by sending mock `charge.dispute.created` and `charge.dispute.closed` webhook events and verifying state transitions.

**Acceptance Scenarios**:

1. **Given** a Payment in SUCCEEDED state, **When** a `charge.dispute.created` webhook arrives, **Then** the Payment transitions to DISPUTED and `pre_dispute_status` is set to SUCCEEDED.
2. **Given** a Payment in DISPUTED state with `pre_dispute_status = SUCCEEDED`, **When** a `charge.dispute.closed` webhook with outcome "won" arrives, **Then** the Payment returns to SUCCEEDED.
3. **Given** a Payment in DISPUTED state, **When** a `charge.dispute.closed` webhook with outcome "lost" arrives, **Then** the Payment transitions to CHARGEBACK_LOST.
4. **Given** a Payment in REFUNDED state, **When** a dispute is opened and subsequently won, **Then** the Payment returns to REFUNDED (not SUCCEEDED — the refund already happened).

---

### User Story 7 - Idempotent Pipeline Execution with Recovery Points (Priority: P3)

Every payment pipeline execution is tracked via an idempotency key with recovery points. If the system crashes mid-pipeline, a retry resumes from the last checkpoint instead of restarting.

**Why this priority**: Critical for reliability but is infrastructure — the customer doesn't directly interact with it.

**Independent Test**: Can be tested by simulating a crash after Stripe authorization (recovery_point = stripe_authorized), retrying the same idempotency key, and verifying the pipeline resumes from Duffel PNR creation (not re-authorizing).

**Acceptance Scenarios**:

1. **Given** a pipeline that crashes after Stripe authorization, **When** the same request is retried with the same idempotency key, **Then** the system reads `recovery_point = stripe_authorized` and resumes from the Duffel PNR creation step.
2. **Given** a completed pipeline, **When** the same idempotency key is resubmitted, **Then** the system returns the cached `response_body` without re-executing any steps.
3. **Given** an idempotency key resubmitted with a different `request_hash`, **When** the system processes it, **Then** it rejects the request with a 422 (key reused with different payload).
4. **Given** a pipeline that crashes after Duffel order creation but before capture, **When** retried, **Then** the system reads `recovery_point = duffel_order_created` and proceeds directly to Stripe capture.

---

### User Story 8 - Double-Entry Ledger Tracking (Priority: P3)

Every financial event produces paired debit/credit ledger entries for auditability and reconciliation.

**Why this priority**: Critical for financial integrity but operates behind the scenes.

**Independent Test**: Can be tested by completing a payment and verifying that balanced debit/credit entries exist in the ledger for CUSTOMER_RECEIVABLE and PLATFORM_REVENUE, and that a refund produces reversing entries.

**Acceptance Scenarios**:

1. **Given** a successful $500 payment capture, **When** ledger entries are created, **Then** two rows exist: DEBIT CUSTOMER_RECEIVABLE $500, CREDIT PLATFORM_REVENUE $500, grouped by the same `transaction_id`.
2. **Given** a $500 refund, **When** ledger entries are created, **Then** two reversing rows exist: DEBIT PLATFORM_REVENUE $500, CREDIT CUSTOMER_RECEIVABLE $500.
3. **Given** any `transaction_id`, **When** summing all entries, **Then** total debits equal total credits (invariant).

---

### Edge Cases

- What happens when Stripe authorization succeeds but the system crashes before writing the AUTHORIZED state to the database? → Recovery point + Stripe PaymentIntent.retrieve() reconciliation.
- What happens when two users try to book the same flight/seat simultaneously? → Both get AUTHORIZED, but only the first to succeed at Duffel gets CAPTURED. The other's authorization is voided.
- What happens when a webhook arrives for a payment that doesn't exist in the database yet? → Quarantine and alert the event. Require verified Stripe-to-local booking and idempotency mapping before reconciliation or record creation (self-healing applies only to events with trusted ownership and intent context).
- What happens when the cron expires an AUTHORIZED payment at the exact moment a successful Duffel response arrives? → Optimistic version check catches the conflict; the Duffel success path fails to update (version mismatch), triggering investigation.
- What happens when an automated refund detects the same error twice? → Idempotency key prevents duplicate refund.

## Requirements

### Functional Requirements

- **FR-001**: System MUST process one-time payments via Stripe Payment Intents with authorize-then-capture flow.
- **FR-002**: System MUST enforce a finite state machine with exactly 11 states and only the transitions defined in Decision 2 of the grilling decisions.
- **FR-003**: System MUST allow a maximum of 2 payment attempts per BookingIntent, enforced by `payment_attempt_count` check at pipeline entry.
- **FR-004**: System MUST save payment methods for reuse when the customer explicitly opts in via checkbox, using Stripe's `setup_future_usage: 'off_session'`.
- **FR-005**: System MUST create the Stripe Customer object synchronously before the first PaymentIntent, with an idempotency key to prevent duplicates.
- **FR-006**: System MUST process Stripe webhooks as the source of truth for payment status, with event ID deduplication via unique index on `payment_events.stripe_event_id`.
- **FR-007**: System MUST handle out-of-order webhooks with two-tier logic: Tier 1 (self-healing reconciliation via Stripe API) and Tier 2 (alert + drop for irreconcilable transitions).
- **FR-008**: System MUST support refunds with dual triggers: `SYSTEM_AUTOMATED` (with idempotency keys and `requires_review` flag) and `ADMIN` (manually triggered).
- **FR-009**: System MUST support partial refunds with the `PARTIALLY_REFUNDED → REFUND_PENDING` loop, eventually closing to `REFUNDED`.
- **FR-010**: System MUST track dispute lifecycle: `DISPUTED → pre-dispute state (won)` or `DISPUTED → CHARGEBACK_LOST (lost)`.
- **FR-011**: System MUST maintain an immutable `payment_events` audit log for every state transition.
- **FR-012**: System MUST maintain a double-entry `ledger_entries` table with 3 accounts (CUSTOMER_RECEIVABLE, PLATFORM_REVENUE, DUFFEL_COST) where debits always equal credits per `transaction_id`.
- **FR-013**: System MUST use `idempotency_keys` with `recovery_point` tracking for pipeline resumption on crash/retry.
- **FR-014**: System MUST apply the tiered timeout escalation for authorize-to-capture: Tier 1 (0-30s sync), Tier 2 (30s-1min async), Tier 3 (15min admin alert), Tier 4 (30min-1hr auto-expire).
- **FR-015**: System MUST void/cancel Stripe authorizations when Duffel PNR creation fails, ensuring customers are never charged for non-existent bookings.

### Non-Functional Requirements

- **NFR-001**: **Correctness** — Exactly one processing at a time per BookingIntent, enforced by hybrid pessimistic claim + optimistic version checks.
- **NFR-002**: **Consistency over Availability** — The system prioritizes consistency. Synchronous database writes with strong consistency. No eventual consistency in the payment pipeline. 1-2 minutes of downtime is acceptable; inconsistent state is not.
- **NFR-003**: **Idempotency at every layer** — API layer (idempotency_keys table), Stripe layer (native idempotency keys), webhook layer (stripe_event_id unique index), refund layer (per-refund idempotency keys), recovery layer (recovery points).
- **NFR-004**: **Reliability** — Recovery from crashes via recovery points. Pipeline can be safely resumed from any checkpoint without re-executing completed steps.
- **NFR-005**: **Auditability** — Immutable payment_events log + double-entry ledger_entries. Every financial event is traceable.

### Key Entities

- **Payment**: One Stripe PaymentIntent. FK to BookingIntent (max 2 per intent). Tracks status via FSM, version for optimistic locking.
- **IdempotencyKey**: Tracks pipeline progress via recovery points. Ensures request deduplication and crash recovery.
- **PaymentEvent**: Immutable audit log. One row per state transition. Stripe event ID for webhook dedup.
- **LedgerEntry**: Double-entry bookkeeping. Paired debit/credit rows per transaction.
- **Refund**: Tracks individual refund operations. FK to Payment and IdempotencyKey. Dual trigger types.
- **PaymentMethod**: Saved card metadata (brand, last4). FK to Stripe Customer. Consent-tracked.

## Success Criteria

### Measurable Outcomes

- **SC-001**: A customer can complete a payment for a BookingIntent and receive a confirmed booking with PNR within 30 seconds (happy path).
- **SC-002**: No customer is ever charged for a booking that failed to create on Duffel (authorize-then-capture guarantees this).
- **SC-003**: No duplicate charges occur — the "max 2 attempts" rule is enforced with zero violations.
- **SC-004**: All payment state transitions are auditable via the immutable payment_events log.
- **SC-005**: All ledger entries balance: sum of debits equals sum of credits for every transaction_id.
- **SC-006**: Webhook processing is idempotent — processing the same Stripe event twice produces identical results.
- **SC-007**: Pipeline crashes are recoverable — retrying with the same idempotency key resumes from the last recovery point.
- **SC-008**: Automated refunds for detected system errors fire exactly once (idempotency key prevents duplicates).

## Assumptions

- Stripe test mode API keys are available for development and E2E testing.
- Feature A (BookingIntent — spec 009) is complete and the `BookingIntent` model exists with all fields from that spec.
- Duffel API integration is functional (from spec 006/009) for PNR creation.
- Docker services (PostgreSQL, Redis) are running for local development.
- The `User` model exists with authentication (from spec 001).
- `AuditLog` infrastructure exists (from previous specs).
- Frontend payment UI (Stripe Elements) is deferred to a separate frontend feature — this spec covers backend API only.
- Email notification for booking confirmation is deferred to a separate notification feature.
