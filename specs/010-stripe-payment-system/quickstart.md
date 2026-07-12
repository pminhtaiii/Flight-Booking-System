# Quickstart: Stripe Payment System Validation

**Feature**: 010-stripe-payment-system | **Date**: 2026-07-12

---

## Prerequisites

1. Docker services running: `docker compose up -d`
2. Database migrated: `npx prisma migrate dev --schema=apps/api/prisma/schema.prisma`
3. Environment variables set in `apps/api/.env`:
   - `STRIPE_SECRET_KEY` — Stripe test mode secret key
   - `STRIPE_WEBHOOK_SECRET` — Stripe webhook signing secret (from `stripe listen`)
   - `ENCRYPTION_KEY` — existing from Feature A
   - `DATABASE_URL` — existing
4. Stripe CLI installed for webhook forwarding: `stripe listen --forward-to http://localhost:3001/api/payments/webhook`
5. Backend running: `pnpm --filter @api/backend dev`

---

## Validation Scenarios

### Scenario 1: Happy Path — Complete Payment

```bash
# 1. Create a BookingIntent (from Feature A)
curl -X POST http://localhost:3001/api/bookings/intent \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{ "flightOfferId": "<valid-id>", "passengers": [...] }'

# 2. Create a Payment
curl -X POST http://localhost:3001/api/payments/create \
  -H "Authorization: Bearer $JWT" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{ "bookingIntentId": "<intent-id>", "saveCard": false }'
# → Expect 201 with stripeClientSecret

# 3. Confirm Payment with Stripe (simulates client-side completion using Stripe.js or Stripe CLI)
# stripe payment_intents confirm <pi_xxx> --payment-method pm_card_us

# 4. Finalize Payment on Backend
curl -X POST http://localhost:3001/api/payments/confirm \
  -H "Authorization: Bearer $JWT" \
  -H "Idempotency-Key: <distinct-confirm-key>" \
  -H "Content-Type: application/json" \
  -d '{ "paymentId": "<payment-id>" }'
# → Expect 200 or 202 with status: SUCCEEDED or AUTHORIZED, pnrReference present if 200

# 4. Verify DB state
# - Payment.status = SUCCEEDED
# - BookingIntent.status = COMPLETED
# - payment_events has CREATED → AUTHORIZED → SUCCEEDED rows
# - ledger_entries has balanced DEBIT/CREDIT pair
```

### Scenario 2: Failed Payment + Retry

```bash
# 1. Create Payment
# 2. Confirm Payment with Stripe test card that declines: 4000000000000002
# → Decline occurs during Stripe confirmation step
# 3. Finalize on backend → Expect Payment.status = FAILED

# 2. Retry with new idempotency key
curl -X POST http://localhost:3001/api/payments/create \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{ "bookingIntentId": "<same-intent-id>", "saveCard": false }'
# → Expect 201 with attemptNumber: 2

# 3. Verify BookingIntent.paymentAttemptCount = 2

# 4. Try a third attempt
# → Expect 429 with PAYMENT_EXHAUSTED
```

### Scenario 3: Webhook Deduplication

```bash
# 1. Complete a payment (Scenario 1)
# 2. Resend the same webhook event via Stripe CLI:
stripe events resend evt_xxx
# 3. Verify: payment_events table does NOT have a duplicate row
# 4. Verify: API returned 200 to Stripe
```

### Scenario 4: Idempotency Key Replay

```bash
# 1. Create a payment with idempotency key "test-key-123"
# 2. Replay the exact same request with "test-key-123"
# → Expect: cached response returned, no duplicate Payment created

# 3. Replay with "test-key-123" but different body
# → Expect: 422 (key reused with different request hash)
```

### Scenario 5: Refund

```bash
# 1. Complete a payment (Scenario 1)
# 2. Trigger admin refund
curl -X POST http://localhost:3001/api/payments/<payment-id>/refund \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{ "amount": 50000, "reason": "Test refund" }'
# → Expect 201 with status: REFUND_PENDING

# 3. Wait for Stripe webhook (charge.refunded)
# → Payment.status should transition to REFUNDED
# → Ledger should have reversing entries
```

### Scenario 6: Saved Payment Method

```bash
# 1. Create payment with saveCard: true
# 2. Complete payment
# 3. List saved methods:
curl http://localhost:3001/api/payments/methods \
  -H "Authorization: Bearer $JWT"
# → Expect: method with card_brand, card_last4, is_default

# 4. Delete saved method:
curl -X DELETE http://localhost:3001/api/payments/methods/<method-id> \
  -H "Authorization: Bearer $JWT"
# → Expect: 204
```

---

## Automated Test Commands

```bash
# Backend E2E — payment tests only
npm run test:e2e --workspace=apps/api -- --testPathPattern=payment

# Full regression suite
npm run test:e2e --workspace=apps/api

# Prisma schema validation
npx prisma validate --schema=apps/api/prisma/schema.prisma
```
