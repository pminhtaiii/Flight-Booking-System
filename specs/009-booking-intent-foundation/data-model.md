# Data Model: Booking Intent Foundation

**Feature**: 009-booking-intent-foundation
**Date**: 2026-07-10

---

## New Models

### BookingIntent

Temporary server-side record bridging flight selection and payment. Stores the confirmed pricing snapshot and links to passenger data.

| Field              | Type                  | Constraints                                                            | Notes                                                                                                                                                                                                                                                                                                        |
| ------------------ | --------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`               | `String`              | `@id @default(uuid())`                                                 | Primary key                                                                                                                                                                                                                                                                                                  |
| `userId`           | `String`              | FK → `User.id`, `onDelete: Cascade`                                    | Owning user                                                                                                                                                                                                                                                                                                  |
| `flightOfferId`    | `String`              | FK → `FlightOffer.id` (optional, `onDelete: SetNull`)                  | Reference to the selected flight offer                                                                                                                                                                                                                                                                       |
| `duffelOfferId`    | `String`              | Required                                                               | Duffel offer ID used for re-pricing. Populated server-side from the linked `FlightOffer` record at creation — never accepted directly from the client (see [api.md](./contracts/api.md) → `POST /bookings/intent`)                                                                                           |
| `status`           | `BookingIntentStatus` | `@default(PENDING)`                                                    | Lifecycle state                                                                                                                                                                                                                                                                                              |
| `originalPrice`    | `Decimal`             | `@db.Decimal(10, 2)`                                                   | Price from search results                                                                                                                                                                                                                                                                                    |
| `confirmedPrice`   | `Decimal`             | `@db.Decimal(10, 2)`                                                   | Price from Duffel re-pricing                                                                                                                                                                                                                                                                                 |
| `currency`         | `String`              | `@default("USD")`                                                      | Currency code                                                                                                                                                                                                                                                                                                |
| `priceChanged`     | `Boolean`             | `@default(false)`                                                      | Whether price changed during re-pricing                                                                                                                                                                                                                                                                      |
| `pricedAt`         | `DateTime`            | Required                                                               | Timestamp of Duffel re-pricing (staleness check for Feature B)                                                                                                                                                                                                                                               |
| `origin`           | `String`              | `@db.VarChar(3)`                                                       | IATA origin code                                                                                                                                                                                                                                                                                             |
| `destination`      | `String`              | `@db.VarChar(3)`                                                       | IATA destination code                                                                                                                                                                                                                                                                                        |
| `departureDate`    | `DateTime`            | `@db.Date`                                                             | Departure date                                                                                                                                                                                                                                                                                               |
| `returnDate`       | `DateTime?`           | `@db.Date`                                                             | Return date (nullable for one-way)                                                                                                                                                                                                                                                                           |
| `cabinClass`       | `String`              | `@default("economy")`                                                  | Requested cabin class                                                                                                                                                                                                                                                                                        |
| `adults`           | `Int`                 | Required                                                               | Number of adult passengers                                                                                                                                                                                                                                                                                   |
| `children`         | `Int`                 | `@default(0)`                                                          | Number of child passengers                                                                                                                                                                                                                                                                                   |
| `infants`          | `Int`                 | `@default(0)`                                                          | Number of infant passengers                                                                                                                                                                                                                                                                                  |
| `rawOfferSnapshot` | `Json`                | Required                                                               | Full Duffel offer snapshot at re-pricing time                                                                                                                                                                                                                                                                |
| `intentExpiresAt`  | `DateTime`            | Required, set at creation = `createdAt` + `BOOKING_INTENT_TTL_MINUTES` | Client-facing soft-expiry time for the `PENDING` state. Stored so clients can render a countdown without knowing the server's TTL config. This is the authoritative expiration deadline for Phase 1 cleanup; the cron job must compare against this stored value instead of recomputing TTL from `createdAt` |
| `offerExpiresAt`   | `DateTime?`           |                                                                        | Duffel offer's own expiration time, as returned by Duffel — distinct from `intentExpiresAt` above (our TTL), and nullable because not every Duffel response includes it                                                                                                                                      |
| `createdAt`        | `DateTime`            | `@default(now())`                                                      | Creation timestamp                                                                                                                                                                                                                                                                                           |
| `updatedAt`        | `DateTime`            | `@updatedAt`                                                           | Last update timestamp                                                                                                                                                                                                                                                                                        |

**Relations**:

- `user` → `User` (many-to-one)
- `passengers` → `BookingIntentPassenger[]` (one-to-many, ordered by `position`)

**Indexes**:

- `@@index([userId])`
- `@@index([userId, status])`
- `@@index([status, intentExpiresAt])` — for Phase 1 cron (`PENDING` → `EXPIRED`)
- `@@index([status, updatedAt])` — for Phase 2 cron (`EXPIRED` → hard delete)
- `@@map("booking_intents")`

### BookingIntentPassenger

Individual passenger data for a booking intent. PII fields (passport) are encrypted at the application layer using AES-256-GCM.

| Field               | Type            | Constraints                                               | Notes                                                                                                                                                                                                                                                                                       |
| ------------------- | --------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                | `String`        | `@id @default(uuid())`                                    | Primary key                                                                                                                                                                                                                                                                                 |
| `intentId`          | `String`        | FK → `BookingIntent.id`, `onDelete: Cascade`              | Parent intent                                                                                                                                                                                                                                                                               |
| `position`          | `Int`           | Required                                                  | 0-based order of this passenger within the intent. Gives a stable ordering for the passenger array. The primary passenger for pre-fill is identified by the `useProfile` flag in the request, not by position.                                                                              |
| `type`              | `PassengerType` | Required                                                  | `ADULT`, `CHILD`, `INFANT`                                                                                                                                                                                                                                                                  |
| `givenName`         | `String`        | Required                                                  | First name                                                                                                                                                                                                                                                                                  |
| `familyName`        | `String`        | Required                                                  | Last name                                                                                                                                                                                                                                                                                   |
| `dateOfBirth`       | `DateTime`      | `@db.Date`                                                | Date of birth                                                                                                                                                                                                                                                                               |
| `gender`            | `String`        | Required                                                  | `male` / `female`                                                                                                                                                                                                                                                                           |
| `nationality`       | `String?`       | `@db.VarChar(2)`                                          | ISO 3166-1 alpha-2 country code                                                                                                                                                                                                                                                             |
| `passportNumber`    | `String?`       | `@encrypted`                                              | AES-256-GCM encrypted at app layer                                                                                                                                                                                                                                                          |
| `passportExpiry`    | `String?`       | `@encrypted`                                              | AES-256-GCM encrypted at app layer. Stored as `String`, not `DateTime` — an encrypted value is ciphertext (base64/hex text), which a `DateTime` column can't hold. The DTO layer serializes the plaintext date to ISO-8601 before encryption, and parses it back to a date after decryption |
| `travelerProfileId` | `String?`       | FK → `TravelerProfile.id` (optional, `onDelete: SetNull`) | Audit link to source `TravelerProfile` (if pre-filled)                                                                                                                                                                                                                                      |
| `createdAt`         | `DateTime`      | `@default(now())`                                         | Creation timestamp                                                                                                                                                                                                                                                                          |

**Relations**:

- `intent` → `BookingIntent` (many-to-one, cascade delete)
- `travelerProfile` → `TravelerProfile` (many-to-one, optional, `onDelete: SetNull`)

**Indexes**:

- `@@index([intentId])`
- `@@unique([intentId, position])` — enforces exactly one stable ordering position per passenger within an intent
- `@@map("booking_intent_passengers")`

---

## New Enums

### BookingIntentStatus

```
enum BookingIntentStatus {
  PENDING     // Intent created, awaiting payment
  EXPIRED     // Soft-expired by cron (TTL exceeded)
  COMPLETED   // Promoted to real Booking (Feature B)
}
```

### PassengerType

```
enum PassengerType {
  ADULT
  CHILD
  INFANT
}
```

---

## State Transitions

```
PENDING ──(TTL exceeded, cron Phase 1)──→ EXPIRED ──(grace period, cron Phase 2)──→ [DELETED]
PENDING ──(payment confirmed, Feature B)──→ COMPLETED ──(retention period elapsed)──→ [DELETED]
```

**Transition rules**:

- `PENDING → EXPIRED`: Cron job, atomic conditional update when `intentExpiresAt < now` and `status = PENDING`; the `BOOKING_INTENT_TTL_MINUTES` deadline is applied once at creation, and the conditional update only serializes this local state transition (see [research.md](./research.md) → R3)
- `EXPIRED → [DELETED]`: Cron job, when `updatedAt` + `BOOKING_INTENT_GRACE_HOURS` grace period < now
- `PENDING → COMPLETED`: Feature B payment webhook, idempotent by provider event ID and guarded by the same local conditional update pattern; if payment settles after local expiration, the webhook path must reconcile or compensate against the provider result rather than assuming the row claim makes the payment impossible (out of scope for Feature A)
- `COMPLETED → [DELETED]`: Retention-window cron, out of scope for this feature (see [research.md](./research.md) → R7 for the recommended retention period)
- `EXPIRED` intents with in-flight payment: local row updates may serialize state changes, but they do not prevent a provider payment from racing with expiration; the payment webhook/reconciliation path must handle that race idempotently

---

## Validation Rules (Application Layer)

These rules are enforced in the NestJS DTO/service layer, NOT as database constraints:

| Rule                                                  | Scope         | Error Message                                                         |
| ----------------------------------------------------- | ------------- | --------------------------------------------------------------------- |
| `infants ≤ adults`                                    | Cross-field   | "Number of infants cannot exceed number of adults"                    |
| `adults + children + infants ≤ 9`                     | Cross-field   | "Total passengers cannot exceed 9"                                    |
| `adults ≥ 1`                                          | Field         | "At least one adult passenger is required"                            |
| `givenName` required                                  | Per-passenger | "Given name is required for all passengers"                           |
| `familyName` required                                 | Per-passenger | "Family name is required for all passengers"                          |
| `dateOfBirth` required                                | Per-passenger | "Date of birth is required for all passengers"                        |
| `gender` must be `male` or `female`                   | Per-passenger | "Gender must be 'male' or 'female'"                                   |
| Passenger count matches `adults + children + infants` | Cross-field   | "Passenger details count must match the declared passenger breakdown" |

Passport fields (`passportNumber`, `passportExpiry`) are intentionally absent from this table — they stay optional for this feature. Requiring them for international routes is a deferred decision (see [research.md](./research.md) → R6).

---

## Relationship to Existing Models

```
User (1) ──→ (many) BookingIntent
User (1) ──→ (0..1) TravelerProfile  [pre-fill source, unchanged]
FlightOffer (1) ──→ (many) BookingIntent  [optional FK, SetNull on delete]
TravelerProfile (1) ──→ (many) BookingIntentPassenger  [optional FK, SetNull on delete, audit link]
BookingIntent (1) ──→ (many) BookingIntentPassenger  [cascade delete]
```

**Existing model shapes are otherwise unchanged**, but this feature requires two new back-relation fields, which must be added before the schema and migration can be generated (Prisma requires both sides of a relation to be declared):

- `User.bookingIntents BookingIntent[]` — back-relation for `BookingIntent.user`.
- `TravelerProfile.bookingIntentPassengers BookingIntentPassenger[]` — back-relation for the new `BookingIntentPassenger.travelerProfile` relation above.

No columns on `User`, `TravelerProfile`, `FlightOffer`, or `Booking` change, and no existing data is affected — but "no changes to existing models" was inaccurate as originally written; both models above gain one relation field each.
