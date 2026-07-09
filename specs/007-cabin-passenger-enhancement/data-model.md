# Data Model: Cabin Class & Passenger Type Enhancement

**Feature**: 007-cabin-passenger-enhancement
**Date**: 2026-07-09

## Modified Entities

### FlightOffer (existing — `flight_offers`)

| Change | Field | Type | Constraints | Description |
|--------|-------|------|-------------|-------------|
| DROP | ~~passengers~~ | ~~Int~~ | — | Replaced by flat breakdown |
| ADD | adults | Int | Not null, min 1 | Number of adult passengers |
| ADD | children | Int | Not null, default 0 | Number of child passengers (2–11) |
| ADD | infants | Int | Not null, default 0 | Number of infant passengers (under 2, on lap) |
| ADD | cabinClass | String | Not null, default "economy" | Requested cabin class |

### SearchHistory (existing — `search_history`)

| Change | Field | Type | Constraints | Description |
|--------|-------|------|-------------|-------------|
| DROP | ~~passengers~~ | ~~Int~~ | — | Replaced by flat breakdown |
| ADD | adults | Int | Not null, min 1 | Number of adult passengers |
| ADD | children | Int | Not null, default 0 | Number of child passengers (2–11) |
| ADD | infants | Int | Not null, default 0 | Number of infant passengers (under 2, on lap) |
| ADD | cabinClass | String | Not null, default "economy" | Requested cabin class |

---

## Prisma Schema Changes

```prisma
model FlightOffer {
  id              String   @id @default(uuid())
  searchHash      String
  duffelOfferId   String
  rawOffer        Json
  origin          String   @db.VarChar(3)
  destination     String   @db.VarChar(3)
  departureDate   DateTime @db.Date
  returnDate      DateTime? @db.Date
  // CHANGED: flat passenger breakdown replaces single passengers field
  adults          Int
  children        Int      @default(0)
  infants         Int      @default(0)
  cabinClass      String   @default("economy")
  price           Decimal  @db.Decimal(10, 2)
  currency        String   @default("USD")
  createdAt       DateTime @default(now())

  @@index([searchHash])
  @@index([createdAt])
  @@map("flight_offers")
}

model SearchHistory {
  id              String   @id @default(uuid())
  userId          String
  origin          String   @db.VarChar(3)
  destination     String   @db.VarChar(3)
  departureDate   DateTime @db.Date
  returnDate      DateTime? @db.Date
  // CHANGED: flat passenger breakdown replaces single passengers field
  adults          Int
  children        Int      @default(0)
  infants         Int      @default(0)
  cabinClass      String   @default("economy")
  resultCount     Int
  minPrice        Decimal? @db.Decimal(10, 2)
  maxPrice        Decimal? @db.Decimal(10, 2)
  currency        String   @default("USD")
  searchHash      String
  createdAt       DateTime @default(now())
  user            User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@index([createdAt])
  @@index([userId, createdAt])
  @@map("search_history")
}

// OfferRecovery — no changes needed (only stores id + searchHash)
```

---

## DTO Changes (Not Prisma — TypeScript)

### FlightSearchRequestDto

```typescript
class FlightSearchRequestDto {
  origin: string;          // existing
  destination: string;     // existing
  departureDate: string;   // existing
  returnDate?: string;     // existing
  // CHANGED: flat passenger breakdown
  adults: number;          // required, min 1, max 9
  children?: number;       // optional, default 0, min 0
  infants?: number;        // optional, default 0, min 0
  // NEW
  cabinClass: 'economy' | 'premium_economy' | 'business' | 'first';  // default 'economy'
}
```

**Validation rules**:
- `adults >= 1`
- `infants <= adults`
- `adults + (children ?? 0) + (infants ?? 0) <= 9`

### FlightSegmentDto — additions

```typescript
class FlightSegmentDto {
  // ... existing fields ...
  cabinClass: 'economy' | 'premium_economy' | 'business' | 'first';  // NEW
}
```

### FlightOfferDto — additions

```typescript
class FlightOfferDto {
  // ... existing fields ...
  requestedCabinClass: 'economy' | 'premium_economy' | 'business' | 'first';  // NEW
  cabinClassMatch: 'full' | 'mixed' | 'downgraded';                           // NEW
  cabinMismatchDetails: CabinMismatchDetail[] | null;                          // NEW
}

interface CabinMismatchDetail {
  segmentIndex: number;
  leg: 'outbound' | 'return';
  expected: string;
  actual: string;
  route: string;  // e.g., "SGN → HAN"
}
```

### FlightDetailResponseDto — additions

Inherits the same cabin class fields as `FlightOfferDto` plus the existing detail-specific fields.

### 410 Gone Recovery Object — additions

```typescript
recovery: {
  origin: string;
  destination: string;
  departureDate: string;
  returnDate: string | null;
  adults: number;       // NEW (replaces passengers)
  children: number;     // NEW
  infants: number;      // NEW
  cabinClass: string;   // NEW
}
```

---

## Cache Key Shape

```typescript
SHA-256(JSON.stringify({
  origin,
  destination,
  departureDate,
  returnDate,
  adults,
  children: children ?? 0,
  infants: infants ?? 0,
  cabinClass
}))
```

Redis key format: `flights:raw:${sha256}` (unchanged pattern, expanded input)

---

## State Transitions

No new state machines. The cabin match classification (`full`/`mixed`/`downgraded`) is computed at response time from the raw Duffel data — not stored as persistent state.

## Migration Strategy

Single Prisma migration:
1. Add `adults`, `children`, `infants`, `cabinClass` columns with defaults
2. Backfill: `UPDATE flight_offers SET adults = passengers, children = 0, infants = 0, cabin_class = 'economy'`
3. Backfill: `UPDATE search_history SET adults = passengers, children = 0, infants = 0, cabin_class = 'economy'`
4. Drop `passengers` column from both tables

Since this is development-only data, a simpler approach is acceptable: `prisma migrate reset` to recreate from scratch.
