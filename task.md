# Tasks: Stripe Payment System — PR 5 (Polish & E2E Testing)

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

- [X] Phase 7: Webhook Processing
  - [X] T015 Create webhook controller in `apps/api/src/payment/payment-webhook.controller.ts` with raw body parsing and signature verification
  - [X] T016 Create webhook service in `apps/api/src/payment/payment-webhook.service.ts` to route events
  - [X] T017 Implement webhook event deduplication using `PaymentEvent` table
  - [X] T018 Implement `payment_intent.succeeded` event handler (update status, append event)
  - [X] T019 Implement `payment_intent.payment_failed` event handler (status to FAILED)
  - [X] T020 Implement `payment_intent.canceled` event handler (status to CANCELLED)
  - [X] T021 Implement Tier 1 self-healing reconciliation (retrieve payment intent, fast-forward)
  - [X] T022 Implement Tier 2 alert + drop for irreconcilable transitions
  - [X] T023 Add structured logging for processed webhook events

- [X] Phase 8: Refund System
  - [X] T024 Create `RefundPaymentDto` in `apps/api/src/payment/dto/refund-payment.dto.ts`
  - [X] T025 Create refund service in `apps/api/src/payment/payment-refund.service.ts`
  - [X] T026 Implement `initiateRefund()` in `payment-refund.service.ts` (validate state, call Stripe refunds, update status, append event)
  - [X] T027 Implement automated refund trigger on detected errors (over-capture or other invariants violation)
  - [X] T028 Implement `charge.refunded` webhook handler (reversing ledger entries, update Refund status)
  - [X] T029 Implement partial refund tracking and refund looping
  - [X] T030 Add `POST /api/payments/:paymentId/refund` in `apps/api/src/payment/payment.controller.ts` with Admin role guard
  - [X] T031 Add audit logging for `refund_initiated` and `refund_completed` events
  
- [X] Phase 9: Dispute Handling
  - [X] T032 Implement `charge.dispute.created` webhook handler (store `pre_dispute_status`, status to DISPUTED)
  - [X] T033 Implement `charge.dispute.closed` webhook handler (restore pre-dispute on win, to CHARGEBACK_LOST on loss)
  - [X] T034 Handle dispute on already-refunded payment
  - [X] T035 Add audit logging for dispute lifecycle events

- [ ] Phase 10: Saved Payment Methods
  - [ ] T036 Create `PaymentMethodService` in `apps/api/src/payment/payment-method.service.ts`
  - [ ] T037 Implement `listMethods()` and `saveMethods()` (sync attached methods after payment success with consent)
  - [ ] T038 Implement `deleteMethod()` and `setDefault()` methods
  - [ ] T039 Add endpoints `GET /api/payments/methods`, `DELETE /api/payments/methods/:methodId` in `payment.controller.ts`
  - [ ] T040 Integrate saved method selection into `createPayment()` service method
  
- [ ] Phase 11: Cron Jobs — Authorization Expiry & Cleanup
  - [ ] T041 Create cron handler in `apps/api/src/payment/payment-cron.service.ts`
  - [ ] T042 Implement stale key cleanup (delete expired idempotency keys)
  - [ ] T043 Implement expired authorization checker (void locks/authorized hold if expired)
  - [ ] T044 Implement stale lock detection for idempotency keys
  - [ ] T045 Register ScheduleModule if not already registered
  - [ ] T046 Add structured logging for cron runs
  
- [ ] Phase 12: End-to-End Testing
  - [ ] T047 Write backend NestJS E2E integration tests in `apps/api/test/payment.e2e-spec.ts`
  - [ ] T048 Write backend webhook E2E tests in `apps/api/test/payment-webhook.e2e-spec.ts`
  - [ ] T049 Write backend refund E2E tests in `apps/api/test/payment-refund.e2e-spec.ts`
  - [ ] T050 Write backend idempotency E2E tests in `apps/api/test/payment-idempotency.e2e-spec.ts`
