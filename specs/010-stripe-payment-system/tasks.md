# Tasks: Stripe Payment System — PR 1 (Payment Foundation)

**Input**: Design documents from `/specs/010-stripe-payment-system/`

**Prerequisites**: plan.md (required), spec.md (required), data-model.md, contracts/

**Scope**: This task list strictly covers **PR 1: Payment Foundation**. It includes all setup tasks, database schema migrations, the Stripe SDK service wrapper, the pure FSM state machine, and the request idempotency manager. Future PR scopes (Core Pipeline, Webhooks, Refunds, etc.) are excluded.

---

## Format: `[ID] [P?] Description`

- **[P]**: Can run in parallel (different files, no direct dependencies)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Branch verification and configuration variables.

- [x] T001 Set up the git branch `010a-payment-foundation` from `development`
- [ ] T002 Add `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` environment variables to `apps/api/.env` and `apps/api/.env.example`
- [ ] T003 [P] Configure environment validation schema check in NestJS ConfigModule registration in `apps/api/src/app.module.ts`

---

## Phase 2: Foundational (PR 1: Payment Foundation)

**Purpose**: Prisma schema updates, migrations, custom Stripe SDK service, finite state machine validator, and request idempotency locking.

### Database Schema & Types

- [ ] T004 Add payment enums (`PaymentStatus`, `RefundStatus`, `RefundTriggerType`, `LedgerEntryType`, `PaymentEventSource`) to `apps/api/prisma/schema.prisma`
- [ ] T005 Add `Payment`, `IdempotencyKey`, `PaymentEvent`, `LedgerEntry`, `Refund`, and `PaymentMethod` models to `apps/api/prisma/schema.prisma`
- [ ] T006 Extend existing `User` and `BookingIntent` models with payment fields and relations in `apps/api/prisma/schema.prisma`
- [ ] T007 Run Prisma migration `npx prisma migrate dev --name init_payment_system` and generate types
- [ ] T008 [P] Define shared payment types and status enums in `packages/shared/src/types/payment.types.ts`

### Stripe SDK Wrapper

- [ ] T009 Create `StripeService` wrapper class in `apps/api/src/common/stripe.service.ts`
- [ ] T010 Implement client initialization and core wrapper methods (`createPaymentIntent`, `capturePaymentIntent`, `cancelPaymentIntent`, `createCustomer`, `retrievePaymentIntent`, `createRefund`, `constructWebhookEvent`) in `apps/api/src/common/stripe.service.ts`

### Payment State Machine

- [ ] T011 Create `PaymentStateMachine` helper with pure function `canTransition` and state transitions mapper in `apps/api/src/payment/payment-state-machine.ts`
- [ ] T012 Implement transition enforcement error checks and dispute helpers (`getPreDisputeStatus`, `resolveDisputeStatus`) in `apps/api/src/payment/payment-state-machine.ts`
- [ ] T013 [P] Add state machine unit tests covering all valid/invalid transitions in `apps/api/src/payment/payment-state-machine.spec.ts`

### Idempotency Key Service

- [ ] T014 Create idempotency decorator `@IdempotencyKey()` and header extractor in `apps/api/src/payment/payment-idempotency.service.ts`
- [ ] T015 Implement `acquireOrReplay`, `updateRecoveryPoint`, `completeKey`, `getResumePoint`, and `isLocked` in `apps/api/src/payment/payment-idempotency.service.ts`

---

## Parallel Opportunities (Within PR 1)

- **Stripe Service wrapper** and **Payment State Machine** can be implemented concurrently by separate processes once the database schema migration (`T007`) runs.
- **Idempotency Key Service** can be worked on in parallel with the **Payment State Machine**.
