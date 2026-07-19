# Phase 1: Database Schema & Shared Types

- [ ] T001 [US5] [US6] Define `Booking` model, `BookingStatus` enum, and `BookingFailureReason` enum in [schema.prisma](apps/api/prisma/schema.prisma)
- [ ] T002 [US5] Apply database migration and regenerate Prisma Client using `npx prisma migrate dev`
- [ ] T003 [P] [US5] Define and export `BookingStatus` enum in [booking-status.ts](packages/shared/src/booking-status.ts)
- [ ] T004 [P] [US5] Define and export `BookingFailureReason` enum in [booking-failure-reason.ts](packages/shared/src/booking-failure-reason.ts)
- [ ] T005 [P] [US5] [US6] Define and export booking DTOs and snapshots in [booking-types.ts](packages/shared/src/booking-types.ts)
