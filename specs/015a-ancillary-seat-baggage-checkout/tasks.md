# Tasks: Restoring the Checkout Foundation (Phase 0 / PR 1)

**Input**: Design documents from `specs/015a-ancillary-seat-baggage-checkout/`

**Prerequisites**: plan.md, spec.md, contracts/api.md

## Phase 1: Setup

- [ ] T001 Configure checkout feature flag `NEXT_PUBLIC_FEATURE_FLAG_CHECKOUT` in `apps/web/.env.local`

## Phase 2: Foundational (Next.js Protected Shells)

- [ ] T002 Implement checkout route protection helper using `getServerSession(authOptions)` in `apps/web/lib/checkout.ts`
- [ ] T003 [P] Create protected page shell for `/checkout/passengers` in `apps/web/app/checkout/passengers/page.tsx`
- [ ] T004 [P] Create protected page shell for `/checkout/[intentId]/ancillaries` in `apps/web/app/checkout/[intentId]/ancillaries/page.tsx`
- [ ] T005 [P] Create protected page shell for `/checkout/[intentId]/review` in `apps/web/app/checkout/[intentId]/review/page.tsx`
- [ ] T006 [P] Create protected page shell for `/checkout/[intentId]/payment` in `apps/web/app/checkout/[intentId]/payment/page.tsx`

## Phase 3: User Story 1 — Search Entry & Navigation (US1)

**Goal**: Establish real search listing with CTAs mapping to `/checkout/passengers?offerId=...`

- [ ] T007 [US1] Create simple search form page in `apps/web/app/search/page.tsx`
- [ ] T008 [US1] Add a search results display list with "Book" button navigating to `/checkout/passengers?offerId=...` in `apps/web/app/search/page.tsx`

## Phase 4: User Story 2 — Passenger Details Collection (US2)

**Goal**: Collect passenger data, enforce domestic/international requirements, and create BookingIntent

- [ ] T009 [US2] Implement prefill fetch from `/api/bookings/intent/prefill` in `apps/web/app/checkout/passengers/page.tsx`
- [ ] T010 [US2] Check if route is international by looking up segment countries in `apps/web/app/checkout/passengers/page.tsx`
- [ ] T011 [US2] Implement passenger form client component `apps/web/components/checkout/PassengerFormClient.tsx`
- [ ] T012 [US2] Add client-side validation for traveler DOB, gender, and conditional passport fields in `apps/web/components/checkout/PassengerFormClient.tsx`
- [ ] T013 [US2] Submit passenger details to `POST /api/bookings/intent` and redirect to `/checkout/[intentId]/ancillaries` in `apps/web/components/checkout/PassengerFormClient.tsx`

## Phase 5: User Story 3 — Ancillary Placeholder & Checkout Verification (US3)

**Goal**: Verify intent ownership and render passenger/flight context placeholder on `/checkout/[intentId]/ancillaries`

- [ ] T014 [US3] Verify BookingIntent ownership with backend `GET /api/bookings/intent/:intentId` in `apps/web/app/checkout/[intentId]/ancillaries/page.tsx`
- [ ] T015 [US3] Safely render intent and passenger details on the ancillaries placeholder page in `apps/web/app/checkout/[intentId]/ancillaries/page.tsx`
- [ ] T016 [US3] Add placeholder cards for seat selection and baggage selection steps in `apps/web/app/checkout/[intentId]/ancillaries/page.tsx`
- [ ] T017 [US3] Add navigation rules to review and payment steps in `/checkout/[intentId]/review` and `/checkout/[intentId]/payment` page components

## Phase 6: Polish & E2E Validation

- [ ] T018 Run Next.js and NestJS build and type check
- [ ] T019 Write and execute backend unit tests for session/ownership and API errors
- [ ] T020 Write and execute Playwright tests in `apps/web/tests/checkout-foundation.spec.ts`
- [ ] T021 Run `graphify update .` to keep graph current
- [ ] T022 Clean git status and ensure no `graphify-out` files are staged/committed
- [ ] T023 Update context files `context/architecture.md` and `context/progress-checker.md`
