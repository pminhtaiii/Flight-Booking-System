# API Contracts: Stripe Payment System

**Feature**: 010-stripe-payment-system | **Date**: 2026-07-12

All endpoints are JWT-guarded. Base path: `/api/payments`

---

## POST /api/payments/create

Create a new payment (Stripe PaymentIntent) for a BookingIntent. This is the entry point for the payment pipeline.

### Request

```json
{
  "bookingIntentId": "uuid",
  "paymentMethodId": "pm_xxx (optional — for saved cards)",
  "saveCard": false
}
```

**Headers**:
- `Authorization: Bearer <JWT>`
- `Idempotency-Key: <client-generated-uuid>` (required)

### Response (201 Created)

```json
{
  "paymentId": "uuid",
  "stripeClientSecret": "pi_xxx_secret_xxx",
  "attemptNumber": 1,
  "amount": 50000,
  "currency": "usd",
  "status": "CREATED",
  "requiresAction": false
}
```

### Error Responses

| Status | Condition |
|--------|-----------|
| 400 | Invalid bookingIntentId or missing idempotency key |
| 403 | BookingIntent belongs to another user |
| 409 | BookingIntent already has an active payment in progress (pessimistic lock conflict) |
| 410 | BookingIntent expired |
| 422 | Idempotency key reused with different request hash |
| 429 | Payment attempts exhausted (max 2) — BookingIntent transitions to PAYMENT_EXHAUSTED |

---

## POST /api/payments/confirm

Confirm the payment after Stripe client-side authentication (3DS). Triggers the authorize → Duffel PNR → capture pipeline.

### Request

```json
{
  "paymentId": "uuid"
}
```

**Headers**:
- `Authorization: Bearer <JWT>`
- `Idempotency-Key: <same-key-as-create>` (required — pipeline resumption)

### Response (200 OK — synchronous success within 30s)

```json
{
  "paymentId": "uuid",
  "status": "SUCCEEDED",
  "bookingIntentStatus": "CONFIRMED",
  "pnrReference": "ABC123"
}
```

### Response (202 Accepted — async handoff after 30s)

```json
{
  "paymentId": "uuid",
  "status": "AUTHORIZED",
  "message": "Payment authorized. Booking confirmation in progress.",
  "pollUrl": "/api/payments/{paymentId}/status"
}
```

### Error Responses

| Status | Condition |
|--------|-----------|
| 400 | Invalid paymentId |
| 402 | Card declined / authorization failed → Payment transitions to FAILED |
| 403 | Payment belongs to another user |
| 409 | Version conflict (concurrent modification detected) |
| 502 | Duffel unavailable — authorization voided, Payment transitions to CANCELLED |

---

## GET /api/payments/:paymentId/status

Poll payment status (used after async handoff).

### Response (200 OK)

```json
{
  "paymentId": "uuid",
  "status": "SUCCEEDED",
  "bookingIntentStatus": "CONFIRMED",
  "amount": 50000,
  "currency": "usd",
  "pnrReference": "ABC123",
  "updatedAt": "2026-07-12T12:00:00Z"
}
```

---

## POST /api/payments/webhook

Stripe webhook endpoint. Receives all payment-related events.

### Request

Raw body with `Stripe-Signature` header. Not JWT-guarded — verified via Stripe webhook signature.

### Handled Events

| Event | Action |
|-------|--------|
| `payment_intent.created` | Update Payment → CREATED (if not already) |
| `payment_intent.succeeded` | Update Payment → SUCCEEDED |
| `payment_intent.payment_failed` | Update Payment → FAILED |
| `payment_intent.canceled` | Update Payment → CANCELLED |
| `charge.refunded` | Update Payment → REFUNDED or PARTIALLY_REFUNDED |
| `charge.dispute.created` | Update Payment → DISPUTED, store pre_dispute_status |
| `charge.dispute.closed` | Update Payment → pre_dispute_status (won) or CHARGEBACK_LOST (lost) |

### Response

Always returns `200 OK` (even for dropped events) to prevent Stripe retries.

---

## POST /api/payments/:paymentId/refund

Initiate a refund (admin-triggered).

### Request

```json
{
  "amount": 50000,
  "reason": "System error — duplicate charge"
}
```

**Headers**:
- `Authorization: Bearer <JWT>` (admin role required)
- `Idempotency-Key: <uuid>` (required)

### Response (201 Created)

```json
{
  "refundId": "uuid",
  "paymentId": "uuid",
  "amount": 50000,
  "currency": "usd",
  "status": "REFUND_PENDING",
  "triggerType": "ADMIN"
}
```

### Error Responses

| Status | Condition |
|--------|-----------|
| 400 | Invalid amount (exceeds remaining refundable amount) |
| 403 | Not admin / not authorized |
| 409 | Refund already in progress for this payment |
| 422 | Payment not in a refundable state (must be SUCCEEDED or PARTIALLY_REFUNDED) |

---

## GET /api/payments/methods

List saved payment methods for the authenticated user.

### Response (200 OK)

```json
{
  "methods": [
    {
      "id": "uuid",
      "stripePaymentMethodId": "pm_xxx",
      "cardBrand": "visa",
      "cardLast4": "4242",
      "isDefault": true
    }
  ],
  "hasStripeCustomer": true
}
```

---

## DELETE /api/payments/methods/:methodId

Remove a saved payment method.

### Response (204 No Content)

### Error Responses

| Status | Condition |
|--------|-----------|
| 403 | Payment method belongs to another user |
| 404 | Payment method not found |
