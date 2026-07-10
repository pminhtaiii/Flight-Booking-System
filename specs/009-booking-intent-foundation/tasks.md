# Tasks: Booking Intent Foundation (Feature 009)

## Phase 1: Database Schema & Encryption Foundation

- [X] T001 Add `BookingIntentStatus` and `PassengerType` enums to `apps/api/prisma/schema.prisma`
- [X] T002 Add `BookingIntent` model to `apps/api/prisma/schema.prisma`
- [X] T003 Add `BookingIntentPassenger` model to `apps/api/prisma/schema.prisma`
- [X] T004 Add back-relations on `User` and `TravelerProfile` in `apps/api/prisma/schema.prisma`
- [X] T005 Apply Prisma migration and verify generated types
- [X] T006 Create `apps/api/src/common/encryption.service.ts` (AES-256-GCM)
- [X] T007 Add shared enums in `packages/shared/src/types/booking-intent.types.ts`

## Phase 2: BookingIntentModule Core Service & DTOs

- [X] T008 Create `apps/api/src/booking-intent/dto/create-intent.dto.ts`
- [X] T009 Create `apps/api/src/booking-intent/dto/intent-response.dto.ts`
- [X] T010 Create `apps/api/src/booking-intent/booking-intent.service.ts`
- [X] T011 Implement TravelerProfile pre-fill for primary passenger in booking intent service
- [X] T012 Implement Duffel re-pricing with bounded timeout and explicit error mapping
- [X] T013 Create `apps/api/src/booking-intent/booking-intent.controller.ts` with
	`POST /bookings/intent`, `GET /bookings/intent/:id`, and `GET /bookings/intent/prefill`
- [X] T014 Create `apps/api/src/booking-intent/booking-intent.module.ts` and register it in `apps/api/src/app.module.ts`
- [X] T015 Add audit logging for `booking_intent_created` inside intent creation transaction

## Phase 3: Two-Phase Cron Cleanup

- [ ] T016 Create `apps/api/src/booking-intent/booking-intent.cron.ts`
- [ ] T017 Implement Phase 1 cron: `PENDING` -> `EXPIRED`
- [ ] T018 Implement Phase 2 cron: hard-delete expired intents after grace period
- [ ] T019 Add structured cron logging and audit events (`booking_intent_expired`, `booking_intent_deleted`)

## Phase 4: E2E Testing & Verification

- [ ] T020 Add `apps/api/test/booking-intent.e2e-spec.ts`
- [ ] T021 Add creation/retrieval/ownership/validation E2E coverage
- [ ] T022 Add pre-fill endpoint E2E coverage
- [ ] T023 Add Duffel failure and `duffelOfferId` override regression E2E coverage
- [ ] T024 Add cron lifecycle E2E coverage and non-default TTL/grace validation
- [ ] T025 Run full backend E2E regression suite and fix regressions
