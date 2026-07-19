# Phase 3: Payment Pipeline Integration

- [ ] T011 [US5] Add `bookingId` field to [confirm-payment.dto.ts](file:///c:/Booking%20Systems/apps/api/src/payment/dto/confirm-payment.dto.ts)
- [ ] T012 [US5] Implement UUID format validation and user ownership checks in [payment.service.ts](file:///c:/Booking%20Systems/apps/api/src/payment/payment.service.ts)
- [ ] T013 [US5] Implement concurrency/idempotency collision resolution for `id` and `bookingIntentId` in [payment.service.ts](file:///c:/Booking%20Systems/apps/api/src/payment/payment.service.ts)
- [ ] T014 [US5] Insert `BookingService.createBooking` with `PROCESSING` status as the first step of the confirm pipeline in [payment.service.ts](file:///c:/Booking%20Systems/apps/api/src/payment/payment.service.ts)
- [ ] T015 [US1] [US2] [US6] Update booking to `CONFIRMED` on pipeline success and `FAILED` on pipeline failure (mapping errors to failure reason) in [payment.service.ts](file:///c:/Booking%20Systems/apps/api/src/payment/payment.service.ts)
- [ ] T016 [US1] Implement stale `PROCESSING` booking cleanup and background sweeper cron in [booking.service.ts](file:///c:/Booking%20Systems/apps/api/src/booking/booking.service.ts)
