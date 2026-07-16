# Tasks: Stripe Payment System — PR 2 (Core Payment Pipeline)

- [ ] Phase 5: Core Payment Pipeline (Create + Authorize)
  - [ ] T001 Create `CreatePaymentDto` in `apps/api/src/payment/dto/create-payment.dto.ts`
  - [ ] T002 Create `PaymentResponseDto` in `apps/api/src/payment/dto/payment-response.dto.ts`
  - [ ] T003 Implement `createPayment()` in `apps/api/src/payment/payment.service.ts` with pessimistic claim lock on BookingIntent, lazy Customer creation, and retrieval-based reconciliation
  - [ ] T004 Create `POST /api/payments/create` endpoint in `apps/api/src/payment/payment.controller.ts`
  - [ ] T005 Add structured audit logging for `payment_created` event
  
- [ ] Phase 6: Core Payment Pipeline (Confirm + Capture)
  - [ ] T006 Create `ConfirmPaymentDto` in `apps/api/src/payment/dto/confirm-payment.dto.ts`
  - [ ] T007 Implement `confirmPayment()` in `apps/api/src/payment/payment.service.ts` (handle recovery points, Duffel PNR creation, Stripe capture, ledger entries, and post-capture reconciliation)
  - [ ] T008 Implement Duffel PNR integration with 30s timeout mapping
  - [ ] T009 Implement tiered timeout logic (0-30s synchronous, 30s-1min 202 Accepted + poll URL)
  - [ ] T010 Implement authorization void on Duffel failure (Stripe PaymentIntent cancel)
  - [ ] T011 Create `GET /api/payments/:paymentId/status` polling endpoint in `apps/api/src/payment/payment.controller.ts`
  - [ ] T012 Add `POST /api/payments/confirm` in `apps/api/src/payment/payment.controller.ts`
  - [ ] T013 Create ledger entries on successful capture (DEBIT CUSTOMER_RECEIVABLE, CREDIT PLATFORM_REVENUE)
  - [ ] T014 Add audit logging for `payment_authorized`, `payment_captured`, `booking_confirmed`
