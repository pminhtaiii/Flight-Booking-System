# Data Model: Ancillary Seat and Baggage Checkout

## Design goals

- Keep BookingIntent as the user-owned checkout aggregate.
- Preserve supplier identities needed for validation and order creation.
- Enforce one seat per passenger/segment and one stored copy of journey-wide baggage.
- Bind payment to a validated, immutable snapshot version.
- Cascade cleanup with the existing intent lifecycle.

## BookingIntent additions

| Field                    | Type                     | Rules                                                                                                               |
| ------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `ancillaryVersion`       | Integer, default 0       | Increment atomically whenever a committed selection snapshot changes. Client updates require the version they read. |
| `ancillaryStatus`        | Enum                     | `EMPTY`, `DRAFT_COMMITTED`, `VALIDATED`, `STALE`; starts `EMPTY`.                                                   |
| `ancillaryCurrency`      | String(3), nullable      | Required once any selection is committed; must equal offer/payment currency.                                        |
| `seatTotal`              | Decimal(10,2), default 0 | Derived server-side from committed seat rows.                                                                       |
| `baggageTotal`           | Decimal(10,2), default 0 | Derived server-side from committed baggage rows.                                                                    |
| `ancillaryTotal`         | Decimal(10,2), default 0 | `seatTotal + baggageTotal`; stored for audit, recomputed during validation.                                         |
| `validatedTotal`         | Decimal(10,2), nullable  | Authoritative base-plus-ancillary total returned by commitment-time Duffel repricing.                               |
| `ancillariesValidatedAt` | DateTime, nullable       | Set with `VALIDATED`; cleared on selection change or supplier conflict.                                             |

The existing `confirmedPrice` remains the base-offer amount. Payment uses `validatedTotal` when the matching ancillary version is validated, or `confirmedPrice` when the committed selection is empty.

## AncillarySelection

Parent record for one committed snapshot version.

| Field                     | Type               | Rules                                                                           |
| ------------------------- | ------------------ | ------------------------------------------------------------------------------- |
| `id`                      | UUID               | Primary key.                                                                    |
| `bookingIntentId`         | UUID               | Unique active parent; cascade delete with BookingIntent.                        |
| `version`                 | Integer            | Mirrors BookingIntent `ancillaryVersion`; unique with intent.                   |
| `currency`                | String(3)          | Must equal BookingIntent/offer currency.                                        |
| `seatTotal`               | Decimal(10,2)      | Server-derived.                                                                 |
| `baggageTotal`            | Decimal(10,2)      | Server-derived.                                                                 |
| `total`                   | Decimal(10,2)      | Server-derived ancillary total.                                                 |
| `catalogFingerprint`      | String             | Hash of normalized supplier catalog used to validate the submitted IDs. No PII. |
| `committedAt`             | DateTime           | Audit/recovery timestamp.                                                       |
| `validatedAt`             | DateTime, nullable | Set only after authoritative validation/repricing.                              |
| `createdAt` / `updatedAt` | DateTime           | Standard timestamps.                                                            |

Relationship: one BookingIntent has zero or one active AncillarySelection; the version is retained on Payment to prove what was charged. If implementation keeps historical snapshots, active selection is referenced explicitly and `(bookingIntentId, version)` remains unique.

## SeatSelection

| Field                     | Type          | Rules                                                                   |
| ------------------------- | ------------- | ----------------------------------------------------------------------- |
| `id`                      | UUID          | Primary key.                                                            |
| `ancillarySelectionId`    | UUID          | Parent with cascade delete.                                             |
| `intentPassengerId`       | UUID          | Must belong to the same BookingIntent and not be a lap infant.          |
| `duffelPassengerId`       | String        | Supplier passenger identity captured from the offer.                    |
| `segmentId`               | String        | Supplier segment identity.                                              |
| `serviceId`               | String        | Authoritative Duffel service identity.                                  |
| `seatDesignator`          | String        | Display-only label such as `12A`; unique only inside a segment/catalog. |
| `amount`                  | Decimal(10,2) | Supplier amount validated at commit.                                    |
| `currency`                | String(3)     | Same as parent.                                                         |
| `createdAt` / `updatedAt` | DateTime      | Standard timestamps.                                                    |

Constraints:

- Unique `(ancillarySelectionId, intentPassengerId, segmentId)` — one seat per passenger per segment.
- Unique `(ancillarySelectionId, segmentId, serviceId)` — no duplicate service in the group.
- Server verifies passenger ownership, segment membership, service/passenger binding, and availability.

## BaggageSelection

| Field                     | Type                  | Rules                                                                                               |
| ------------------------- | --------------------- | --------------------------------------------------------------------------------------------------- |
| `id`                      | UUID                  | Primary key.                                                                                        |
| `ancillarySelectionId`    | UUID                  | Parent with cascade delete.                                                                         |
| `intentPassengerId`       | UUID                  | Must belong to the same BookingIntent.                                                              |
| `duffelPassengerId`       | String                | Supplier passenger identity.                                                                        |
| `serviceId`               | String                | Authoritative Duffel service identity.                                                              |
| `type`                    | Enum/string           | Normalized `CHECKED` or `CARRY_ON`; preserve unknown supplier values only in redacted catalog data. |
| `weightValue`             | Integer, nullable     | Supplier weight when present.                                                                       |
| `weightUnit`              | Enum/string, nullable | Normalized unit such as `kg`.                                                                       |
| `quantity`                | Integer               | Positive and within supplier maximum.                                                               |
| `amount`                  | Decimal(10,2)         | Per-service or normalized extended amount; contract must state which and use it consistently.       |
| `currency`                | String(3)             | Same as parent.                                                                                     |
| `createdAt` / `updatedAt` | DateTime              | Standard timestamps.                                                                                |

## BaggageSelectionSegment

Join table representing supplier coverage without duplicating the baggage purchase.

| Field                | Type   | Rules                       |
| -------------------- | ------ | --------------------------- |
| `baggageSelectionId` | UUID   | Parent with cascade delete. |
| `segmentId`          | String | One covered Duffel segment. |

Primary key: `(baggageSelectionId, segmentId)`.

Validation rejects overlapping baggage selections for the same passenger, normalized type/weight tier, and segment coverage when one is journey-wide and another covers an included segment.

## Payment addition

| Field                       | Type              | Rules                                                                                                           |
| --------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------- |
| `ancillarySelectionVersion` | Integer, nullable | Required when a non-empty ancillary snapshot contributes to `Payment.amount`; immutable after Payment creation. |

The Payment amount remains in minor currency units. The matching BookingIntent selection version must be `VALIDATED`, unexpired, and unchanged when payment is created.

## Supplier catalog (cache/read contract; not a database entity)

Normalized catalog contains:

- offer ID, currency, fetched-at timestamp, expiry/TTL, and PII-free fingerprint;
- ordered segments with origin/destination and availability state;
- Duffel passenger IDs mapped to local intent passenger IDs;
- seat-map cabins/rows/elements and available seat services;
- baggage services with passenger, segment coverage, type, weight, maximum quantity, amount, and currency.

Redis key: `seatmap:{duffelOfferId}`. TTL: 60 seconds. Reads with TTL `<=3` seconds and force-refresh requests fetch from Duffel.

## State transitions

```text
EMPTY
  | commit zero or more selections (version + 1)
  v
DRAFT_COMMITTED
  | authoritative catalog validation + Duffel repricing succeeds
  v
VALIDATED
  | selection change, version conflict recovery, offer/service becomes stale
  v
STALE
  | refreshed selection committed
  +----------------------------------------> DRAFT_COMMITTED
```

- Payment creation is allowed only from `VALIDATED` for the exact current version, or `EMPTY` when no services are selected.
- Intent expiry remains terminal and prevents any further selection/payment mutation.
- Booking confirmation copies only presentation/audit data required by the existing Booking read model; supplier order remains authoritative.

## Transactional invariants

1. Snapshot rows, totals, version increment, status, and audit event commit in one transaction.
2. External Duffel calls never occur inside the database transaction.
3. Payment amount is computed from server-authoritative values, never request totals.
4. Checkout revalidates intent ownership, status, expiry, snapshot version, and validation timestamp/catalog before Stripe.
5. A failed supplier order cannot result in a captured Stripe payment; existing compensation/recovery semantics remain authoritative.
6. BookingIntent cascade deletion removes selection rows; localStorage expiry is independent defense-in-depth.
