# Implementation Plan: Stripe Payment System

**Branch**: `010-stripe-payment-system` | **Date**: 2026-07-12 | **Spec**: [spec.md](./spec.md)
**Input**: Grilling session decisions from [research/payment-system-decisions.md](../../research/payment-system-decisions.md)

> **Context**: Feature A (Booking Intent Foundation — spec 009) created the `BookingIntent` data model and pipeline. This feature adds Stripe payment processing: authorize-then-capture, FSM lifecycle, webhook processing, idempotency with recovery points, double-entry ledger, refund system, saved payment methods, and dispute handling.

## Summary

Build a complete payment processing system integrated with Stripe Payment Intents. The system uses authorize-then-capture to protect customers from failed Duffel bookings, a strict 11-state finite state machine with enforced transitions, webhook processing as the source of truth with two-tier self-healing, per-request idempotency keys with recovery points for crash recovery, a double-entry ledger for financial auditability, and a dual-trigger refund system (automated + admin) with idempotency guardrails.

## Technical Context

**Language/Version**: TypeScript / Node.js
**Primary Dependencies**: NestJS, Prisma, Stripe (`stripe` SDK), Duffel API (`@duffel/api` SDK)
**Storage**: PostgreSQL (6 new tables + 5 new enums), existing AES-256-GCM encryption
**Testing**: Jest (backend E2E)
**Target Platform**: Web application (API only — no frontend in this feature)
**Performance Goals**: Happy-path payment (create → authorize → Duffel PNR → capture) < 30 seconds
**Constraints**: Duffel rate limit (120 req/60s), Stripe webhook signature verification mandatory, PCI-DSS compliance (card data never touches our server)

## Constitution Check

_GATE: Passed._

- **I. Flight-First Architecture**: ✅ Payment IS the core flight booking pipeline — the direct bridge between intent and confirmed booking.
- **II. Deterministic Transaction Boundary**: ✅ Entire flow is deterministic. No AI involvement. Stripe and Duffel calls are deterministic API calls. All state transitions auditable via payment_events + ledger_entries.
- **III. API Budget Discipline**: ✅ One Duffel call per payment (PNR creation). This is a justified user-facing action — user explicitly clicked "Pay." No speculative API calls.
- **IV. Observability & Operational Visibility**: ✅ Immutable payment_events audit log. Structured logging for webhook processing, cron runs, self-healing reconciliation, and admin alerts. Ledger provides financial auditability.
- **V. Incremental Delivery**: ✅ Split into 10 fine-grained phases. Each phase is independently testable. Phase 1 (schema) through Phase 4 (core pipeline) form the MVP. Later phases (refunds, disputes, saved methods) are additive.

## Project Structure

### Documentation (this feature)

```text
specs/010-stripe-payment-system/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Grilling decisions consolidated
├── data-model.md        # Schema definitions
├── quickstart.md        # Validation scenarios
├── contracts/
│   └── api.md           # API endpoint contracts
└── tasks.md             # Created by /speckit-tasks
```

### Source Code Changes

```text
apps/api/
├── prisma/
│   └── schema.prisma                         # MODIFIED: +6 models, +5 enums, +User/BookingIntent extensions
├── src/
│   ├── payment/                              # NEW: entire module
│   │   ├── payment.module.ts                 # NEW: NestJS module definition
│   │   ├── payment.controller.ts             # NEW: REST endpoints (create, confirm, status, refund, methods)
│   │   ├── payment.service.ts                # NEW: core pipeline (create → authorize → Duffel → capture)
│   │   ├── payment-state-machine.ts          # NEW: FSM transition enforcer
│   │   ├── payment-webhook.controller.ts     # NEW: Stripe webhook endpoint
│   │   ├── payment-webhook.service.ts        # NEW: webhook processing (dedup, self-healing, dispatch)
│   │   ├── payment-idempotency.service.ts    # NEW: idempotency key management + recovery points
│   │   ├── payment-ledger.service.ts         # NEW: double-entry ledger operations
│   │   ├── payment-refund.service.ts         # NEW: refund pipeline (admin + automated)
│   │   ├── payment-method.service.ts         # NEW: saved payment method CRUD
│   │   ├── payment-cron.service.ts           # NEW: authorization expiry sweep + idempotency key cleanup
│   │   └── dto/
│   │       ├── create-payment.dto.ts         # NEW: request DTO
│   │       ├── confirm-payment.dto.ts        # NEW: request DTO
│   │       ├── refund-payment.dto.ts         # NEW: request DTO
│   │       └── payment-response.dto.ts       # NEW: response DTOs
│   ├── common/
│   │   └── stripe.service.ts                 # NEW: shared Stripe SDK wrapper
│   └── app.module.ts                         # MODIFIED: register PaymentModule
└── test/
    ├── payment.e2e-spec.ts                   # NEW: core payment E2E tests
    ├── payment-webhook.e2e-spec.ts           # NEW: webhook E2E tests
    ├── payment-refund.e2e-spec.ts            # NEW: refund E2E tests
    └── payment-idempotency.e2e-spec.ts       # NEW: idempotency + recovery E2E tests
packages/shared/
└── src/
    └── types/
        └── payment.types.ts                  # NEW: shared payment types
```

**Structure Decision**: New `payment/` module under `apps/api/src/`, following the same pattern as `booking-intent/`, `flights/`, `auth/`. Stripe SDK wrapper in `common/` since it will be shared across payment service, webhook service, and refund service.

---

## Implementation Phases

### Phase 1: Database Schema & Enums

> **Foundation** — all tables and enums must exist before any service code.
> **Estimated scope**: ~2 files modified + 1 migration

| Task                                                                                                                       | Status | Notes                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------ |
| Add `PaymentStatus`, `RefundStatus`, `RefundTriggerType`, `LedgerEntryType`, `PaymentEventSource` enums to `schema.prisma` | ☐      | See [data-model.md](./data-model.md)                                                                                     |
| Extend `BookingIntentStatus` enum with `AWAITING_PAYMENT`, `PAYMENT_EXHAUSTED`, `CONFIRMED`, `CANCELLED`                   | ☐      | New values added to existing enum                                                                                        |
| Add `Payment` model to `schema.prisma`                                                                                     | ☐      | Includes `version` for optimistic locking, `pre_dispute_status`, unique constraint on `[bookingIntentId, attemptNumber]` |
| Add `IdempotencyKey` model to `schema.prisma`                                                                              | ☐      | Unique `key`, `recoveryPoint`, `lockedAt` for claim mechanism                                                            |
| Add `PaymentEvent` model to `schema.prisma`                                                                                | ☐      | BIGSERIAL PK, unique `stripeEventId` (nullable), immutable                                                               |
| Add `LedgerEntry` model to `schema.prisma`                                                                                 | ☐      | `transactionId` groups paired entries, `accountId` for chart of accounts                                                 |
| Add `Refund` model to `schema.prisma`                                                                                      | ☐      | FKs to Payment and IdempotencyKey, `requiresReview` flag                                                                 |
| Add `PaymentMethod` model to `schema.prisma`                                                                               | ☐      | `savedWithConsent`, unique `stripePaymentMethodId`                                                                       |
| Add `stripeCustomerId` to `User` model                                                                                     | ☐      | Nullable, unique                                                                                                         |
| Add `paymentAttemptCount` to `BookingIntent` model                                                                         | ☐      | Default 0, max 2 enforced in application                                                                                 |
| Add back-relations to `User` and `BookingIntent`                                                                           | ☐      | `idempotencyKeys`, `refundsTriggered`, `payments`                                                                        |
| Run `npx prisma migrate dev` and verify Prisma client types                                                                | ☐      |                                                                                                                          |
| Add shared types to `packages/shared/src/types/payment.types.ts`                                                           | ☐      | PaymentStatus, RefundStatus, etc.                                                                                        |

**Exit criteria**: Migration applied, all 6 new tables exist, Prisma client types generated, existing tests still pass.

---

### Phase 2: Stripe SDK Wrapper & Shared Infrastructure

> **Service foundation** — Stripe connectivity and shared utilities.
> **Estimated scope**: ~3 files created

| Task                                                                  | Status | Notes                                                                                                            |
| --------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------- |
| Create `common/stripe.service.ts` — injectable NestJS service         | ☐      | Wraps Stripe SDK initialization, reads `STRIPE_SECRET_KEY` from env, validates at startup                        |
| Implement `createPaymentIntent()` method                              | ☐      | Accepts amount, currency, customer, metadata, idempotency key. Supports `capture_method: 'manual'` for auth-only |
| Implement `capturePaymentIntent()` method                             | ☐      | Captures an authorized PaymentIntent                                                                             |
| Implement `cancelPaymentIntent()` method                              | ☐      | Voids an authorization                                                                                           |
| Implement `createCustomer()` method                                   | ☐      | Creates Stripe Customer with idempotency key                                                                     |
| Implement `retrievePaymentIntent()` method                            | ☐      | For self-healing reconciliation (Tier 1 webhook handling)                                                        |
| Implement `createRefund()` method                                     | ☐      | Stripe refund with idempotency key                                                                               |
| Implement `constructWebhookEvent()` method                            | ☐      | Verifies Stripe webhook signature                                                                                |
| Add `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` to env validation | ☐      |                                                                                                                  |

**Exit criteria**: Stripe service injectable, all SDK methods work with Stripe test mode, webhook signature verification functional.

---

### Phase 3: Payment State Machine

> **Core invariant enforcement** — the FSM that guards all state transitions.
> **Estimated scope**: ~2 files created

| Task                                                               | Status | Notes                                                                                |
| ------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------ |
| Create `payment-state-machine.ts`                                  | ☐      | Pure function: `canTransition(currentStatus, targetStatus): boolean`                 |
| Define allowed transitions map                                     | ☐      | All 11 states with explicit allowed next-states (see spec Decision 2)                |
| Implement `enforceTransition()` — throws if transition is invalid  | ☐      | Used by all services before updating payment status                                  |
| Implement `getPreDisputeStatus()` helper                           | ☐      | Returns the current status when entering DISPUTED (for storing `pre_dispute_status`) |
| Implement `resolveDisputeStatus(outcome, preDisputeStatus)` helper | ☐      | Returns pre_dispute_status for "won", CHARGEBACK_LOST for "lost"                     |
| Unit tests for all valid and invalid transitions                   | ☐      | Test every edge in the state graph + test rejection of every invalid edge            |

**Exit criteria**: FSM enforces all transitions defined in the spec. Invalid transitions throw. Dispute resolution correctly returns to pre-dispute state. 100% transition coverage in tests.

---

### Phase 4: Idempotency Key Service

> **Request deduplication and crash recovery** — the recovery point mechanism.
> **Estimated scope**: ~2 files created

| Task                                                                   | Status | Notes                                                                                                                                       |
| ---------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Create `payment-idempotency.service.ts`                                | ☐      |                                                                                                                                             |
| Implement `acquireOrReplay(key, requestHash, customerId, requestPath)` | ☐      | Check if key exists → if same hash, return cached response (replay). If different hash, reject 422. If new, create with `locked_at = now()` |
| Implement `updateRecoveryPoint(keyId, recoveryPoint)`                  | ☐      | Advances the recovery point after each pipeline step                                                                                        |
| Implement `completeKey(keyId, responseCode, responseBody)`             | ☐      | Stores cached response, clears `locked_at`                                                                                                  |
| Implement `getResumePoint(keyId)`                                      | ☐      | Returns the current recovery point for crash resumption                                                                                     |
| Implement `isLocked(keyId)` — checks if another process holds the key  | ☐      | Stale lock detection: if `locked_at` is older than a threshold (e.g., 5 min), consider it abandoned                                         |
| Implement request hash computation (SHA-256 of request body)           | ☐      | Deterministic serialization before hashing                                                                                                  |
| Create DTO for idempotency key header extraction                       | ☐      | NestJS custom decorator `@IdempotencyKey()`                                                                                                 |

**Exit criteria**: Keys are created atomically, replays return cached responses, different-payload reuse is rejected, recovery points advance correctly, stale locks are detectable.

---

### Phase 5: Core Payment Pipeline (Create + Authorize)

> **The first half of the payment flow** — from "Pay" button to funds held on card.
> **Estimated scope**: ~5 files created

| Task                                                         | Status | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create `dto/create-payment.dto.ts`                           | ☐      | `bookingIntentId`, `paymentMethodId?`, `saveCard`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Create `dto/payment-response.dto.ts`                         | ☐      | Creation, confirmation, and status response shapes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Create `payment.service.ts` — `createPayment()` method       | ☐      | Hybrid lock: pessimistic claim on BookingIntent (SELECT FOR UPDATE → check startable state + attempt count < 2 → write CLAIMING marker). Persist idempotency/claim record and recovery state before calling Stripe. Then: lazy Stripe Customer creation (idempotent), create Stripe PaymentIntent with `capture_method: 'manual'`, create Payment row, create PaymentEvent, advance recovery point to `started`. Add retrieval-based reconciliation for interrupted creation so an existing Stripe PaymentIntent can be mapped to the local DB after a crash instead of creating an orphaned intent. |
| Implement Stripe Customer lazy creation                      | ☐      | Check `User.stripeCustomerId` → if null, create Stripe Customer with idempotency key `customer-create:{userId}`, save to User. If `saveCard`, set `setup_future_usage: 'off_session'` on PaymentIntent                                                                                                                                                                                                                                                                                                                                                                                               |
| Create `payment.controller.ts` — `POST /api/payments/create` | ☐      | JWT-guarded, extracts `Idempotency-Key` header, delegates to service                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Create `payment.module.ts` and register in `app.module.ts`   | ☐      | Import PrismaModule, StripeService, BookingIntentModule, AuditModule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Add audit logging for `payment_created`                      | ☐      | Structured metadata: paymentId, userId, bookingIntentId, amount, attemptNumber                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

**Exit criteria**: `POST /api/payments/create` works. Returns Stripe client secret. Payment row exists in DB with status CREATED. Idempotency key created with recovery point. BookingIntent.paymentAttemptCount incremented. Pessimistic lock prevents concurrent claims.

---

### Phase 6: Core Payment Pipeline (Confirm + Capture)

> **The second half** — from authorized funds to confirmed booking.
> **Estimated scope**: ~3 files modified/created

| Task                                                                                | Status | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create `dto/confirm-payment.dto.ts`                                                 | ☐      | `paymentId`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Implement `payment.service.ts` — `confirmPayment()` method                          | ☐      | Read recovery point → resume from correct step. Pipeline: authorize (if not already) → update recovery point to `stripe_authorized` → call Duffel to create PNR → update recovery point to `duffel_order_created` → capture Stripe payment (as an external boundary, not wrapped in a single DB transaction) → update recovery point to `captured` → write ledger entries and update DB → update recovery point to `completed`. Add durable post-capture reconciliation that detects successful captures followed by failed database commits to retry or repair booking status, ledger entries, and recovery state. |
| Implement Duffel PNR creation integration                                           | ☐      | Reuse existing DuffelService. Use BookingIntent's `duffelOfferId`. Bounded timeout (30s). Map timeout/rate-limit/upstream failures explicitly                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Implement tiered timeout logic                                                      | ☐      | Tier 1: synchronous (0-30s). Tier 2: return 202 Accepted + poll URL (30s-1min). Background processing continues                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Implement authorization void on Duffel failure                                      | ☐      | If Duffel PNR creation fails, call `stripe.paymentIntents.cancel()` to void the hold. Payment → CANCELLED                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Implement `GET /api/payments/:paymentId/status` polling endpoint                    | ☐      | Returns current payment status, bookingIntent status, PNR reference if available                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Add `POST /api/payments/confirm` to controller                                      | ☐      | JWT-guarded, idempotency key extraction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Create ledger entries on successful capture                                         | ☐      | DEBIT CUSTOMER_RECEIVABLE, CREDIT PLATFORM_REVENUE. Duffel cost entry deferred to when cost is known                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Update BookingIntent status to CONFIRMED on success                                 | ☐      | Outside of capture network call, coordinated by post-capture DB updates/reconciliation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Add audit logging for `payment_authorized`, `payment_captured`, `booking_confirmed` | ☐      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

**Exit criteria**: Full pipeline works: create → authorize → Duffel PNR → capture → CONFIRMED. Ledger balanced. Recovery points track progress. Duffel failure voids authorization. Async handoff returns 202 with poll URL.

---

### Phase 7: Webhook Processing

> **Source of truth** — Stripe webhooks drive payment status with dedup and self-healing.
> **Estimated scope**: ~3 files created

| Task                                                                | Status | Notes                                                                                                                                                                 |
| ------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create `payment-webhook.controller.ts`                              | ☐      | Raw body parsing, Stripe signature verification, NOT JWT-guarded                                                                                                      |
| Create `payment-webhook.service.ts`                                 | ☐      | Event router — dispatches to handlers by event type                                                                                                                   |
| Implement webhook deduplication                                     | ☐      | Check `payment_events.stripe_event_id` — if exists, return 200 + skip                                                                                                 |
| Implement `payment_intent.succeeded` handler                        | ☐      | Validate FSM transition, update Payment status, append PaymentEvent                                                                                                   |
| Implement `payment_intent.payment_failed` handler                   | ☐      | Payment → FAILED (terminal), PaymentEvent appended                                                                                                                    |
| Implement `payment_intent.canceled` handler                         | ☐      | Payment → CANCELLED, PaymentEvent appended                                                                                                                            |
| Implement Tier 1 self-healing reconciliation                        | ☐      | When webhook transition is invalid but plausible (out-of-order): call `Stripe.paymentIntents.retrieve()`, verify canonical state, fast-forward DB, log reconciliation |
| Implement Tier 2 alert + drop                                       | ☐      | When transition is irreconcilable: log full payload, alert admin (structured log entry with `level: ALERT`), return 200, do NOT change state                          |
| Register webhook route (no auth guard, signature verification only) | ☐      |                                                                                                                                                                       |
| Add structured logging for every webhook processed                  | ☐      | Event type, payment ID, transition, self-healing flag, processing time                                                                                                |

**Exit criteria**: All payment webhook events processed correctly. Duplicates silently skipped. Out-of-order events self-healed via Stripe API. Irreconcilable events logged and dropped. Always returns 200.

---

### Phase 8: Refund System

> **Financial safety net** — automated and admin-triggered refunds with idempotency.
> **Estimated scope**: ~3 files created/modified

| Task                                                                        | Status | Notes                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create `dto/refund-payment.dto.ts`                                          | ✅     | `amount`, `reason`                                                                                                                                                                                                        |
| Create `payment-refund.service.ts`                                          | ✅     |                                                                                                                                                                                                                           |
| Implement `initiateRefund(paymentId, amount, reason, triggerType, userId?)` | ✅     | Validate: payment in refundable state (SUCCEEDED or PARTIALLY_REFUNDED). Create Refund record with idempotency key. Call Stripe `refunds.create()`. Update Payment → REFUND_PENDING. Append PaymentEvent                  |
| Implement automated refund trigger                                          | ✅     | Detect invariant violations (e.g., 3rd charge attempt somehow captured). Fire refund with idempotency key `refund:{paymentId}:{reason}:{occurrence}`. Set `requires_review = true`                                        |
| Implement `charge.refunded` webhook handler                                 | ✅     | Update Refund status → SUCCEEDED. Update Payment → PARTIALLY_REFUNDED or REFUNDED (based on remaining balance). Create reversing ledger entries (DEBIT PLATFORM_REVENUE, CREDIT CUSTOMER_RECEIVABLE). Append PaymentEvent |
| Implement partial refund tracking                                           | ✅     | Track total refunded amount vs. original. PARTIALLY_REFUNDED → REFUND_PENDING loop. Close to REFUNDED when full amount returned                                                                                           |
| Add `POST /api/payments/:paymentId/refund` to controller                    | ✅     | Admin role guard, idempotency key header                                                                                                                                                                                  |
| Add audit logging for `refund_initiated`, `refund_completed`                | ✅     |                                                                                                                                                                                                                           |

**Exit criteria**: Admin can trigger refunds. Automated refunds fire for detected errors with idempotency. Partial refunds loop correctly. Ledger has reversing entries. Webhook updates refund status.

---

### Phase 9: Dispute Handling

> **Chargeback lifecycle** — tracking disputes through resolution.
> **Estimated scope**: ~2 files modified

| Task                                                                  | Status | Notes                                                                                                                                                                                              |
| --------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Implement `charge.dispute.created` webhook handler                    | ✅     | Store `pre_dispute_status` (current status before DISPUTED). Validate FSM: only SUCCEEDED, PARTIALLY_REFUNDED, REFUNDED can transition to DISPUTED. Update Payment → DISPUTED. Append PaymentEvent |
| Implement `charge.dispute.closed` webhook handler                     | ✅     | Read outcome from Stripe event. If "won": restore `pre_dispute_status`. If "lost": Payment → CHARGEBACK_LOST. Append PaymentEvent. Log with alert level for lost disputes                          |
| Handle dispute on already-refunded payment                            | ✅     | REFUNDED → DISPUTED → REFUNDED (won) path. Verify pre_dispute_status is correctly stored and restored                                                                                              |
| Add audit logging for `dispute_opened`, `dispute_won`, `dispute_lost` | ✅     |                                                                                                                                                                                                    |

**Exit criteria**: Disputes transition correctly for all pre-dispute states. Won disputes return to pre-dispute state. Lost disputes transition to CHARGEBACK_LOST. PaymentEvents capture full dispute lifecycle.

---

### Phase 10: Saved Payment Methods

> **Checkout friction reduction** — save and reuse cards with consent.
> **Estimated scope**: ~2 files created

| Task                                                         | Status | Notes                                                                                                                                          |
| ------------------------------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Create `payment-method.service.ts`                           | ✅     |                                                                                                                                                |
| Implement `listMethods(stripeCustomerId)`                    | ✅     | Fetch from PaymentMethod table (not Stripe — we have the data). Return card_brand, card_last4, is_default                                      |
| Implement `saveMethods(stripeCustomerId)` sync after payment | ✅     | After successful payment with `saveCard: true`, fetch attached methods from Stripe, upsert PaymentMethod rows with `saved_with_consent = true` |
| Implement `deleteMethod(methodId, userId)`                   | ✅     | Ownership check. Delete from local DB + detach from Stripe Customer                                                                            |
| Implement `setDefault(methodId, userId)`                     | ✅     | Set `is_default = true`, clear others                                                                                                          |
| Add `GET /api/payments/methods` to controller                | ✅     | JWT-guarded, returns user's saved methods                                                                                                      |
| Add `DELETE /api/payments/methods/:methodId` to controller   | ✅     | JWT-guarded, ownership enforcement                                                                                                             |
| Integrate saved method selection into `createPayment()`      | ✅     | If `paymentMethodId` provided, pass to Stripe PaymentIntent creation                                                                           |

**Exit criteria**: Cards saved with consent after opt-in payment. Saved methods listed for selection. Methods deletable. Default selection works. Used in subsequent payment creation.

---

### Phase 11: Cron Jobs — Authorization Expiry & Cleanup

> **Data hygiene and timeout enforcement** — sweeps for expired authorizations and stale keys.
> **Estimated scope**: ~1 file created

| Task                                                     | Status | Notes                                                                                                                                                                                                                      |
| -------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create `payment-cron.service.ts` with `@nestjs/schedule` | ✅     |                                                                                                                                                                                                                            |
| Implement authorization expiry sweep                     | ✅     | Find AUTHORIZED payments older than 60-90 minutes (via `PAYMENT_AUTH_EXPIRE_MINUTES`). Void Stripe authorization. Payment → EXPIRED. BookingIntent → back to AWAITING_PAYMENT or PAYMENT_EXHAUSTED. PaymentEvent appended. |
| Implement idempotency key cleanup                        | ✅     | Delete expired idempotency keys (older than `IDEMPOTENCY_KEY_TTL_HOURS`, default 24h). Only delete keys with recovery_point = 'completed' or expired keys                                                                  |
| Implement stale lock detection                           | ✅     | Find idempotency keys with `locked_at` older than threshold (5 min). Clear the lock (set `locked_at = NULL`). Log as warning                                                                                               |
| Structured logging for each cron run                     | ✅     | Count of expired authorizations, cleaned keys, cleared locks, duration                                                                                                                                                     |
| Register `ScheduleModule`                                | ✅     | Already registered globally in app.module.ts                                                                                                                                                                               |

**Exit criteria**: Expired authorizations are voided and swept. Stale idempotency locks are cleared. Completed/expired keys are cleaned up. All operations logged.

---

### Phase 12: E2E Testing & Verification

> **Quality gate** — comprehensive tests for the entire payment system.
> **Estimated scope**: ~4 test files created

| Task                                                                              | Status | Notes                                                                    |
| --------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------ |
| E2E: Happy path — create → authorize → Duffel PNR → capture → CONFIRMED (201/200) | ✅     | Verify DB records, payment_events, ledger_entries                        |
| E2E: Failed payment — card declined (402) → FAILED terminal                       | ✅     | Verify no charge, PaymentEvent logged                                    |
| E2E: Payment retry — first fails, second succeeds                                 | ✅     | Verify attempt_number = 2, paymentAttemptCount = 2                       |
| E2E: Third attempt blocked (429)                                                  | ✅     | Verify PAYMENT_EXHAUSTED status                                          |
| E2E: Concurrent payment claims — pessimistic lock conflict (409)                  | ✅     | Two simultaneous requests, only one succeeds                             |
| E2E: Duffel failure — authorization voided (502)                                  | ✅     | Verify Stripe cancel called, Payment → CANCELLED                         |
| E2E: Idempotency key replay — same key returns cached response                    | ✅     | No duplicate Payment created                                             |
| E2E: Idempotency key reuse with different payload (422)                           | ✅     | Request hash mismatch                                                    |
| E2E: Recovery point resumption — crash after authorization                        | ✅     | Simulate crash, retry same key, verify pipeline resumes from Duffel step |
| E2E: Webhook deduplication — same event ID processed twice                        | ✅     | No duplicate PaymentEvent                                                |
| E2E: Webhook self-healing — out-of-order event reconciled                         | ✅     | CREATED → (skip AUTHORIZED) → succeeded webhook → self-heal to SUCCEEDED |
| E2E: Webhook irreconcilable — alert + drop                                        | ✅     | REFUNDED payment receives succeeded webhook → logged, state unchanged    |
| E2E: Admin refund — full refund (201) → webhook → REFUNDED                        | ✅     | Verify ledger reversing entries                                          |
| E2E: Partial refund — two partial refunds → REFUNDED                              | ✅     | PARTIALLY_REFUNDED → REFUND_PENDING → REFUNDED                           |
| E2E: Automated refund idempotency — same trigger twice                            | ✅     | Only one Refund created                                                  |
| E2E: Dispute opened → DISPUTED with pre_dispute_status stored                     | ✅     |                                                                          |
| E2E: Dispute won → returns to pre-dispute state                                   | ✅     | Test for SUCCEEDED, PARTIALLY_REFUNDED, REFUNDED pre-dispute states      |
| E2E: Dispute lost → CHARGEBACK_LOST                                               | ✅     |                                                                          |
| E2E: Save card with consent → method appears in list                              | ✅     |                                                                          |
| E2E: Delete saved method (204)                                                    | ✅     |                                                                          |
| E2E: Authorization expiry cron → AUTHORIZED → EXPIRED                             | ✅     | Artificially age payment                                                 |
| E2E: Ledger invariant — debits equal credits for every transaction_id             | ✅     | Aggregate check across all test scenarios                                |
| E2E: Optimistic version conflict detected                                         | ✅     | Simulate concurrent modification mid-pipeline                            |
| Regression: existing booking-intent E2E tests still pass                          | ✅     | No breakage from schema changes                                          |
| Regression: existing flight search E2E tests still pass                           | ✅     |                                                                          |

**Exit criteria**: All E2E tests pass. Full state machine coverage. Idempotency verified. Ledger balanced. No regression on existing features.

---

## Environment Variables

| Variable                           | Default | Required | Notes                                                          |
| ---------------------------------- | ------- | -------- | -------------------------------------------------------------- |
| `STRIPE_SECRET_KEY`                | —       | Yes      | Stripe test mode secret key                                    |
| `STRIPE_WEBHOOK_SECRET`            | —       | Yes      | Stripe webhook signing secret                                  |
| `PAYMENT_AUTH_EXPIRE_MINUTES`      | `60`    | No       | Tier 4 auto-expire threshold for authorized payments           |
| `PAYMENT_ADMIN_ALERT_MINUTES`      | `15`    | No       | Tier 3 admin alert threshold                                   |
| `IDEMPOTENCY_KEY_TTL_HOURS`        | `24`    | No       | Hours before completed/expired idempotency keys are cleaned up |
| `IDEMPOTENCY_LOCK_TIMEOUT_MINUTES` | `5`     | No       | Threshold for considering a lock stale                         |

**Existing variables** (unchanged):

- `ENCRYPTION_KEY` — from Feature A
- `DUFFEL_ACCESS_TOKEN` — for PNR creation
- `DATABASE_URL` — PostgreSQL connection

---

## Verification Plan

### Automated Tests

```bash
# Payment E2E tests
npm run test:e2e --workspace=apps/api -- --testPathPattern=payment

# Full regression suite
npm run test:e2e --workspace=apps/api

# Prisma schema validation
npx prisma validate --schema=apps/api/prisma/schema.prisma
```

### Manual Verification

- Complete a payment via curl with Stripe test card `4242424242424242` → verify 201 + SUCCEEDED + PNR
- Check `payment_events` table → verify immutable audit trail with all transitions
- Check `ledger_entries` table → verify DEBIT CUSTOMER_RECEIVABLE = CREDIT PLATFORM_REVENUE
- Trigger admin refund → verify REFUND_PENDING → REFUNDED via webhook → reversing ledger entries
- Force Duffel failure → verify authorization voided, customer not charged
- Replay same idempotency key → verify cached response returned
- Replay same key with different body → verify 422
- Run Stripe CLI `stripe events resend` → verify webhook deduplication
- Set `PAYMENT_AUTH_EXPIRE_MINUTES=1`, create authorized payment, wait → verify EXPIRED

---

## Complexity Tracking

No constitution violations. All design decisions align with existing patterns:

- Schema follows Prisma conventions used throughout the project
- Module structure follows NestJS module pattern (flights, auth, chat, booking-intent)
- Cron follows the BookingIntent retention cleanup pattern
- Audit logging follows existing AuditModule pattern
- Double-entry ledger is the only net-new architectural pattern — justified by Principle IV (Observability) and the video reference architecture for financial auditability
