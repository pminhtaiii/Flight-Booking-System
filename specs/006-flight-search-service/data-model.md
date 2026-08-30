# Data Model: Duffel Flight Search Service

**Feature**: 006-flight-search-service
**Date**: 2026-07-07

## New Entities

### FlightOffer

Stores raw Duffel flight offer data for retrieval on the flight detail page. Hard-purged by a cron job after a configurable retention window.

| Field         | Type          | Constraints             | Description                                                 |
| ------------- | ------------- | ----------------------- | ----------------------------------------------------------- |
| id            | UUID          | PK, auto-generated      | Internal offer identifier (used in URLs)                    |
| searchHash    | String        | Indexed, not null       | SHA-256 of the normalized search query (links to cache key) |
| duffelOfferId | String        | Not null                | The Duffel-assigned offer ID (e.g., "off_xxx")              |
| rawOffer      | JSON          | Not null                | Full Duffel offer object as returned by the API             |
| origin        | String(3)     | Not null                | Origin IATA airport code                                    |
| destination   | String(3)     | Not null                | Destination IATA airport code                               |
| departureDate | Date          | Not null                | Departure date                                              |
| returnDate    | Date          | Nullable                | Return date (null for one-way)                              |
| passengers    | Int           | Not null, min 1         | Number of passengers                                        |
| price         | Decimal(10,2) | Not null                | Total price of the offer                                    |
| currency      | String        | Not null, default "USD" | ISO 4217 currency code                                      |
| createdAt     | DateTime      | Auto, indexed           | Timestamp of record creation                                |

**Indexes**: `searchHash`, `createdAt` (for cron cleanup queries)
**Table name**: `flight_offers`
**Retention**: Configurable via `FLIGHT_OFFERS_RETENTION_DAYS` env var (default: 7 days)

**Relationships**:

- No foreign keys to `User` — offers are shared across users (same search = same offers)
- Linked to `SearchHistory` conceptually via `searchHash`, but no FK constraint (different lifecycles)

---

### SearchHistory

Lightweight metadata about each search performed. Preserved indefinitely for dashboard analytics (Top Destinations, Spending by Month) and future "Recently Searched" features.

| Field         | Type          | Constraints                     | Description                                  |
| ------------- | ------------- | ------------------------------- | -------------------------------------------- |
| id            | UUID          | PK, auto-generated              | Record identifier                            |
| userId        | String        | FK → User.id, indexed, not null | The user who performed the search            |
| origin        | String(3)     | Not null                        | Origin IATA airport code                     |
| destination   | String(3)     | Not null                        | Destination IATA airport code                |
| departureDate | Date          | Not null                        | Departure date searched                      |
| returnDate    | Date          | Nullable                        | Return date searched (null for one-way)      |
| passengers    | Int           | Not null, min 1                 | Number of passengers searched                |
| resultCount   | Int           | Not null                        | Number of flight offers returned             |
| minPrice      | Decimal(10,2) | Nullable                        | Lowest price in results (null if 0 results)  |
| maxPrice      | Decimal(10,2) | Nullable                        | Highest price in results (null if 0 results) |
| currency      | String        | Not null, default "USD"         | Currency of prices                           |
| searchHash    | String        | Not null                        | SHA-256 linking to the cached/stored offers  |
| createdAt     | DateTime      | Auto                            | Timestamp of the search                      |

**Indexes**: `userId`, `createdAt`, composite `[userId, createdAt]`
**Table name**: `search_history`
**Retention**: Indefinite (never purged)

**Relationships**:

- `userId` → `User.id` (cascade delete — if user is deleted, their search history is removed)

---

### OfferRecovery

Stores the durable mapping from `offerId` (UUID) to `searchHash` (SHA-256) so that the `410 Gone` recovery path can find the original search parameters for pre-filling a new search, even after the bulky raw `FlightOffer` row is cleaned up.

| Field      | Type     | Constraints   | Description                                          |
| ---------- | -------- | ------------- | ---------------------------------------------------- |
| id         | UUID     | PK            | The offer UUID that was generated during search      |
| searchHash | String   | Not null      | SHA-256 linking to the search query                  |
| createdAt  | DateTime | Auto, indexed | Timestamp of record creation (for cleanup retention) |

**Indexes**: `createdAt`
**Table name**: `offer_recoveries`
**Retention**: Configurable via `OFFER_RECOVERY_RETENTION_DAYS` (default: 30 days)

---

## Modified Entities

### User (existing)

Add relation to `SearchHistory`:

| Change       | Detail                                        |
| ------------ | --------------------------------------------- |
| Add relation | `searchHistory SearchHistory[]` — one-to-many |

No schema changes to `User` columns — only a Prisma relation field.

---

## Prisma Schema Additions

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
  passengers      Int
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
  passengers      Int
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

model OfferRecovery {
  id          String   @id // The offer UUID
  searchHash  String
  createdAt   DateTime @default(now())

  @@index([createdAt])
  @@map("offer_recoveries")
}
```

---

## State Transitions

### FlightOffer Lifecycle

```
Created (async write-behind after search)
    → Active (available for detail page lookup)
    → Expired (past retention window, purged by cron)
```

No explicit status column — expiry is determined by `createdAt` + retention window comparison during cron execution.

### Search Flow State

```
User submits search
    → Cache check (Redis)
        → HIT: return cached raw response
        → MISS: budget check → Duffel offer_request → cache raw response
    → Transform raw → user DTO (20 results)
    → Return response to user
    → Async write-behind: FlightOffer rows + SearchHistory row (parallel)
```
