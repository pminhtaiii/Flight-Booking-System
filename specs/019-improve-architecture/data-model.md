# Data Model: Deepen Codebase Architecture

## PostgreSQL financial model

### CancellationRefundObligation

Represents the single customer-refund amount owed because one Booking was cancelled. It is not a provider attempt and does not contain retry state.

| Field | Type | Rules |
|---|---|---|
| `id` | UUID | Primary key |
| `bookingId` | UUID | Required, unique FK to Booking; establishes Booking 1→0..1 obligation |
| `paymentId` | UUID | Required FK to the Payment whose refundable capacity applies |
| `totalAmount` | integer minor units | Required, non-negative; total customer amount owed |
| `airlineRefundAmount` | integer minor units | Required, non-negative supplier amount for audit; may differ from original Payment |
| `currency` | ISO 4217 string | Must match Payment and all linked transactions |
| `createdAt` | timestamp | Creation timestamp |
| `updatedAt` | timestamp | Last metadata update; fulfillment balances are not stored here |

Relationships:

```text
Booking 1 ── 0..1 CancellationRefundObligation
Payment 1 ── 0..N CancellationRefundObligation
CancellationRefundObligation 1 ── 0..N RefundTransaction
```

Validation invariants:

- The obligation’s Booking must reference the same Payment.
- `totalAmount` is the denominator for Booking cancellation fulfillment.
- A zero obligation creates no provider Refund Transaction and projects Booking to `CANCELLED_NO_REFUND` after supplier cancellation.
- Fulfilled and reserved amounts are derived from linked Refund Transactions under the reservation/settlement transaction; mutable aggregate counters are not authoritative.

### RefundTransaction

The target domain name for the existing Prisma `Refund` record. During the additive rollout the physical table remains `refunds` via `@@map("refunds")`.

| Field | Type | Rules |
|---|---|---|
| `id` | UUID | Primary key; internal transaction identity |
| `paymentId` | UUID | Required FK to Payment |
| `cancellationRefundObligationId` | UUID nullable | FK to obligation for cancellation-related transactions; null for other refund reasons |
| `idempotencyKeyId` | UUID | Required unique FK; transaction-scoped, reused by retries |
| `stripeRefundId` | string nullable | Unique provider reference once known; retain current name during migration |
| `amount` | integer minor units | Required and positive |
| `currency` | ISO 4217 string | Must match Payment and optional obligation |
| `reason` | string nullable | Allowlisted operational reason |
| `triggerType` | enum | Existing `USER`, `ADMIN`, or `SYSTEM_AUTOMATED` |
| `triggeredByUserId` | UUID nullable | Actor for user/admin initiation |
| `requiresReview` | boolean | Existing automated-review marker |
| `status` | RefundStatus | Operational transaction lifecycle |
| `airlineRefundAmount` | integer nullable | Legacy compatibility during backfill; obligation becomes canonical for cancellation quote amount |
| `customerRefundAmount` | integer nullable | Legacy compatibility during backfill; transaction `amount` is the money movement |
| retry/error fields | existing fields | `retryCount`, `nextRetryAt`, key age, last error code/time |
| timestamps | timestamp | Existing creation/update timestamps |

Target relationships:

```text
Payment 1 ── 0..N RefundTransaction
CancellationRefundObligation 1 ── 0..N RefundTransaction
RefundTransaction 1 ── 0..2 LedgerEntry
```

The legacy `bookingId @unique` and singular `Booking.cancellationRefund` are removed only after backfill validation and code cutover.

### RefundStatus transitions

```text
REFUND_PENDING
    → REFUND_PROCESSING
        → REFUND_RETRY_SCHEDULED
            → REFUND_PROCESSING
        → SUCCEEDED
        → FAILED
        → REFUND_FAILED_NEEDS_ATTENTION
```

Reservation classification:

- Active/reserved: `REFUND_PENDING`, `REFUND_PROCESSING`, `REFUND_RETRY_SCHEDULED`.
- Fulfilled: `SUCCEEDED`.
- Terminal/released: `FAILED`, `REFUND_FAILED_NEEDS_ATTENTION`.

Retries change lifecycle fields on the same transaction. A new independent provider money movement requires a new transaction and idempotency key.

### LedgerEntry linkage

Add nullable `refundTransactionId` during expansion and backfill it for successful refunds. After cutover, every successful Refund Transaction has exactly:

1. `DEBIT PLATFORM_REVENUE` for the transaction amount/currency.
2. `CREDIT CUSTOMER_RECEIVABLE` for the same amount/currency.

Add a unique constraint over `(refundTransactionId, accountId, entryType)` for non-null refund links. Settlement writes both entries and all state projections in one database transaction. Failed or active transactions have no refund reversal entries.

## Derived financial projections

### Payment refund projection

```text
successfulPaymentRefunds = SUM(amount WHERE paymentId = P AND status = SUCCEEDED)
activePaymentReservations = SUM(amount WHERE paymentId = P AND status IN active statuses)
remainingPaymentCapacity = Payment.amount - successfulPaymentRefunds - activePaymentReservations
```

Base refund state:

- `successfulPaymentRefunds >= Payment.amount` → `REFUNDED`.
- `successfulPaymentRefunds > 0` → `PARTIALLY_REFUNDED`, even if another transaction is active.
- No success and at least one active transaction → `REFUND_PENDING`.
- No success and no active transaction → retain/restore the valid paid state.

Existing dispute precedence remains intact: `DISPUTED` and `CHARGEBACK_LOST` are not overwritten improperly; the derived refund state is applied through the existing `preDisputeStatus` behavior where applicable.

### Cancellation fulfillment projection

```text
successfulObligationRefunds = SUM(amount WHERE obligationId = O AND status = SUCCEEDED)
activeObligationReservations = SUM(amount WHERE obligationId = O AND status IN active statuses)
remainingObligationCapacity = O.totalAmount - successfulObligationRefunds - activeObligationReservations
```

Booking state after supplier cancellation:

- `O.totalAmount = 0` → `CANCELLED_NO_REFUND`.
- `successfulObligationRefunds < O.totalAmount` → `CANCELLED_PENDING_REFUND`.
- `successfulObligationRefunds >= O.totalAmount` → `CANCELLED_AND_REFUNDED`.

`CANCELLATION_PENDING` remains exclusively the pre-supplier CAS claim and is never used for partial financial fulfillment.

## Normalized in-process value objects

### RefundSettlementInput

- `transactionId`
- `money`: amount and currency, checked against persisted transaction
- `outcome`: `SUCCEEDED` or `FAILED`, provider reference/error code, occurrence time
- `provenance`: inline/webhook/cron/admin source and allowlisted audit metadata

Provenance never selects a settlement rule.

### BookingPipelineOutcome

- Common: Booking identity, Payment identity, outcome occurrence metadata
- Confirmed facts: PNR, Duffel order reference, final snapshots and amounts
- Failure facts: allowlisted reason category and the partial deterministic state needed for recovery/audit

Booking Lifecycle validates the normalized outcome and owns booking persistence; Payment retains Stripe/Duffel pipeline orchestration.

## Redis trusted snapshot model

### SnapshotOwner

- `user_id`
- `session_id`

Both values participate in the Redis key and ownership validation.

### TrustedSearchSnapshot

- Canonical version
- owner
- issued/expiry timestamps
- selection attestation and fingerprint
- 1–5 contiguous, one-based `TrustedSearchOffer` records

Persistence rules:

- Key remains `chat:snapshot:{user_id}:{session_id}`.
- TTL is no longer than offer freshness and never exceeds the established cap.
- Version-aware atomic replacement prevents stale overwrite.
- Expired snapshots fail active load and may be deleted eagerly.
- Legacy field aliases are normalized only at the compatibility boundary.

### ResolvedOfferSelection

Contains canonical snapshot version, selected index, local/provider identities, attestation, fingerprint, and safe display facts. It is internal deterministic state and cannot be serialized into LLM/browser projections. Handoff creation consumes it but remains outside the snapshot lifecycle.

## Chat turn models

### ChatTurnCommand

Contains authenticated identity, message/confirmation input, optional session ID, opaque trace/correlation IDs, and prepared service dependencies/context. It contains no HTTP response or SSE object.

### ChatTurnEvent

A strict Pydantic discriminated union over the existing event names:

- `token`
- `tool_call`
- `tool_result`
- `flight_results`
- `ACTION_HANDOFF`
- `ACTION_REQUIRED`
- `done`
- `error`

All payload models forbid extra fields. Handoff credentials are permitted only in the existing `ACTION_HANDOFF.handoffToken` field. Provider identities, PII, passport, payment, and raw token data remain forbidden from all other event payloads.

## Migration stages

### Expand

1. Add `CancellationRefundObligation`.
2. Add nullable obligation FK to the existing refund table.
3. Add nullable Refund Transaction FK to ledger entries and uniqueness protection.
4. Introduce target Prisma relations without removing legacy Booking/Refund fields.

### Backfill and validate

1. Create one obligation for each legacy cancellation-linked Refund.
2. Convert Booking major-unit decimals to validated integer minor units.
3. Link the legacy Refund Transaction and successful ledger entries.
4. Quarantine/abort on Booking-Payment identity, currency, amount, or ledger mismatches.
5. Assert no over-reserved/over-refunded parent and no successful transaction without a balanced pair.

### Cut over

1. Deploy dual-compatible reads.
2. Create all new cancellations through obligation + transaction records.
3. Route terminal outcomes exclusively through Refund Settlement.
4. Observe settlement idempotency, mismatch, and reservation-conflict metrics.

### Contract

1. Require obligation linkage for cancellation Refund Transactions.
2. Remove legacy `Refund.bookingId` and singular Booking relation.
3. Remove legacy cancellation amount ownership from Refund Transaction after retention/backward-compatibility needs are satisfied.
4. Optionally rename the physical `refunds` table only as a separate cleanup migration.
