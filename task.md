# Tasks: Stripe Payment System — PR 2 (Core Payment Pipeline)

- [X] Phase 5: Core Payment Pipeline (Create + Authorize)
  - [X] T001 Create `CreatePaymentDto` in `apps/api/src/payment/dto/create-payment.dto.ts`
  - [X] T002 Create `PaymentResponseDto` in `apps/api/src/payment/dto/payment-response.dto.ts`
  - [X] T003 Implement `createPayment()` in `apps/api/src/payment/payment.service.ts` with pessimistic claim lock on BookingIntent, lazy Customer creation, and retrieval-based reconciliation
  - [X] T004 Create `POST /api/payments/create` endpoint in `apps/api/src/payment/payment.controller.ts`
  - [X] T005 Add structured audit logging for `payment_created` event
  
- [X] Phase 6: Core Payment Pipeline (Confirm + Capture)
  - [X] T006 Create `ConfirmPaymentDto` in `apps/api/src/payment/dto/confirm-payment.dto.ts`
  - [X] T007 Implement `confirmPayment()` in `apps/api/src/payment/payment.service.ts` (handle recovery points, Duffel PNR creation, Stripe capture, ledger entries, and post-capture reconciliation)
  - [X] T008 Implement Duffel PNR integration with 30s timeout mapping
  - [X] T009 Implement tiered timeout logic (0-30s synchronous, 30s-1min 202 Accepted + poll URL)
  - [X] T010 Implement authorization void on Duffel failure (Stripe PaymentIntent cancel)
  - [X] T011 Create `GET /api/payments/:paymentId/status` polling endpoint in `apps/api/src/payment/payment.controller.ts`
  - [X] T012 Add `POST /api/payments/confirm` in `apps/api/src/payment/payment.controller.ts`
  - [X] T013 Create ledger entries on successful capture (DEBIT CUSTOMER_RECEIVABLE, CREDIT PLATFORM_REVENUE)
  - [X] T014 Add audit logging for `payment_authorized`, `payment_captured`, `booking_confirmed`
