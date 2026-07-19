# Phase 2: Booking Service & REST API

- [ ] T006 [P] [US3] [US4] [US5] [US6] Create NestJS `BookingModule` definition in [booking.module.ts](apps/api/src/booking/booking.module.ts)
- [ ] T007 [US3] [US4] [US5] [US6] Create NestJS `BookingService` base CRUD in [booking.service.ts](apps/api/src/booking/booking.service.ts) (depends on T006)
- [ ] T008 [US3] [US4] Implement `listBookings` and `getBookingDetail` queries in [booking.service.ts](apps/api/src/booking/booking.service.ts) (depends on T007)
- [ ] T009 [P] [US3] [US4] Implement DTOs for paginated list query and responses in [dto/](apps/api/src/booking/dto/) (depends on T006)
- [ ] T010 [P] [US3] [US4] Create `BookingController` exposing list and detail endpoints in [booking.controller.ts](apps/api/src/booking/booking.controller.ts) (depends on T006)
- [ ] T011 [US3] [US4] [US5] [US6] Register `BookingModule` in [app.module.ts](apps/api/src/app.module.ts) (depends on T006)
