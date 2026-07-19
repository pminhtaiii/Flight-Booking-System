# Data Model: Bookings Management & Confirmation

**Feature**: 011-booking-management | **Date**: 2026-07-19

## New Enums

### BookingStatus

```
PROCESSING   → Pipeline is running (Booking just created at start of confirm)
CONFIRMED    → PNR created, payment captured successfully
FAILED       → Pipeline failed at some stage
COMPLETED    → Flight departure date has passed
```

**Transitions**:
```
PROCESSING → CONFIRMED   (pipeline success)
PROCESSING → FAILED      (pipeline failure at any stage OR stale timeout)
CONFIRMED  → COMPLETED   (flight date passes)
```

**CONFIRMED → COMPLETED Transition Mechanism**:
To ensure real-time accuracy and limit background write overhead:
1. **Read-Time Reactive Update**: When querying list or detail endpoints, the backend service check MUST dynamically evaluate if a `CONFIRMED` booking's `departureAt` date has passed (`departureAt <= NOW()`). If it has, the service will asynchronously trigger a status update to `COMPLETED` in the database and return `COMPLETED` in the API response. This guarantees users never see elapsed bookings in their "Upcoming" tab.
2. **Scheduled Sweep (Cron)**: A daily background cron job sweeps the database for any remaining `CONFIRMED` bookings where `departureAt <= NOW()` and updates their status to `COMPLETED`. This serves as a fallback to keep the database state clean even for users who do not actively visit the platform.

**Stale PROCESSING Cleanup Strategy (TTL/Cron)**:
To prevent bookings from getting permanently stuck in the `PROCESSING` state due to server crashes or unhandled pipeline exceptions:
1. **Stale Threshold**: Any booking remaining in the `PROCESSING` state for more than 15 minutes is considered stale/stuck (since a typical sync pipeline runs in under 1 minute).
2. **Read-Time Reactive Fail**: On list or detail API queries, if a `PROCESSING` booking was created more than 15 minutes ago (`createdAt <= NOW() - 15 minutes`), the backend service MUST reconcile the state before returning a status:
   - **If Stripe Capture Succeeded (`Payment.status === 'SUCCEEDED'`)**:
     - If PNR creation succeeded (a PNR is found/recovered from Duffel or the DB): Update the booking to `status: CONFIRMED` (and populate PNR, snapshots, and departure date).
     - If PNR creation failed (no flight was booked): Update the booking to `status: FAILED` with `failureReason: CAPTURE_FAILED` and trigger an automated refund.
   - **If Stripe Capture Did Not Succeed** (e.g. Payment is `AUTHORIZED`, `FAILED`, `CANCELLED`, or does not exist):
     - Update the booking to `status: FAILED` and `failureReason: SYSTEM_ERROR`.
     - If the Stripe payment contains an active hold (status `AUTHORIZED`), the service MUST also trigger a void/refund of the authorization hold (releasing the hold immediately).
   - The service will asynchronously update the database record to the resolved status, initiate any required void/refund actions, and return the resolved status to the client immediately.
3. **Scheduled Cleanup Cron**: A background cron job running every 15 minutes sweeps the database for `PROCESSING` bookings older than 15 minutes and executes the same reconciliation logic:
   - Check the associated Stripe `Payment.status` and verify with Duffel if a PNR reference was generated.
   - **If Stripe payment is captured**:
     - If Duffel PNR exists: Update booking status to `CONFIRMED` (recovery path).
     - If Duffel PNR does not exist: Update booking status to `FAILED` with `failureReason: CAPTURE_FAILED` and trigger an automated refund via `PaymentRefundService`.
   - **If Stripe payment is NOT captured** (e.g. authorization exists but not captured, or void failed): Update status to `FAILED` with `failureReason: SYSTEM_ERROR` and trigger a void/refund if there is an active hold.
   - This ensures orphaned processing records are safely resolved without leaving users charged for unconfirmed flights.
4. **Concurrency Guard (Double Refund Prevention)**:
   To prevent race conditions where the read-time reactive update and the scheduled cron job sweep attempt to reconcile and update the same stale booking simultaneously (which could result in duplicate automated refunds or duplicate status transitions), the status update MUST be executed as a conditional DB write (optimistic concurrency guard):
   - Perform the database update using a query filtered by the expected initial status, e.g., in Prisma: `prisma.booking.updateMany({ where: { id: bookingId, status: 'PROCESSING' }, data: { status: 'FAILED', failureReason: 'CAPTURE_FAILED' } })`.
   - The executing code MUST check the database response for the number of affected rows.
   - The downstream automated refund or void operation MUST ONLY be triggered if the affected rows count is exactly `1` (meaning this specific execution thread successfully won the race and transitioned the booking status). If the count is `0`, the current thread MUST immediately abort to prevent duplicate transactions.

### BookingFailureReason

```
OFFER_EXPIRED      → Duffel offer no longer available
PRICE_CHANGED      → Duffel re-pricing returned different amount
BOOKING_TIMEOUT    → Duffel 30s PNR creation timeout
CAPTURE_FAILED     → Stripe capture failure after PNR creation
SYSTEM_ERROR       → Unexpected exception
```

Note: `PAYMENT_DECLINED` is intentionally excluded. Card declines are handled inline on the checkout page before the Booking record exists.

## New Models

### Booking

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| id | String (UUID) | PK, client-generated | UUID v4 generated by the frontend, validated server-side |
| userId | String | FK → User.id, NOT NULL | Owner of the booking |
| bookingIntentId | String | FK → BookingIntent.id, NOT NULL, UNIQUE | Source booking intent (enforces 1-to-1 relationship) |
| paymentId | String | FK → Payment.id, NULLABLE | Associated payment record (set after payment creation) |
| status | BookingStatus | NOT NULL, DEFAULT PROCESSING | Current booking lifecycle state |
| failureReason | BookingFailureReason | NULLABLE | Set only when status = FAILED |
| pnrReference | String | NULLABLE | Duffel PNR/booking reference (set after PNR creation) |
| duffelOrderId | String | NULLABLE | Duffel order ID (set after PNR creation) |
| flightSnapshot | Json | NULLABLE | Complete flight details captured at PNR creation time |
| passengerSnapshot | Json | NULLABLE | Passenger details captured at booking time |
| totalAmount | Decimal | NOT NULL | Total booking amount in smallest currency unit |
| currency | String | NOT NULL, DEFAULT "GBP" | ISO 4217 currency code |
| departureAt | DateTime | NULLABLE | Flight departure time (for Upcoming/Past tab sorting) |
| createdAt | DateTime | NOT NULL, DEFAULT now() | Record creation timestamp |
| updatedAt | DateTime | NOT NULL, auto-updated | Last modification timestamp |

**Indexes**:
- `userId` — filter bookings by user
- `userId, status` — tab queries (upcoming = PROCESSING/CONFIRMED, past = COMPLETED)
- `bookingIntentId` — UNIQUE index (enforces 1-to-1 relation and supports fast lookups)
- `departureAt` — sorting within tabs

**Relations**:
- `Booking.userId` → `User.id` (many-to-one)
- `Booking.bookingIntentId` → `BookingIntent.id` (one-to-one)
- `Booking.paymentId` → `Payment.id` (one-to-one, nullable)

## Modified Models

### User (existing)

Add relation:
- `bookings` → `Booking[]` (one-to-many)

### BookingIntent (existing)

Add relation:
- `booking` → `Booking?` (one-to-one, nullable — intent may never become a booking)

### Payment (existing)

Add relation:
- `booking` → `Booking?` (one-to-one, nullable)

## Flight Snapshot Schema

The `flightSnapshot` JSON field stores a structured snapshot captured at PNR creation:

```typescript
interface FlightSnapshot {
  segments: FlightSegmentSnapshot[];
  totalDuration: string;         // ISO 8601 duration
  stops: number;
  cabinClass: string;
  baggageAllowance?: string;
  fareClass?: string;
}

interface FlightSegmentSnapshot {
  airline: {
    name: string;
    iataCode: string;
    logoUrl?: string;
  };
  flightNumber: string;
  departureAirport: {
    iataCode: string;
    name: string;
    city: string;
    terminal?: string;
    gate?: string;
  };
  arrivalAirport: {
    iataCode: string;
    name: string;
    city: string;
    terminal?: string;
    gate?: string;
  };
  departureAt: string;          // ISO 8601 datetime
  arrivalAt: string;            // ISO 8601 datetime
  duration: string;             // ISO 8601 duration
  aircraftType?: string;
}
```

## Passenger Snapshot Schema

The `passengerSnapshot` JSON field stores passenger details at booking time:

```typescript
interface PassengerSnapshot {
  passengers: PassengerDetail[];
  contactEmail: string;
  contactPhone?: string;
}

interface PassengerDetail {
  type: 'adult' | 'child' | 'infant';
  title?: string;
  firstName: string;
  lastName: string;
  dateOfBirth?: string;
  passportNumber?: string;       // Encrypted at application layer using common/EncryptionService (AES-256-GCM)
  nationality?: string;
}
```

### Passport Number Encryption & Masking Rules
To protect sensitive personally identifiable information (PII) and comply with regulatory requirements:
1. **Application-Layer Encryption**: The `passportNumber` MUST be encrypted at the application layer using the existing `EncryptionService` (AES-256-GCM via the `ENCRYPTION_KEY` environment variable) before being stored in the `passengerSnapshot` JSON column.
2. **Database Integrity**: The raw plaintext passport number must NEVER be stored in the database.
3. **Display Masking**: The `GET /api/bookings/:bookingId` detail API endpoint will decrypt the passport number using `EncryptionService` and return only a masked version (e.g., `XXXXXX1234` displaying only the last 4 characters) to the client. The full plaintext passport number is never exposed on UI reading routes.

## Query Patterns

### My Bookings List — Upcoming Tab
```sql
SELECT b.*, p.status as paymentStatus
FROM bookings b
LEFT JOIN payments p ON b.paymentId = p.id
WHERE b.userId = :userId
  AND b.status IN ('PROCESSING', 'CONFIRMED', 'FAILED')
  AND (b.departureAt IS NULL OR b.departureAt > NOW())
ORDER BY
  CASE b.status
    WHEN 'PROCESSING' THEN 0
    WHEN 'FAILED' THEN 1
    WHEN 'CONFIRMED' THEN 2
  END,
  b.departureAt ASC NULLS LAST;
```

### My Bookings List — Past Tab
```sql
SELECT b.*, p.status as paymentStatus
FROM bookings b
LEFT JOIN payments p ON b.paymentId = p.id
WHERE b.userId = :userId
  AND (
    b.status = 'COMPLETED'
    OR (b.status IN ('CONFIRMED', 'FAILED') AND b.departureAt <= NOW())
  )
ORDER BY b.departureAt DESC;
```

### Booking Detail
```sql
SELECT b.*, p.status as paymentStatus, p.stripePaymentIntentId
FROM bookings b
LEFT JOIN payments p ON b.paymentId = p.id
WHERE b.id = :bookingId AND b.userId = :userId;
```
