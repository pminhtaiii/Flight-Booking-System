# Data Model: Cancellation & Refund Recovery

## Booking changes

Extend `BookingStatus` with `CANCELLATION_PENDING`,
`CANCELLED_PENDING_REFUND`, `CANCELLED`, and
`REFUND_FAILED_NEEDS_ATTENTION`. Add nullable `cancellationDeadline` (the
fare-specific cutoff captured at confirmation) and a one-to-one `cancellation`
relation.

Existing `CONFIRMED` and `COMPLETED` bookings may begin cancellation only when
their supplier order, successful payment, and deadline allow it. Processing or
failed bookings cannot be cancelled through this flow.

## Cancellation

Create a one-to-one `Cancellation` record for the durable supplier-side audit
and recovery state.

| Field | Purpose |
| --- | --- |
| `id`, `bookingId` (unique) | Identity and owner via Booking |
| `status` | `PENDING`, `SUPPLIER_CANCELLED`, `SUPPLIER_FAILED` |
| `quoteId`, `quoteExpiresAt` | Duffel cancellation quote, reused on recovery |
| `duffelOrderId`, `supplierCancellationId` | Upstream correlation and proof |
| `airlineRefundAmount`, `currency` | Authoritative quoted supplier amount |
| `claimedAt`, `supplierCancelledAt` | Claim/recovery and audit timestamps |
| `lastErrorCode`, `lastErrorAt` | PII-safe diagnostic information |
| `createdAt`, `updatedAt` | Audit timestamps |

Indexes: unique `bookingId`, plus `status, claimedAt` for reconciliation.

## Refund changes

Retain the existing payment-owned `Refund` model and extend it with nullable
`bookingId` (unique for this traveller cancellation), `airlineRefundAmount`,
`customerRefundAmount`, `retryCount`, `nextRetryAt`, `idempotencyKeyCreatedAt`,
`lastErrorCode`, and `lastErrorAt`. `customerRefundAmount` is exactly the
supplier quote's `refund_amount`; it is never calculated from a platform policy.

Indexes: `status, nextRetryAt` for due work and unique `bookingId` to prevent
two logical cancellation refunds.

## State transitions

```text
CONFIRMED/COMPLETED --CAS claim--> CANCELLATION_PENDING
CANCELLATION_PENDING --supplier succeeds--> CANCELLED_PENDING_REFUND
CANCELLED_PENDING_REFUND --Stripe succeeds/webhook--> CANCELLED
CANCELLED_PENDING_REFUND --terminal failure/key age--> REFUND_FAILED_NEEDS_ATTENTION
```

The transition that wins each CAS claim alone may call the next external system.
All loser processes re-read and return the canonical state without repeating an
external operation.
