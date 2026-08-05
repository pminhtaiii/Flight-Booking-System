# API Contracts: Cancellation & Refund Recovery

All endpoints require the authenticated booking owner. Responses expose only
masked payment and PII-safe diagnostic fields.

## POST /api/bookings/:bookingId/cancellation-quote

Returns the existing valid quote or obtains one from Duffel for an eligible
confirmed booking.

Response: `bookingId`, `quoteId`, `refundAmount`, `currency`,
`expiresAt`, `cancellationDeadline`, and `status`.

Errors: `403` other user; `404` missing booking; `409` not cancellable,
deadline passed, already cancellation-pending, or supplier does not permit it.

## POST /api/bookings/:bookingId/cancel

Requires `quoteId`. Atomically claims the booking, confirms supplier
cancellation with short inline retries, and begins the refund. A concurrent
request returns the current canonical cancellation/refund state without a
second supplier operation.

Response: `bookingId`, `bookingStatus`, `cancellationStatus`, `refundStatus`,
`refundAmount`, and `nextRetryAt` when a background retry is scheduled.

Errors: `409` quote expired/invalid or cancellation already in progress; `502`
when all retryable supplier attempts fail and supplier cancellation cannot be
confirmed. No refund begins in that case.

## GET /api/bookings/:bookingId/cancellation

Returns the durable cancellation and refund status for polling/detail-page
refresh: booking status, quote expiry, airline/customer refund amounts,
retry timing, and a user-safe escalation message. It never calls Duffel or
Stripe.

## Worker and webhook contracts

The scheduled worker only selects due `CANCELLED_PENDING_REFUND` records and
must CAS-claim each refund before calling Stripe. `charge.refunded` and refund
webhooks reconcile the canonical `Refund` record idempotently, then transition
the owning Booking to `CANCELLED`.
