# Data Model: Flight Match Scoring

## Persistent changes

Only the existing `TravelerProfile` record changes. Match results remain ephemeral.

### TravelerProfile additions

| Field | Prisma type | API shape | Default | Validation and normalization |
|---|---|---|---|---|
| `preferredDepartureWindow` | `Json?` | `{ start: integer, end: integer } \| null` | `null` | Hours 0–23; inclusive; `start > end` means overnight; unknown keys rejected |
| `preferredArrivalWindow` | `Json?` | `{ start: integer, end: integer } \| null` | `null` | Same rules as departure window |
| `maxStops` | `Int?` | `integer \| null` | `null` | 0–8; `null` means objective default |
| `priceSensitivity` | `String?` | `BUDGET \| MODERATE \| FLEXIBLE \| null` | `null` | Trimmed and uppercased at the boundary |
| `requiresCheckedBaggage` | `Boolean?` | `boolean \| null` | `null` | `null` unspecified; `false` is an explicit value |

The migration is additive and nullable. No existing row requires backfill. The existing `revision` field increments through the current optimistic-concurrency update path whenever any new field changes.

### Persistence invariants

- One profile remains owned by one authenticated user through unique `userId`.
- A profile update is atomic: either every validated field and the revision update commit or none do.
- Window JSON is parsed and validated before persistence and parsed again on read; malformed legacy/database values fail closed to `null` in the scoring projection and emit a PII-safe integrity metric.
- No match score, active weight, explanation, policy version, or supplier-offer association is persisted.

## Ephemeral domain models

### ScoringPreferences

PII-free normalized projection loaded by flight-search orchestration.

| Field | Type | Active when |
|---|---|---|
| `preferredAirlines` | normalized unique IATA carrier code array | non-empty |
| `blacklistedAirlines` | normalized unique IATA carrier code array | non-empty; eligibility only |
| `classPreference` | cabin enum or `null` | valid non-null |
| `preferredDepartureWindow` | `HourWindow \| null` | valid non-null |
| `preferredArrivalWindow` | `HourWindow \| null` | valid non-null |
| `maxStops` | integer or `null` | non-null; modifies baseline stops |
| `priceSensitivity` | sensitivity enum or `null` | non-null; modifies baseline price |
| `requiresCheckedBaggage` | boolean or `null` | non-null |

`hasPersonalization` is derived from these effective fields and is never stored.

### FlightMatchInput

Immutable normalized facts for one offer:

- `offerId`: opaque local identifier used only to reattach the result.
- `originalIndex`: non-negative supplier order index used only as the final stable tie-breaker.
- `price`, `currency`, `durationMinutes`, `stops`.
- `outboundDepartureAt`, `outboundArrivalAt` as validated offset-aware ISO instants/string values preserving supplier-local clock data.
- `longestSegmentCabin`.
- `carrierCodes`: deduplicated marketing and operating IATA codes.
- `carrierNamesByCode`: safe display lookup for explanation parameters.
- `includesCheckedBaggage`: offer-level normalized boolean using each slice's longest segment.

The scorer never receives Duffel offer IDs, raw slices, passenger PII, user IDs, or database records. Invalid offers are represented only as aggregate allowlisted rejection counts outside the scorer and are not part of medians or variance.

### FlightMatchPolicy

Versioned constant model:

- `version`: initial value `flight-match-v1`.
- `baseWeights`: exact eight-dimension map totaling 1.
- `precision`: six decimal places.
- `priceSensitivityMultipliers`.
- `scheduleShoulderHours`: six.
- `redEyeHours`: 00:00–04:59 for tie-breaking only.
- `matchLevelThresholds`.

### EligibilityResult

| Field | Type | Invariant |
|---|---|---|
| `eligible` | boolean | `false` when violations is non-empty |
| `violations` | `ConstraintViolation[]` | stable, de-duplicated order by carrier code |

### ConstraintViolation

- `constraint`: initially `BLACKLISTED_AIRLINE`.
- `explanation.key`: allowlisted key such as `constraint.airline.blacklisted`.
- `explanation.params`: key-specific primitive allowlist; may include approved non-PII match facts such as window bounds, but never PII, unrelated profile fields, raw supplier data, or provider IDs.

### DimensionScore

| Field | Type | Invariant |
|---|---|---|
| `dimension` | eight-value enum | unique per breakdown |
| `score` | number 0–1 | six-decimal deterministic precision |
| `weight` | number 0–1 | effective weight after redistribution |
| `contribution` | number 0–1 | rounded `score * weight` |
| `signal` | `POSITIVE \| NEUTRAL \| NEGATIVE` | policy-derived thresholds |
| `explanation` | safe key + primitive params | key allowlisted for dimension |

Breakdown order is policy order, not object/map iteration order.

### FlightMatchResult

- `eligibility: EligibilityResult`.
- `score: integer 0–100 | null`.
- `matchLevel: STRONG | GOOD | FAIR | WEAK | null`.
- `breakdown: DimensionScore[]` (empty for ineligible/all-ineligible no-score cases).
- `metadata.scoringVersion`.
- `metadata.activeWeights`: exact eight-dimension partial map; for a scored result values total 1.000000.

### FlightSearchResponse

Discriminated by `mode`:

- `MATCHED`: every offer has a non-null `matchResult` object, although its inner score/level can be null when ineligible; default order follows match policy.
- `RANKED`: every offer has `matchResult: null`; default order follows category ranker.
- Existing search metadata remains and gains PII-safe aggregate fields only where useful (`eligibleCount`, match-level counts, scoring version). Preference-derived values appear only inside key-specific browser explanation parameters, never in metadata, telemetry, LLM projections, or unrelated fields.

## State and data flow

```text
Owned TravelerProfile + cached/fresh Duffel offers
        │
        ├─ profile service → ScoringPreferences
        └─ flights mapper  → FlightMatchInput[]
                              │
                    hasPersonalization?
                       │             │
                      yes            no
                       │             │
             eligibility + scorer   category ranker
                       │             │
                  MATCHED response  RANKED response
                       └──────┬──────┘
                              │
               browser-safe / immediate gateway-safe projections
```

Raw offer persistence and recovery continue on the existing path before/alongside response mapping and upsert missing rows on both raw-cache hits and misses. Match output has no persistence transition. The agent's Redis `TrustedSearchSnapshot` stores existing selection/basic-flight facts only; score, level, weights, breakdown, explanations, and policy version are never written to it.
