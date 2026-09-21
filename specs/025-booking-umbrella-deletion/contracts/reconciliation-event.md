# Reconciliation Event Contract

**Event**: `booking.reconciliation.requested`
**Payload**: `{ bookingId: string }` with a UUID v4 booking ID.
**Emitter**: `BookingManagementService` list/detail reads, only for `PROCESSING` records at least 15 minutes old.
**Listener**: `BookingRecoveryService` in `BookingLifecycleModule`.

## Processing invariants

1. The GET does not await event processing or provider I/O. Listener failure is contained and logged.
2. The handler creates a fresh UUID token and acquires `booking:recon:lock:{bookingId}` with atomic NX and 300-second expiry through the feature 024 cache helper.
3. A busy lease skips this attempt. An acquired attempt reloads the current Booking with recovery-required relations and rechecks stale `PROCESSING` eligibility.
4. The handler calls existing idempotent `reconcileBookingIfStale` only after recheck. It releases the lease in `finally` with the same owner token.
5. Lock expiry, Redis fallback, and process termination may permit duplicate work; implementation must verify provider-operation idempotency and booking/payment state guards, hardening them where needed.
6. The existing ten-minute `sweepStaleBookings` job remains an independent missed-event safety net, but calls the same locked per-booking helper as the event listener.
7. Logs may include booking ID and outcome/error category; event and lock values contain no passenger data, card data, provider secrets, or booking graph.
8. Feature 024's wildcard `BookingProjectionListener` must reject this request event before its `try/finally` duration metric, hydration, and projection upsert; only catalogued committed transition events with `eventId` and `sourceVersion` enter that listener.
