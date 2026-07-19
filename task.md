# Phase 5: Booking Detail Page (Frontend)

- [ ] T021 [P] [US1] [US4] Implement `BookingStatusBadge` and `BookingConfirmationBanner` in [components/bookings/](apps/web/components/bookings/)
- [ ] T022 [P] [US2] [US4] Implement `BookingProcessingState` and `BookingFailureState` with context-aware retry button in [components/bookings/](apps/web/components/bookings/)
- [ ] T023 [US4] [US6] Implement main `BookingDetail` rendering component displaying flight segments snapshot, baggage, and passenger details in [components/bookings/BookingDetail.tsx](apps/web/components/bookings/BookingDetail.tsx)
- [ ] T024 [US4] [US1] Implement booking detail page route with ownership validation in [bookings/[bookingId]/page.tsx](apps/web/app/bookings/%5BbookingId%5D/page.tsx) (on mount, strip `confirmed` query param via router.replace/replaceState to prevent banner re-display on refresh)
