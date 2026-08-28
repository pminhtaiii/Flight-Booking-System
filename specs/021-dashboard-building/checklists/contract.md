# OpenAPI & Shared Schema Contract Conformance Checklist: Authenticated Booking Dashboard

**Feature**: [021-dashboard-building](../spec.md)  
**Task**: T002 - Dashboard Contract Conformance Checklist  
**Source OpenAPI Contract**: [contracts/dashboard-summary.openapi.yaml](../contracts/dashboard-summary.openapi.yaml)  
**Data Model**: [data-model.md](../data-model.md)  
**Implementation Plan**: [plan.md](../plan.md)  

---

## 1. Overview & Purpose

This checklist defines the contract conformance rules, schema invariants, query derivation logic, privacy boundaries, and validation requirements for `GET /api/dashboard/summary`.

All implementations across `packages/shared`, `apps/api`, and `apps/web` must conform strictly to these specifications. Shared Zod schemas in `packages/shared/src/types/dashboard.types.ts` serve as the single executable source of truth.

---

## 2. Component Schema Validation Requirements

### 2.1 `DashboardStats` Schema & Derivation Rules

The `DashboardStats` object contains four owner-scoped booking metric counters.

#### Schema Invariants
- `totalBookings`: Required non-negative integer (`type: integer`, `minimum: 0`).
- `upcomingBookings`: Required non-negative integer (`type: integer`, `minimum: 0`).
- `completedBookings`: Required non-negative integer (`type: integer`, `minimum: 0`).
- `cancelledBookings`: Required non-negative integer (`type: integer`, `minimum: 0`).
- `additionalProperties: false` (strict object shape with no unrecognized properties).

#### Query Derivation & Canonical Status Mappings
- **Clock Synchronization**: The service must capture exactly one `now` (`Date`) timestamp per request and reuse this identical instant across all time-based metric filters and `generatedAt`.
- **`totalBookings`**:
  - Filter: `{ userId }`
  - Derivation: Total count of all bookings created by the authenticated user regardless of status.
- **`upcomingBookings`**:
  - Filter: `{ userId, status: BookingStatus.CONFIRMED, departureAt: { gte: now } }`
  - Derivation: Confirmed bookings with a departure time at or after the captured `now` instant (`departureAt >= now`). Confirmed bookings with `departureAt = null` are excluded.
- **`completedBookings`**:
  - Filter: `{ userId, OR: [ { status: BookingStatus.COMPLETED }, { status: BookingStatus.CONFIRMED, departureAt: { lt: now } } ] }`
  - Derivation: Canonical completed bookings plus confirmed bookings with a departure time strictly before the captured `now` instant (`departureAt < now`).
  - Mutual Exclusion: `COMPLETED` and `CONFIRMED` statuses are distinct enum values, preventing double-counting.
- **`cancelledBookings`**:
  - Filter: `{ userId, status: { in: [ BookingStatus.CANCELLATION_PENDING, BookingStatus.CANCELLED_PENDING_REFUND, BookingStatus.CANCELLED_AND_REFUNDED, BookingStatus.CANCELLED_NO_REFUND, BookingStatus.REFUND_FAILED_NEEDS_ATTENTION ] } }`
  - Derivation: Count of all bookings in any of the 5 canonical cancellation-family lifecycle states.
  - Critical Invariant: The codebase and schema do not contain a generic `BookingStatus.CANCELLED`. Attempting to reference `CANCELLED` is a defect.

#### Stats Conformance Checklist
- [ ] `totalBookings` is an integer `>= 0`.
- [ ] `upcomingBookings` is an integer `>= 0`.
- [ ] `completedBookings` is an integer `>= 0`.
- [ ] `cancelledBookings` is an integer `>= 0`.
- [ ] All 4 metric fields are required; none may be `null` or `undefined`.
- [ ] Unknown or extra properties trigger validation errors (`strict()` / `additionalProperties: false`).
- [ ] Boundary condition: `departureAt == now` counts as `upcomingBookings`, not `completedBookings`.
- [ ] Confirmed bookings with `departureAt: null` count only toward `totalBookings`.
- [ ] Non-confirmed bookings with future dates do not count toward `upcomingBookings`.
- [ ] Non-confirmed bookings with past dates do not count toward `completedBookings`.

---

### 2.2 `DashboardRecentBooking` Schema & Field Constraints

`DashboardRecentBooking` defines a sanitized, PII-safe projection of an individual booking for dashboard display.

#### Schema Invariants
- `id`: Required string matching UUID v4 format (`format: uuid`).
- `status`: Required string matching the exact 9-value `BookingStatus` enum:
  1. `PROCESSING`
  2. `CONFIRMED`
  3. `FAILED`
  4. `COMPLETED`
  5. `CANCELLATION_PENDING`
  6. `CANCELLED_PENDING_REFUND`
  7. `CANCELLED_AND_REFUNDED`
  8. `CANCELLED_NO_REFUND`
  9. `REFUND_FAILED_NEEDS_ATTENTION`
- `createdAt`: Required ISO 8601 date-time string (`format: date-time`).
- `departureAt`: Required field; string formatted as ISO 8601 date-time OR `null` (`nullable: true`).
- `originCode`: Required field; string (3-letter IATA code or name) OR `null` (`nullable: true`).
- `destinationCode`: Required field; string (3-letter IATA code or name) OR `null` (`nullable: true`).
- `airlineCode`: Required field; string (2-letter IATA code or name) OR `null` (`nullable: true`).
- `flightNumber`: Required field; string OR `null` (`nullable: true`).
- `additionalProperties: false` (strict object shape with no unrecognized properties).

#### Defensive Snapshot Projection Rules
- Flight metadata (`originCode`, `destinationCode`, `airlineCode`, `flightNumber`) is extracted from the `Booking.flightSnapshot` JSON blob using an allowlist parser.
- If `flightSnapshot` is missing, malformed, empty, or lacks expected fields, the corresponding display properties must resolve safely to `null`.
- Snapshot parsing must never throw an unhandled exception or cause an endpoint 500 failure.

#### Ordering and Limits
- Ordered strictly by `createdAt` descending (`DESC`), with `id` descending as a deterministic tiebreaker.
- Capped at a maximum of 5 records (`take: 5`).
- Zero records returns an empty array `[]` (not `null` or missing).

#### Recent Booking Conformance Checklist
- [ ] `id` validates as a valid UUID format string.
- [ ] `status` is restricted to the exact 9 canonical lifecycle enum values.
- [ ] `createdAt` is a valid ISO 8601 date-time string.
- [ ] `departureAt`, `originCode`, `destinationCode`, `airlineCode`, and `flightNumber` are explicitly present (either string/date-time or `null`).
- [ ] Unknown or extra properties are stripped or rejected (`strict()` / `additionalProperties: false`).
- [ ] Array size is bounded between 0 and 5 items (`maxItems: 5`).
- [ ] Records are sorted newest first by `createdAt DESC`.

---

### 2.3 `DashboardSummary` Aggregate Schema

`DashboardSummary` is the root response object for `GET /api/dashboard/summary`.

#### Schema Invariants
- `stats`: Required `DashboardStats` object.
- `recentBookings`: Required array of `DashboardRecentBooking` items, capped at `maxItems: 5`.
- `generatedAt`: Required ISO 8601 date-time string (`format: date-time`), representing the exact clock timestamp used for metric derivations.
- `additionalProperties: false` (strict object shape with no unrecognized properties).

#### Summary Conformance Checklist
- [ ] `stats` strictly conforms to `DashboardStatsSchema`.
- [ ] `recentBookings` is an array containing 0 to 5 valid `DashboardRecentBooking` objects.
- [ ] `generatedAt` is a valid ISO 8601 timestamp string.
- [ ] Root object contains no extra properties beyond `stats`, `recentBookings`, and `generatedAt`.

---

## 3. Zero-Leakage Privacy & Security Invariants

The dashboard endpoint operates under strict Zero-Leakage data privacy constraints. Under no circumstances may sensitive PII, payment secrets, raw supplier payloads, or internal infrastructure details be returned.

### 3.1 Prohibited Data Categories

| Category | Prohibited Fields / Items | Rationale / Enforcement |
|---|---|---|
| **Passenger PII** | Passenger full names, first/last names, email addresses, phone numbers, passport numbers, national IDs, dates of birth, gender, loyalty account numbers | Not needed for high-level dashboard metrics; prevents accidental client exposure. |
| **Payment Secrets & Financials** | Stripe payment intent IDs, client secrets, payment method tokens, credit card numbers, billing addresses, transaction amounts, refund transaction references | Financial security and PCI compliance. Pricing/payment data belongs in checkout/receipt endpoints only. |
| **Raw Supplier Payloads** | Full `flightSnapshot` JSON blob, Duffel offer IDs, Duffel order IDs, provider raw responses, internal baggage/seat JSON | External provider details and oversized payload blobs must not leak to the client. |
| **Tenant & Identity Leakage** | `Booking.userId`, user profile records, cross-tenant records | The endpoint derives identity exclusively from the validated JWT token; tenant IDs must never be echoed in responses. |
| **Infrastructure & Internal URLs** | Internal backend hostnames, database connection strings, microservice URLs, JWT tokens, environment flags | System topology obfuscation. |
| **Sensitive Error Traces** | Prisma query errors, SQL state codes, stack traces, internal gateway failure messages | All error responses must map to safe, sanitized user-facing messages. |

### 3.2 Security Conformance Checklist
- [ ] `Booking.userId` is used only as a query filter and is never exposed in the response payload.
- [ ] No passenger information (`passengers` relation or fields) is selected or projected.
- [ ] No payment record (`payments` relation, tokens, or amounts) is selected or projected.
- [ ] `flightSnapshot` is transformed into primitive allowlisted display fields; the raw JSON blob is excluded.
- [ ] No Duffel IDs (`offerId`, `orderId`) or provider identifiers are present in the response.
- [ ] JWT tokens and backend authorization headers are never logged or returned in error payloads.

---

## 4. Web Boundary Result Contract (`DashboardOutcome`)

The Next.js web application encapsulates API data fetching via a robust discriminated union pattern (`DashboardOutcome`) in `apps/web/lib/server/dashboard.ts`.

### 4.1 Type Definitions

```typescript
export type DashboardOutcome =
  | {
      ok: true;
      data: DashboardSummary;
    }
  | {
      ok: false;
      reason: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'UPSTREAM_UNAVAILABLE' | 'INVALID_RESPONSE';
      message: string;
      retryable: boolean;
    };
```

### 4.2 Failure Reason Mapping Table

| HTTP Status / Trigger | Outcome `reason` | `retryable` | User-Facing `message` | Client Action |
|---|---|---|---|---|
| No active NextAuth session | `UNAUTHENTICATED` | `false` | `"Authentication required. Please log in."` | Redirect to `/login` |
| HTTP 401 Unauthorized | `UNAUTHENTICATED` | `false` | `"Your session has expired. Please sign in again."` | Redirect to `/login?callbackUrl=/dashboard` |
| HTTP 403 Forbidden | `FORBIDDEN` | `false` | `"Access denied. You do not have permission to view this resource."` | Render forbidden error state |
| HTTP 500 / 502 / 503 / 504 | `UPSTREAM_UNAVAILABLE` | `true` | `"The dashboard service is temporarily unavailable. Please try again."` | Render retryable error banner |
| Fetch timeout (>= 10s) / Network error | `UPSTREAM_UNAVAILABLE` | `true` | `"Connection timed out. Please check your network and try again."` | Render retryable error banner |
| JSON syntax error / Invalid schema | `INVALID_RESPONSE` | `false` | `"Unable to load dashboard data due to an unexpected format."` | Render generic error state |

### 4.3 Web Outcome Conformance Checklist
- [ ] `DashboardOutcome` is a discriminated union on `ok: true | false`.
- [ ] On `ok: true`, `data` conforms to `DashboardSummary`.
- [ ] On `ok: false`, `reason` is strictly one of `'UNAUTHENTICATED'`, `'FORBIDDEN'`, `'UPSTREAM_UNAVAILABLE'`, `'INVALID_RESPONSE'`.
- [ ] On `ok: false`, `message` is a safe, user-friendly string without stack traces, URLs, or raw HTTP/database errors.
- [ ] On `ok: false`, `retryable` is a boolean indicating whether the user or UI may attempt re-fetching.
- [ ] Server loader enforces `cache: 'no-store'` on upstream fetches.
- [ ] Server loader enforces a 10-second request timeout boundary.

---

## 5. Verification & Test Coverage Matrix

### 5.1 Shared Package Zod Tests (`packages/shared/src/types/dashboard.types.spec.ts`)
- [ ] Validates valid `DashboardSummary` payloads.
- [ ] Rejects negative numbers for `totalBookings`, `upcomingBookings`, `completedBookings`, `cancelledBookings`.
- [ ] Rejects non-integer values (e.g. floats, strings) for count fields.
- [ ] Rejects unknown status strings outside the 9-value `BookingStatus` enum.
- [ ] Rejects invalid UUID formats in `DashboardRecentBooking.id`.
- [ ] Rejects invalid date-time strings in `createdAt`, `departureAt`, and `generatedAt`.
- [ ] Accepts `null` for optional display projections (`departureAt`, `originCode`, `destinationCode`, `airlineCode`, `flightNumber`).
- [ ] Rejects arrays in `recentBookings` containing more than 5 items.
- [ ] Rejects unexpected extra properties in `DashboardStats`, `DashboardRecentBooking`, and `DashboardSummary`.

### 5.2 API Unit & Integration Tests (`apps/api/src/dashboard/`, `apps/api/test/`)
- [ ] `dashboard.service.spec.ts`:
  - [ ] Computes `totalBookings` across all user bookings.
  - [ ] Computes `upcomingBookings` with `status: CONFIRMED` and `departureAt >= now`.
  - [ ] Computes `completedBookings` with `status: COMPLETED` or (`CONFIRMED` and `departureAt < now`).
  - [ ] Computes `cancelledBookings` across all 5 cancellation-family enum statuses.
  - [ ] Verifies boundary comparison equality (`departureAt == now` is upcoming).
  - [ ] Verifies handling of `departureAt: null`.
  - [ ] Queries direct Prisma database with 4 counts and 1 `findMany` issued concurrently (`Promise.all`).
  - [ ] Returns at most 5 recent bookings sorted by `createdAt DESC`.
  - [ ] Safely parses valid and malformed `flightSnapshot` JSON data into allowlisted fields.
  - [ ] Rejects requests or filters strictly by `userId` to guarantee tenant isolation.
- [ ] `dashboard.controller.spec.ts`:
  - [ ] Requires `JwtAuthGuard`.
  - [ ] Extracts `user.id` from the authenticated request and passes it to `DashboardService`.
  - [ ] Sets appropriate cache-control headers (`no-store, no-cache, must-revalidate`).
- [ ] `dashboard.e2e-spec.ts`:
  - [ ] Returns 401 when request is unauthenticated or has an invalid token.
  - [ ] Returns 200 with matching schema when authenticated.
  - [ ] Verifies User A cannot see User B's metrics or recent bookings.
  - [ ] Verifies zero-data scenario returns all metrics as 0 and `recentBookings: []`.

### 5.3 Web Server Loader Tests (`apps/web/lib/server/dashboard.spec.ts`)
- [ ] Returns `{ ok: false, reason: 'UNAUTHENTICATED' }` when session is missing.
- [ ] Passes bearer token in `Authorization` header to upstream API.
- [ ] Returns `{ ok: true, data: ... }` when API returns 200 and schema validation passes.
- [ ] Returns `{ ok: false, reason: 'UNAUTHENTICATED' }` on API 401 response.
- [ ] Returns `{ ok: false, reason: 'FORBIDDEN' }` on API 403 response.
- [ ] Returns `{ ok: false, reason: 'UPSTREAM_UNAVAILABLE', retryable: true }` on API 500 response or network error.
- [ ] Returns `{ ok: false, reason: 'UPSTREAM_UNAVAILABLE', retryable: true }` on timeout >= 10s.
- [ ] Returns `{ ok: false, reason: 'INVALID_RESPONSE', retryable: false }` on malformed JSON or schema validation failure.
- [ ] Guarantees no sensitive tokens or raw errors are present in returned outcome messages.
