# Tasks: Restoring the Checkout Foundation (Phase 0 / PR 1)

**Input**: Design documents from `specs/015a-ancillary-seat-baggage-checkout/`

**Prerequisites**: plan.md, spec.md, contracts/api.md

## Phase 1: Setup

- [x] T001 Define checkout feature flag `NEXT_PUBLIC_FEATURE_FLAG_CHECKOUT` defaulting to enabled (true) unless set to false

## Phase 2: Foundational (Next.js Protected Shells)

- [x] T002 Implement checkout route protection helper using `getServerSession(authOptions)` in `apps/web/lib/checkout.ts`
- [x] T003 [P] Create protected page shell for `/checkout/passengers` in `apps/web/app/checkout/passengers/page.tsx`
- [x] T004 [P] Create protected page shell for `/checkout/[intentId]/ancillaries` in `apps/web/app/checkout/[intentId]/ancillaries/page.tsx`
- [x] T005 [P] Create protected page shell for `/checkout/[intentId]/review` in `apps/web/app/checkout/[intentId]/review/page.tsx`
- [x] T006 [P] Create protected page shell for `/checkout/[intentId]/payment` in `apps/web/app/checkout/[intentId]/payment/page.tsx`

## Phase 3: User Story 1 — Search Entry & Navigation (US1)

**Goal**: Establish real search listing with CTAs mapping to `/checkout/passengers?offerId=...`

- [x] T007 [US1] Create simple search form page in `apps/web/app/search/page.tsx`
- [x] T008 [US1] Add a search results display list with "Book" button navigating to `/checkout/passengers?offerId=...` in `apps/web/app/search/page.tsx`

## Phase 4: User Story 2 — Passenger Details Collection (US2)

**Goal**: Collect passenger data, enforce domestic/international requirements, and create BookingIntent

- [x] T009 [US2] Implement prefill fetch from `/api/bookings/intent/prefill` in `apps/web/app/checkout/passengers/page.tsx`
- [x] T010 [US2] Check if route is international by looking up segment countries in `apps/web/app/checkout/passengers/page.tsx`
- [x] T011 [US2] Implement passenger form client component `apps/web/components/checkout/PassengerFormClient.tsx`
- [x] T012 [US2] Add client-side validation for traveler DOB, gender, and conditional passport fields in `apps/web/components/checkout/PassengerFormClient.tsx`
- [x] T013 [US2] Submit passenger details to `POST /api/bookings/intent` and redirect to `/checkout/[intentId]/ancillaries` in `apps/web/components/checkout/PassengerFormClient.tsx`

## Phase 5: User Story 3 — Ancillary Placeholder & Checkout Verification (US3)

**Goal**: Verify intent ownership and render passenger/flight context placeholder on `/checkout/[intentId]/ancillaries`

- [x] T014 [US3] Verify BookingIntent ownership with backend `GET /api/bookings/intent/:intentId` in `apps/web/app/checkout/[intentId]/ancillaries/page.tsx`
- [x] T015 [US3] Safely render intent and passenger details on the ancillaries placeholder page in `apps/web/app/checkout/[intentId]/ancillaries/page.tsx`
- [x] T016 [US3] Add placeholder cards for seat selection and baggage selection steps in `apps/web/app/checkout/[intentId]/ancillaries/page.tsx`
- [x] T017 [US3] Add navigation rules to review and payment steps in `/checkout/[intentId]/review` and `/checkout/[intentId]/payment` page components

## Phase 6: Polish & E2E Validation

- [x] T018 Run Next.js and NestJS build and type check
- [x] T019 Write and execute backend unit tests for session/ownership and API errors
- [x] T020 Write and execute Playwright tests in `apps/web/tests/checkout-foundation.spec.ts`
- [x] T021 Run `graphify update .` to keep graph current
- [x] T022 Clean git status and ensure no `graphify-out` files are staged/committed
- [x] T023 Update context files `context/architecture.md` and `context/progress-checker.md`

## Phase 7: Phase 1 / PR 2 — Shared Contracts, State Repair, Additive Schema, and Migration

- [x] T024 Define and export normalized ancillary catalog, selection, pricing, and error contracts in `packages/shared/src/types/ancillary.types.ts`
- [x] T025 Add append-only ancillary snapshot, seat, baggage, coverage, and payment-binding models to `apps/api/prisma/schema.prisma`
- [x] T026 Add the additive ancillary checkout Prisma migration with snapshot/payment constraints and foreign keys
- [x] T027 Persist Duffel passenger IDs on newly created BookingIntent passengers using deterministic type-and-ordinal matching
- [x] T028 Repair PaymentService eligibility to use the persisted `PENDING` BookingIntent status rather than the nonexistent `CREATED` status
- [x] T029 Add focused regression coverage for supplier passenger mapping and the repaired payment eligibility path
- [x] T030 Validate the Prisma schema and whitespace correctness with the local toolchain
- [ ] T031 Run focused Jest/type-check verification after workspace dependency links are restored
- [x] T032 Update Feature 15 architecture and progress documentation

## Phase 11: Phase 5 / PR 6 — Authoritative Validation, Payment Amount, and Duffel Order Services

- [x] T042 Add an additive short-lived validation lease token/expiry to ancillary snapshots without changing the four durable selection states
- [x] T043 Invoke authoritative ancillary validation at the public payment-create boundary before idempotency acquisition, payment-attempt mutation, `AWAITING_PAYMENT`, customer creation, or Stripe
- [x] T044 Acquire the exact owned active current selection ID/version through a short CAS lease, reprice once outside database transactions, and conditionally persist authoritative `VALIDATED` totals only while the same lease still owns the snapshot
- [x] T045 Return targeted version/service/price/currency conflicts and mark only the lease-owned unbound current snapshot `STALE` when supplier validation invalidates it
- [x] T046 Reject ancillary commits while the current snapshot has an active validation lease; expired leases cease blocking edits
- [ ] T047 Extend payment creation with optional-together ancillary selection identity while preserving empty-selection/base-fare compatibility
- [ ] T048 Bind Payment and `PAYMENT_BOUND` snapshot atomically, convert authoritative major units to minor units exactly, and persist PII-safe selection metadata
- [ ] T049 Load exact canonical services through the Payment-bound snapshot for Duffel order creation and every recovery point
- [ ] T050 Preserve authorization, supplier-order, capture, cancellation, compensation, and idempotent recovery behavior for ancillary-bound payments
- [ ] T051 Add focused unit/integration/E2E coverage for validation races, targeted conflicts, exact amounts/services, retries, and empty-selection regressions
- [ ] T052 Run Prisma validation, API typecheck/lint/build, focused and regression payment suites, and migration verification
- [ ] T053 Synchronize Phase 5 implementation facts in architecture and progress documentation after verification
