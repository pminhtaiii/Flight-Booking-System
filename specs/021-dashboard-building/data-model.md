# Data Model: Authenticated Booking Dashboard

This feature adds no persistent entity and no migration. It defines read projections over the existing `Booking` model.

## Existing Source Entity: Booking

| Field | Use in dashboard | Rules |
|---|---|---|
| `id` | Recent identity/link | Safe public UUID; always required. |
| `userId` | Tenant filter | Required on every query; never returned. |
| `status` | Metric filters/recent status | Import the canonical enum. |
| `departureAt` | Upcoming/completed split | Nullable; equality with captured `now` is upcoming. |
| `createdAt` | Recent ordering | Descending; optional `id` tiebreaker. |
| `flightSnapshot` | Route/airline projection | Parse defensively; never return raw JSON/provider IDs. |
| payment/passenger/provider fields | None | Explicitly excluded. |

Existing indexes cover the planned access patterns. No new index is planned without measured evidence.

## Read Projection: DashboardStats

| Field | Type | Derivation |
|---|---|---|
| `totalBookings` | non-negative integer | Owner-scoped count of all bookings. |
| `upcomingBookings` | non-negative integer | Owner + `CONFIRMED` + `departureAt >= now`. |
| `completedBookings` | non-negative integer | Owner + (`COMPLETED` OR (`CONFIRMED` + `departureAt < now`)). |
| `cancelledBookings` | non-negative integer | Owner + status in the canonical cancellation family: `CANCELLATION_PENDING`, `CANCELLED_PENDING_REFUND`, `CANCELLED_AND_REFUNDED`, `CANCELLED_NO_REFUND`, `REFUND_FAILED_NEEDS_ATTENTION`. |

One `now` instant is captured per request and reused by both time filters. The completed OR branches are mutually exclusive by status, so they cannot double count. Cancellation states are grouped for display only; the response preserves each recent booking's exact canonical status.

## Read Projection: DashboardRecentBooking

| Field | Type | Source |
|---|---|---|
| `id` | UUID string | `Booking.id`. |
| `status` | canonical booking status | `Booking.status`. |
| `createdAt` | ISO timestamp | `Booking.createdAt`. |
| `departureAt` | ISO timestamp or null | `Booking.departureAt`. |
| `originCode` | string or null | Allowlisted snapshot parser. |
| `destinationCode` | string or null | Allowlisted snapshot parser. |
| `airlineCode` | string or null | Allowlisted snapshot parser. |
| `flightNumber` | string or null | Allowlisted snapshot parser. |

Invariants: maximum five, newest first, malformed optional snapshot data becomes `null`, and no user ID, PNR, provider/payment ID, amount, passenger data, raw snapshot or audit detail is exposed.

## Aggregate: DashboardSummary

| Field | Type | Relationship |
|---|---|---|
| `stats` | `DashboardStats` | Exactly one. |
| `recentBookings` | `DashboardRecentBooking[]` | Zero to five, same authenticated owner. |
| `generatedAt` | ISO timestamp | Same clock instant used for boundaries. |

## Web Boundary: DashboardOutcome

```text
Success: { ok: true, data: DashboardSummary }
Failure: { ok: false, reason, message, retryable }
```

Failure reasons are `UNAUTHENTICATED`, `FORBIDDEN`, `UPSTREAM_UNAVAILABLE`, and `INVALID_RESPONSE`. Messages never include bodies, tokens, SQL, provider IDs or stack traces.

## State Transitions

The dashboard performs no transition. Lifecycle changes elsewhere appear on the next uncached navigation.
