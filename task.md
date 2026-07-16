# Tasks: Stripe Payment System — PR 3 (Webhook Processing)

- [ ] Phase 7: Webhook Processing
  - [ ] T001 Create webhook controller in `apps/api/src/payment/payment-webhook.controller.ts` with raw body parsing and signature verification
  - [ ] T002 Create webhook service in `apps/api/src/payment/payment-webhook.service.ts` to route events
  - [ ] T003 Implement webhook event deduplication using `PaymentEvent` table
  - [ ] T004 Implement `payment_intent.succeeded` event handler (update status, append event)
  - [ ] T005 Implement `payment_intent.payment_failed` event handler (status to FAILED)
  - [ ] T006 Implement `payment_intent.canceled` event handler (status to CANCELLED)
  - [ ] T007 Implement Tier 1 self-healing reconciliation (retrieve payment intent, fast-forward)
  - [ ] T008 Implement Tier 2 alert + drop for irreconcilable transitions
  - [ ] T009 Add structured logging for processed webhook events
