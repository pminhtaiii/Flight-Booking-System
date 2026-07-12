# Tasks: Stripe Payment System

**Input**: Design documents from `/specs/010-stripe-payment-system/`

**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Database Schema & Enums)

**Purpose**: Database tables and enums definition, migrations

- [x] T001 Add `PaymentStatus`, `RefundStatus`, `RefundTriggerType`, `LedgerEntryType`, `PaymentEventSource` enums to `apps/api/prisma/schema.prisma`
- [x] T002 Extend `BookingIntentStatus` enum with `AWAITING_PAYMENT`, `PAYMENT_EXHAUSTED`, `CANCELLED` in `apps/api/prisma/schema.prisma`
- [x] T003 Add `Payment` model to `apps/api/prisma/schema.prisma`
- [x] T004 Add `IdempotencyKey` model to `apps/api/prisma/schema.prisma`
- [x] T005 Add `PaymentEvent` model to `apps/api/prisma/schema.prisma`
- [x] T006 Add `LedgerEntry` model to `apps/api/prisma/schema.prisma`
- [x] T007 Add `Refund` model to `apps/api/prisma/schema.prisma`
- [x] T008 Add `PaymentMethod` model to `apps/api/prisma/schema.prisma`
- [x] T009 Add `stripeCustomerId` to `User` model and setup relations in `apps/api/prisma/schema.prisma`
- [x] T010 Add `paymentAttemptCount` to `BookingIntent` model and setup relations in `apps/api/prisma/schema.prisma`
- [x] T011 Run `npx prisma migrate dev` and verify Prisma client types
- [x] T012 Add shared types to `packages/shared/src/types/payment.types.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Stripe SDK integration, FSM, and Idempotency infrastructure

- [x] T013 Create `apps/api/src/common/stripe.service.ts` for Stripe SDK initialization and signature checks
- [x] T014 Implement Stripe helper methods (createPaymentIntent, capturePaymentIntent, cancelPaymentIntent, createCustomer, retrievePaymentIntent, createRefund, constructWebhookEvent) in `apps/api/src/common/stripe.service.ts`
- [x] T015 Create `apps/api/src/payment/payment-state-machine.ts` with FSM validation transitions
- [x] T016 [P] Write unit tests for FSM transitions in `apps/api/src/payment/payment-state-machine.spec.ts`
- [x] T017 Create `apps/api/src/payment/payment-idempotency.service.ts` to manage request hashes and recovery points
- [x] T018 [P] Implement custom decorator `@IdempotencyKey()` in `apps/api/src/payment/idempotency-key.decorator.ts`

---

## Phase 3: User Story 1 - One-Time Payment for Flight Booking (Priority: P1) 🎯 MVP

**Goal**: Support authorizing card details, creating Duffel PNR, and capturing payment.

**Independent Test**: Create BookingIntent, call create and confirm API endpoints with Stripe test card, check status COMPLETED.

### Tests for User Story 1 (TDD)
- [ ] T019 [US1] Create happy path and edge-case integration tests in `apps/api/test/payment.e2e-spec.ts` (write first to fail)

### Implementation for User Story 1
- [ ] T020 [P] [US1] Create request and response DTOs in `apps/api/src/payment/dto/` (`create-payment.dto.ts`, `confirm-payment.dto.ts`, `payment-response.dto.ts`)
- [ ] T021 [US1] Create core `apps/api/src/payment/payment.service.ts` with `createPayment()` and `confirmPayment()` pipeline
- [ ] T022 [US1] Integrate Duffel PNR creation and authorization voiding on failure in `apps/api/src/payment/payment.service.ts`
- [ ] T023 [US1] Implement `apps/api/src/payment/payment-ledger.service.ts` to record double-entry entries
- [ ] T024 [US1] Create REST controller `apps/api/src/payment/payment.controller.ts` with POST and GET endpoints
- [ ] T025 [US1] Define `apps/api/src/payment/payment.module.ts` and register in `apps/api/src/app.module.ts`

---

## Phase 4: User Story 2 - Webhook-Driven Payment Status Updates (Priority: P1)

**Goal**: Stripe webhooks drive payment status with deduplication and self-healing.

**Independent Test**: POST mock webhook events to `/api/payments/webhook` and verify FSM updates.

### Tests for User Story 2 (TDD)
- [ ] T026 [US2] Create webhook integration and self-healing tests in `apps/api/test/payment-webhook.e2e-spec.ts` (write first to fail)

### Implementation for User Story 2
- [ ] T027 [P] [US2] Create webhook controller `apps/api/src/payment/payment-webhook.controller.ts`
- [ ] T028 [US2] Implement webhook routing, deduplication, and status updater in `apps/api/src/payment/payment-webhook.service.ts`
- [ ] T029 [US2] Implement webhook Tier 1 self-healing and Tier 2 alert + drop in `apps/api/src/payment/payment-webhook.service.ts`

---

## Phase 5: User Story 3 - Retry Payment (Second Attempt) (Priority: P2)

**Goal**: Allow a second payment attempt on a failed payment, block a third.

**Independent Test**: Force payment 1 fail, run payment 2 success, verify block on payment 3.

### Tests for User Story 3 (TDD)
- [ ] T030 [US3] Add retry and attempt block tests to `apps/api/test/payment.e2e-spec.ts` (write first to fail)

### Implementation for User Story 3
- [ ] T031 [US3] Implement attempt count checks and pessimistic locking in `apps/api/src/payment/payment.service.ts`

---

## Phase 6: User Story 4 - Save Payment Method for Reuse (Priority: P2)

**Goal**: Save card details during checkout with consent, reuse saved card.

**Independent Test**: Pay with save consent, check saved method endpoint, pay again using method ID.

### Tests for User Story 4 (TDD)
- [ ] T032 [US4] Create saved card integration tests in `apps/api/test/payment-method.e2e-spec.ts` (write first to fail)

### Implementation for User Story 4
- [ ] T033 [US4] Create `apps/api/src/payment/payment-method.service.ts` to manage saved methods
- [ ] T034 [US4] Integrate customer creation and setup_future_usage in `apps/api/src/payment/payment.service.ts` and add endpoints to `apps/api/src/payment/payment.controller.ts`

---

## Phase 7: User Story 5 - System-Error Refund (Priority: P2)

**Goal**: Support manual admin refunds and automated system-error refunds.

**Independent Test**: Call refund endpoint, verify refund pending -> succeeded, check reversing ledger entries.

### Tests for User Story 5 (TDD)
- [ ] T035 [US5] Create refund integration and automated refund tests in `apps/api/test/payment-refund.e2e-spec.ts` (write first to fail)

### Implementation for User Story 5
- [ ] T036 [US5] Create `apps/api/src/payment/payment-refund.service.ts` with refund triggers
- [ ] T037 [US5] Add `charge.refunded` webhook handler to `apps/api/src/payment/payment-webhook.service.ts` and write ledger reversing entries

---

## Phase 8: User Story 6 - Dispute Handling (Priority: P3)

**Goal**: Track dispute creations and resolutions in FSM.

**Independent Test**: Mock dispute webhooks, check state DISPUTED, verify won/lost flows.

### Tests for User Story 6 (TDD)
- [ ] T038 [US6] Add dispute webhook tests to `apps/api/test/payment-webhook.e2e-spec.ts` (write first to fail)

### Implementation for User Story 6
- [ ] T039 [US6] Implement `charge.dispute.created` and `charge.dispute.closed` handlers in `apps/api/src/payment/payment-webhook.service.ts`

---

## Phase 9: User Story 7 - Idempotent Pipeline Execution with Recovery Points (Priority: P3)

**Goal**: Resume payment flow from last recovery checkpoint on failure/retry.

**Independent Test**: Mock crash after authorize, retry same key, verify resumes at Duffel PNR step.

### Tests for User Story 7 (TDD)
- [ ] T040 [US7] Create crash resumption and cache-reply E2E tests in `apps/api/test/payment-idempotency.e2e-spec.ts` (write first to fail)

---

## Phase 10: User Story 8 - Double-Entry Ledger Tracking (Priority: P3)

**Goal**: Record paired debit/credit transactions for financial audits.

**Independent Test**: Verify total debits = credits per transaction ID in database.

### Tests for User Story 8 (TDD)
- [ ] T041 [US8] Add ledger debit/credit matching checks in `apps/api/test/payment.e2e-spec.ts` (write first to fail)

---

## Phase 11: Polish & Cross-Cutting Concerns

**Purpose**: Cleanup, schedule cron jobs, documentation

- [ ] T042 Create `apps/api/src/payment/payment-cron.service.ts` with cron jobs for expired holds, stale locks, and key TTLs
- [ ] T043 Update architecture and progress check files in `context/`
- [ ] T044 Run all tests across workspaces to ensure no regressions
- [ ] T045 Run quickstart.md validation

---

## Dependencies & Execution Order

- **Phase 1 (Schema)**: No dependencies - must run first.
- **Phase 2 (Foundational)**: Depends on Phase 1 completion.
- **Phase 3 (User Story 1 - MVP)**: Depends on Phase 2 completion.
- **Phase 4 (User Story 2)**: Depends on Phase 3 completion (requires core payment service).
- **Phases 5 to 10 (Stories 3 to 8)**: Depend on Phase 3 and Phase 4 completion.
- **Phase 11 (Polish)**: Depends on all user story completions.
