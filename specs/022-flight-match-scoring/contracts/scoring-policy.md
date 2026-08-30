# Contract: Flight Match Scoring Policy v1

## Pure service boundary

The authoritative in-process contract is conceptually:

```typescript
scoreAll(offers: readonly FlightMatchInput[], preferences: Readonly<ScoringPreferences>): readonly ScoredOffer[]
rank(offers: readonly FlightMatchInput[]): readonly RankedOffer[]
```

Both operations are deterministic, side-effect free, do not mutate arguments, and retain an `originalIndex` stable-order fallback. `scoreAll` performs eligibility before reference-set calculation and scoring.

## Dimensions and base weights

| Dimension | Pool | Base weight | Missing-data behavior |
|---|---|---:|---|
| `PRICE` | baseline | 0.20 | Always available for valid finite price |
| `AIRLINE` | personalized | 0.15 | Missing preferred list releases weight; blacklist remains eligibility-only |
| `ARRIVAL_SCHEDULE` | personalized | 0.15 | Missing window releases weight |
| `STOPS` | baseline | 0.12 | Always available for valid integer stops |
| `CABIN` | personalized | 0.10 | Missing class releases weight |
| `DEPARTURE_SCHEDULE` | personalized | 0.10 | Missing window releases weight |
| `BAGGAGE` | personalized | 0.10 | `null` releases weight |
| `DURATION` | baseline | 0.08 | Always available for positive finite duration |

Policy order above is also the required breakdown order and deterministic remainder order, with baseline remainder preference `PRICE`, `STOPS`, `DURATION`.

## Eligibility

Normalize all carrier codes with trim + uppercase, discard invalid/empty values, and de-duplicate. If any offer marketing or operating code appears in `blacklistedAirlines`, return:

```json
{
  "eligible": false,
  "violations": [
    {
      "constraint": "BLACKLISTED_AIRLINE",
      "explanation": {
        "key": "constraint.airline.blacklisted",
        "params": { "airline": "XX" }
      }
    }
  ]
}
```

Blacklisted offers remain in response order after all eligible offers and are excluded from medians and variance.

## Weight allocation

1. Start with base weights.
2. Release missing personalized weights to the baseline target pool, increasing it above 0.40 when applicable.
3. With at least two eligible offers, collapse dimensions whose normalized sub-scores have zero variance at six-decimal precision.
4. Redistribute the full baseline target proportionally across active baseline weights.
5. Redistribute personalized collapsed weight in its pool only up to original personalized caps; flow the remainder to baseline.
6. If all baseline dimensions are zero-variance, cancel their collapse and distribute the entire baseline target across PRICE/STOPS/DURATION in the 20:12:8 ratio. For airline-only personalization this yields 0.425/0.255/0.170 plus AIRLINE 0.150.
7. Assign the final six-decimal rounding remainder deterministically to the highest-priority active baseline dimension.

For every eligible scored offer: `sum(activeWeights) == 1.000000`.

## Score and level

`contribution = round6(subScore * effectiveWeight)`.

`score = clamp(roundHalfAwayFromZero(sum(contribution) * 100), 0, 100)`.

Dimension signals use the rounded sub-score: `POSITIVE >= 0.67`, `NEUTRAL >= 0.34 and < 0.67`, and `NEGATIVE < 0.34`.

| Level | Inclusive score |
|---|---|
| `STRONG` | 75–100 |
| `GOOD` | 50–74 |
| `FAIR` | 25–49 |
| `WEAK` | 0–24 |

## Stable ordering

### MATCHED

1. eligible before ineligible;
2. score descending;
3. stops ascending;
4. price ascending;
5. duration ascending;
6. departure red-eye penalty ascending;
7. original index ascending.

### RANKED

1. stops ascending;
2. price ascending;
3. duration ascending;
4. departure red-eye penalty ascending;
5. original index ascending.

Red-eye penalty is `1` for outbound departure local hours 00–04 and `0` otherwise.

## Explanation allowlist

Initial keys include:

- `match.price.below_median`, `match.price.at_median`, `match.price.above_median`
- `match.airline.preferred`, `match.airline.neutral`
- `match.arrival.in_window`, `match.arrival.near_window`, `match.arrival.outside_window`
- `match.stops.within_preference`, `match.stops.exceeds_preference`, `match.stops.relative`
- `match.cabin.exact`, `match.cabin.adjacent`, `match.cabin.mismatch`
- `match.departure.in_window`, `match.departure.near_window`, `match.departure.outside_window`
- `match.baggage.checked_included`, `match.baggage.checked_missing`, `match.baggage.not_required`
- `match.duration.below_median`, `match.duration.at_median`, `match.duration.above_median`
- `constraint.airline.blacklisted`

Parameter schemas are key-specific and admit only primitive safe display values. Browser explanations may use the ADR-approved non-PII match facts (airline display name, offer/window times, percentage differences, and stop counts). Unknown keys or parameters fail contract validation at server boundaries. LLM projections may further reduce these to keys/safe summaries and must never receive PII, provider IDs, or unrelated profile fields.
