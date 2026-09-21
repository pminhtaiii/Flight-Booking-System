# Booking HTTP Contract

All operations retain `JwtAuthGuard`, UUID v4 parsing for booking IDs, owner-scoped service checks, current request and response DTOs, and existing error semantics.

| Owner module | Method | Final API path | Purpose |
|---|---|---|---|
| BookingManagementModule | GET | `/bookings` | List current user's bookings with existing query and pagination |
| BookingManagementModule | GET | `/bookings/:bookingId` | Get one owned booking |
| CancellationModule | GET | `/bookings/:bookingId/cancellation` | Get cancellation status |
| CancellationModule | POST | `/bookings/:bookingId/cancellation/quote` | Get cancellation quote |
| CancellationModule | POST | `/bookings/:bookingId/cancellation` | Execute with existing `CancelBookingDto` quote ID |

US1 moves endpoint ownership while temporarily retaining `/bookings/:bookingId/cancellation-quote` and `/bookings/:bookingId/cancel`. US3 atomically switches API and web calls to the final paths and removes both old API routes.

## Frontend proxy paths

All remain under `/api/booking-management/bookings/[bookingId]/`:

| Method | Route handler | Upstream API |
|---|---|---|
| GET | `cancellation/route.ts` | GET `/bookings/:bookingId/cancellation` |
| POST | `cancellation/route.ts` | POST `/bookings/:bookingId/cancellation` |
| POST | `cancellation/quote/route.ts` | POST `/bookings/:bookingId/cancellation/quote` |

The old `cancel/`, `cancellation-quote/`, and `cancellation-status/` route-handler directories are removed. Authentication forwarding, request body, result shape, status mapping, and user-visible errors remain unchanged.
