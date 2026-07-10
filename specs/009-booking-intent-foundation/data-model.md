# Data Model: Booking Intent Foundation
**Feature**: 009-booking-intent-foundation
**Date**: 2026-07-10
---
## New Models
### BookingIntent
Temporary server-side record bridging flight selection and payment. Stores the confirmed pricing snapshot and links to passenger data.
|
 Field 
|
 Type 
|
 Constraints 
|
 Notes 
|
|
-------
|
------
|
-------------
|
-------
|
|
`id`
|
`String`
|
`@id @default(uuid())`
|
 Primary key 
|
|
`userId`
|
`String`
|
 FK → 
`User.id`
, 
`onDelete: Cascade`
|
 Owning user 
|
|
`flightOfferId`
|
`String`
|
 FK → 
`FlightOffer.id`
 (optional, 
`onDelete: SetNull`
) 
|
 Reference to the selected flight offer 
|
|
`duffelOfferId`
|
`String`
|
 Required 
|
 Duffel offer ID used for re-pricing 
|
|
`status`
|
`BookingIntentStatus`
|
`@default(PENDING)`
|
 Lifecycle state 
|
|
`originalPrice`
|
`Decimal`
|
`@db.Decimal(10, 2)`
|
 Price from search results 
|
|
`confirmedPrice`
|
`Decimal`
|
`@db.Decimal(10, 2)`
|
 Price from Duffel re-pricing 
|
|
`currency`
|
`String`
|
`@default("USD")`
|
 Currency code 
|
|
`priceChanged`
|
`Boolean`
|
`@default(false)`
|
 Whether price changed during re-pricing 
|
|
`pricedAt`
|
`DateTime`
|
 Required 
|
 Timestamp of Duffel re-pricing (staleness check for Feature B) 
|
|
`origin`
|
`String`
|
`@db.VarChar(3)`
|
 IATA origin code 
|
|
`destination`
|
`String`
|
`@db.VarChar(3)`
|
 IATA destination code 
|
|
`departureDate`
|
`DateTime`
|
`@db.Date`
|
 Departure date 
|
|
`returnDate`
|
`DateTime?`
|
`@db.Date`
|
 Return date (nullable for one-way) 
|
|
`cabinClass`
|
`String`
|
`@default("economy")`
|
 Requested cabin class 
|
|
`adults`
|
`Int`
|
 Required 
|
 Number of adult passengers 
|
|
`children`
|
`Int`
|
`@default(0)`
|
 Number of child passengers 
|
|
`infants`
|
`Int`
|
`@default(0)`
|
 Number of infant passengers 
|
|
`rawOfferSnapshot`
|
`Json`
|
 Required 
|
 Full Duffel offer snapshot at re-pricing time 
|
|
`createdAt`
|
`DateTime`
|
`@default(now())`
|
 Creation timestamp 
|
|
`updatedAt`
|
`DateTime`
|
`@updatedAt`
|
 Last update timestamp 
|
|
`expiresAt`
|
`DateTime?`
|
|
 Duffel offer expiration time 
|
**Relations**:
- `user` → `User` (many-to-one)
- `passengers` → `BookingIntentPassenger[]` (one-to-many)
**Indexes**:
- `@@index([userId])`
- `@@index([userId, status])`
- `@@index([status, createdAt])` — for cron cleanup queries
- `@@map("booking_intents")`
### BookingIntentPassenger
Individual passenger data for a booking intent. PII fields (passport) are encrypted at the application layer using AES-256-GCM.
|
 Field 
|
 Type 
|
 Constraints 
|
 Notes 
|
|
-------
|
------
|
-------------
|
-------
|
|
`id`
|
`String`
|
`@id @default(uuid())`
|
 Primary key 
|
|
`intentId`
|
`String`
|
 FK → 
`BookingIntent.id`
, 
`onDelete: Cascade`
|
 Parent intent 
|
|
`type`
|
`PassengerType`
|
 Required 
|
`ADULT`
, 
`CHILD`
, 
`INFANT`
|
|
`givenName`
|
`String`
|
 Required 
|
 First name 
|
|
`familyName`
|
`String`
|
 Required 
|
 Last name 
|
|
`dateOfBirth`
|
`DateTime`
|
`@db.Date`
|
 Date of birth 
|
|
`gender`
|
`String`
|
 Required 
|
`male`
 / 
`female`
|
|
`nationality`
|
`String?`
|
`@db.VarChar(2)`
|
 ISO 3166-1 alpha-2 country code 
|
|
`passportNumber`
|
`String?`
|
 @encrypted 
|
 AES-256-GCM encrypted at app layer 
|
|
`passportExpiry`
|
`DateTime?`
|
 @encrypted 
|
 AES-256-GCM encrypted at app layer 
|
|
`travelerProfileId`
|
`String?`
|
|
 Audit link to source 
`TravelerProfile`
 (if pre-filled) 
|
|
`createdAt`
|
`DateTime`
|
`@default(now())`
|
 Creation timestamp 
|
**Relations**:
- `intent` → `BookingIntent` (many-to-one, cascade delete)
**Indexes**:
- `@@index([intentId])`
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
PENDING ──(payment confirmed, Feature B)──→ COMPLETED ──(retention policy)──→ [DELETED]
```
**Transition rules**:
- `PENDING → EXPIRED`: Cron job, when `createdAt` + TTL (30 min) < now
- `EXPIRED → [DELETED]`: Cron job, when `updatedAt` + grace period (24h) < now
- `PENDING → COMPLETED`: Feature B payment webhook (out of scope for Feature A)
- `EXPIRED` intents with in-flight payment: Feature B handles conflict resolution
---
## Validation Rules (Application Layer)
These rules are enforced in the NestJS DTO/service layer, NOT as database constraints:
|
 Rule 
|
 Scope 
|
 Error Message 
|
|
------
|
-------
|
---------------
|
|
`infants ≤ adults`
|
 Cross-field 
|
 "Number of infants cannot exceed number of adults" 
|
|
`adults + children + infants ≤ 9`
|
 Cross-field 
|
 "Total passengers cannot exceed 9" 
|
|
`adults ≥ 1`
|
 Field 
|
 "At least one adult passenger is required" 
|
|
`givenName`
 required 
|
 Per-passenger 
|
 "Given name is required for all passengers" 
|
|
`familyName`
 required 
|
 Per-passenger 
|
 "Family name is required for all passengers" 
|
|
`dateOfBirth`
 required 
|
 Per-passenger 
|
 "Date of birth is required for all passengers" 
|
|
`gender`
 must be 
`male`
 or 
`female`
|
 Per-passenger 
|
 "Gender must be 'male' or 'female'" 
|
|
 Passenger count matches 
`adults + children + infants`
|
 Cross-field 
|
 "Passenger details count must match the declared passenger breakdown" 
|
---
## Relationship to Existing Models
```
User (1) ──→ (many) BookingIntent
User (1) ──→ (0..1) TravelerProfile  [pre-fill source, unchanged]
FlightOffer (1) ──→ (many) BookingIntent  [optional FK, SetNull on delete]
BookingIntent (1) ──→ (many) BookingIntentPassenger  [cascade delete]
```
**No changes to existing models.** The `User`, `TravelerProfile`, `FlightOffer`, and `Booking` models remain unchanged. `BookingIntent` references them via foreign keys.