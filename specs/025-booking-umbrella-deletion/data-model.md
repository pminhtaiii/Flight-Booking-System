# Data Model: Booking Umbrella Deletion

No database schema change or migration is planned.

## Existing Booking

The current `Booking` record remains the source of truth. The feature uses `id`, `userId`, `status`, `createdAt`, `departureAt`, payment linkage, booking intent, and the relations already required by `BookingRecoveryService.reconcileBookingIfStale`. Read-time staleness is `status = PROCESSING` and `createdAt <= now - 15 minutes`. Completion remains the existing eligible `CONFIRMED → COMPLETED` local transition.

## Transient reconciliation request

| Field | Type | Rule |
|---|---|---|
| `bookingId` | UUID v4 string | Required; no user, passenger, payment, or provider payload |

The request is in-process and has no persistence or delivery guarantee. The handler loads current Booking state before work. The existing ten-minute cron provides missed-request recovery.

## Transient reconciliation lease

| Field | Value | Rule |
|---|---|---|
| Key | `booking:recon:lock:{bookingId}` | One key per booking |
| Owner | Fresh UUID per handler attempt | Used for ownership-safe release |
| TTL | 300 seconds | Atomic acquisition with NX and expiry |

Redis lease state coordinates work; it does not determine Booking correctness. A worker may outlive the TTL, so recovery must tolerate duplicate execution. Feature 024's cache helper has process-local fallback when Redis is unavailable.

## Existing cancellation quote

No data change. Quote ID, expiry, ownership check, and cancellation/refund transitions retain the current service behavior; only the HTTP path changes.
