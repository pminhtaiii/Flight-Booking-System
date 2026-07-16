# Tasks: Stripe Payment System — PR 4 (Refunds & Disputes)

- [ ] Phase 8: Refund System
  - [ ] T001 Create `RefundPaymentDto` in `apps/api/src/payment/dto/refund-payment.dto.ts`
  - [ ] T002 Create refund service in `apps/api/src/payment/payment-refund.service.ts`
  - [ ] T003 Implement `initiateRefund()` in `payment-refund.service.ts` (validate state, call Stripe refunds, update status, append event)
  - [ ] T004 Implement automated refund trigger on detected errors (over-capture or other invariants violation)
  - [ ] T005 Implement `charge.refunded` webhook handler (reversing ledger entries, update Refund status)
  - [ ] T006 Implement partial refund tracking and refund looping
  - [ ] T007 Add `POST /api/payments/:paymentId/refund` in `apps/api/src/payment/payment.controller.ts` with Admin role guard
  - [ ] T008 Add audit logging for `refund_initiated` and `refund_completed` events
  
- [ ] Phase 9: Dispute Handling
  - [ ] T009 Implement `charge.dispute.created` webhook handler (store `pre_dispute_status`, status to DISPUTED)
  - [ ] T010 Implement `charge.dispute.closed` webhook handler (restore pre-dispute on win, to CHARGEBACK_LOST on loss)
  - [ ] T011 Handle dispute on already-refunded payment
  - [ ] T012 Add audit logging for dispute lifecycle events
