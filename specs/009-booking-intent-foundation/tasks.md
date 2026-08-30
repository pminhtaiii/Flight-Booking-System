# Tasks: Booking Intent Foundation (Feature 009)

## Phase 1: Database Schema & Encryption Foundation

- [x] T001 Add `BookingIntentStatus` and `PassengerType` enums to `apps/api/prisma/schema.prisma`
- [x] T002 Add `BookingIntent` model to `apps/api/prisma/schema.prisma`
- [x] T003 Add `BookingIntentPassenger` model to `apps/api/prisma/schema.prisma`
- [x] T004 Add back-relations on `User` and `TravelerProfile` in `apps/api/prisma/schema.prisma`
- [x] T005 Apply Prisma migration and verify generated types
- [x] T006 Create `apps/api/src/common/encryption.service.ts` (AES-256-GCM)
- [x] T007 Add shared enums in `packages/shared/src/types/booking-intent.types.ts`

## Phase 2: BookingIntentModule Core Service & DTOs

- [x] T008 Create `apps/api/src/booking-intent/dto/create-intent.dto.ts`
- [x] T009 Create `apps/api/src/booking-intent/dto/intent-response.dto.ts`
- [x] T010 Create `apps/api/src/booking-intent/booking-intent.service.ts`
- [x] T011 Implement TravelerProfile pre-fill for primary passenger in booking intent service
- [x] T012 Implement Duffel re-pricing with bounded timeout and explicit error mapping
- [x] T013 Create `apps/api/src/booking-intent/booking-intent.controller.ts` with
      `POST /bookings/intent`, `GET /bookings/intent/:id`, and `GET /bookings/intent/prefill`
- [x] T014 Create `apps/api/src/booking-intent/booking-intent.module.ts` and register it in `apps/api/src/app.module.ts`
- [x] T015 Add audit logging for `booking_intent_created` inside intent creation transaction

## Phase 3: Two-Phase Cron Cleanup

- [x] T016 Create `apps/api/src/booking-intent/booking-intent.cron.ts`
- [x] T017 Implement Phase 1 cron: `PENDING` -> `EXPIRED`
- [x] T018 Implement Phase 2 cron: hard-delete expired intents after grace period
- [x] T019 Add structured cron logging and audit events (`booking_intent_expired`, `booking_intent_deleted`)

## Phase 4: E2E Testing & Verification

- [x] T020 Add `apps/api/test/booking-intent.e2e-spec.ts`
- [x] T021 Add creation/retrieval/ownership/validation E2E coverage
- [x] T022 Add pre-fill endpoint E2E coverage
- [x] T023 Add Duffel failure and `duffelOfferId` override regression E2E coverage
- [x] T024 Add cron lifecycle E2E coverage and non-default TTL/grace validation
- [x] T025 Run full backend E2E regression suite and fix regressions
