# Flight Match Scoring Phase 3 Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement T023-T025: blacklist eligibility, visible ineligible results with eligible-only reference sets, and continuous PRICE/DURATION baseline curves.

**Architecture:** Add one stateless `@Injectable()` NestJS service with no constructor dependencies or external I/O. `checkEligibility()` owns normalized hard-constraint evaluation; `scoreOffers()` evaluates eligibility for the complete input set before computing eligible-only medians and returns results in original input order. Until T026-T032 complete the remaining dimensions and final weight resolution, eligible aggregates use unchanged base weights and only implemented PRICE/DURATION contributions; the module remains unregistered until T035.

**Tech Stack:** TypeScript, NestJS `@Injectable()`, Jest, existing `flight-match.types.ts` and pure helpers from `flight-match.policy.ts`.

**Spec:** `GOAL.md`, `specs/022-flight-match-scoring/spec.md`, and `specs/022-flight-match-scoring/contracts/scoring-policy.md`

## Global Constraints

- Implement only T023, T024, and T025; do not implement T026-T032 behavior.
- The scorer has no Prisma, HTTP, Redis, cache, profile-loading, logging, or LLM dependency.
- Never mutate offers, nested offer fields, preferences, or nested preference fields.
- Normalize airline codes with trim plus uppercase, discard empty/invalid codes, and deduplicate.
- Blacklisting wins when a code is both preferred and blacklisted.
- Ineligible offers remain present, have `score: null`, `matchLevel: null`, and `breakdown: []`, and never enter medians or variance inputs.
- PRICE and DURATION sub-scores are rounded with `round6()` before `determineSignal()` is applied.
- Preserve input order; final eligibility/score sorting belongs to T032.
- Tests written during RED are immutable unless the user explicitly approves a correction.

---

### Task 1: T023 Eligibility Gate and Blacklist Precedence

**Files:**
- Create: `apps/api/src/flight-match/flight-match-scorer.service.ts`
- Create: `apps/api/src/flight-match/flight-match-scorer.service.spec.ts`

**Interfaces:**
- Consumes: `FlightMatchInput`, `ScoringPreferences`, and `EligibilityResult` from `flight-match.types.ts`.
- Produces: `checkEligibility(offer: FlightMatchInput, preferences: ScoringPreferences): EligibilityResult`.

- [ ] **Step 1: Write the failing eligibility tests**

Create table-driven Jest cases proving: an eligible offer returns `{ eligible: true, violations: [] }`; whitespace/case normalization finds a blacklisted carrier; a code present in both preference lists remains blacklisted; duplicate offer and preference codes create one violation; and two distinct blacklisted codes create one stable original-carrier-order violation per code. Assert the violation shape exactly:

```ts
{
  constraint: 'BLACKLISTED_AIRLINE',
  explanation: {
    key: 'constraint.airline.blacklisted',
    params: { airline: 'XX' },
  },
}
```

- [ ] **Step 2: Run RED**

Run from `apps/api`:

```powershell
& '.\node_modules\.bin\jest.CMD' --runInBand src/flight-match/flight-match-scorer.service.spec.ts
```

Expected: FAIL because `FlightMatchScorerService` does not exist.

- [ ] **Step 3: Implement the minimal eligibility gate**

Create a dependency-free `@Injectable()` class. Use a local normalizer that accepts only strings, applies `trim().toUpperCase()`, discards `''`, and deduplicates through a `Set`. Build the blacklist set once per call, iterate normalized offer carriers in stable order, and return exactly one violation per distinct matching code.

- [ ] **Step 4: Run GREEN**

Run the same Jest command and require all Task 1 cases to pass.

### Task 2: T024 Visible Ineligible Results and Reference Isolation

**Files:**
- Modify: `apps/api/src/flight-match/flight-match-scorer.service.ts`
- Modify: `apps/api/src/flight-match/flight-match-scorer.service.spec.ts`

**Interfaces:**
- Consumes: `checkEligibility()`, `BASE_WEIGHTS`, `SCORING_POLICY_VERSION`, `getMatchLevel()`, and immutable offer/preference arrays.
- Produces: `scoreOffers(offers: readonly FlightMatchInput[], preferences: ScoringPreferences): readonly ScoredOffer[]` in original input order.

- [ ] **Step 1: Write the failing visibility and immutability tests**

Add cases proving mixed eligible/ineligible input returns the same number of offers in the same order; an ineligible result has the exact null/empty shape plus policy metadata; all-ineligible input is retained; duplicate blacklisted codes do not duplicate violations; and recursively frozen offers/preferences can be passed without throwing or changing their serialized value.

- [ ] **Step 2: Run RED**

Run the focused Jest file and confirm failure because `scoreOffers()` is absent.

- [ ] **Step 3: Implement eligibility-first set evaluation**

Evaluate every offer once with `checkEligibility()`. Derive the reference array only from entries whose eligibility is true. Materialize every entry in original input order. Ineligible entries must be returned immediately with:

```ts
{
  eligibility,
  score: null,
  matchLevel: null,
  breakdown: [],
  metadata: {
    scoringVersion: SCORING_POLICY_VERSION,
    activeWeights: BASE_WEIGHTS,
  },
}
```

Do not sort and do not write to any input array/object.

- [ ] **Step 4: Run GREEN**

Run the focused Jest file and require all Task 1-2 cases to pass.

### Task 3: T025 Eligible-Only PRICE and DURATION Curves

**Files:**
- Modify: `apps/api/src/flight-match/flight-match-scorer.service.ts`
- Modify: `apps/api/src/flight-match/flight-match-scorer.service.spec.ts`
- Modify: `specs/022-flight-match-scoring/tasks.md`
- Modify after verification: `context/progress-checker.md`

**Interfaces:**
- Consumes: `calculateMedian()`, `clamp()`, `round6()`, `determineSignal()`, `getPriceSensitivityMultiplier()`, `BASE_WEIGHTS`, and eligible entries from Task 2.
- Produces: PRICE then DURATION `DimensionScore` entries for eligible offers; each entry contains rounded `score`, base `weight`, rounded `contribution`, signal, and allowlisted explanation.

- [ ] **Step 1: Write failing eligible-reference median tests**

Add odd/even fixtures with prices and durations whose medians are exact, plus a mixed fixture where an extreme blacklisted offer would alter both medians if incorrectly included. Assert PRICE and DURATION sub-scores against the formulas and confirm the mixed fixture matches the eligible-only expected values.

- [ ] **Step 2: Run RED**

Run the focused Jest file and confirm the eligible breakdown assertions fail.

- [ ] **Step 3: Implement median and curve helpers**

Compute each median once from eligible offers. For each eligible offer calculate:

```ts
const priceScore = round6(
  clamp(
    0.5 +
      0.5 *
        getPriceSensitivityMultiplier(preferences.priceSensitivity) *
        ((medianPrice - offer.price) / Math.max(medianPrice, 0.01)),
    0,
    1,
  ),
);

const durationScore = round6(
  clamp(
    0.5 + 0.5 * ((medianDuration - offer.duration) / Math.max(medianDuration, 1)),
    0,
    1,
  ),
);
```

Use below/at/above-median explanation keys based on the raw offer value versus the median. Use `determineSignal()` on the rounded sub-score. Set `weight` from `BASE_WEIGHTS`, and `contribution` to `round6(score * weight)`. The provisional aggregate is `clamp(roundHalfAwayFromZero(sum(contribution) * 100), 0, 100)` with `getMatchLevel()`; no redistribution or sorting occurs in this slice.

- [ ] **Step 4: Write and pass threshold/sensitivity tests**

Add cases that hit rounded sub-scores below `0.34`, exactly `0.34`, below `0.67`, and exactly `0.67`; assert NEGATIVE/NEUTRAL/POSITIVE boundaries. Add BUDGET (`1.25`), MODERATE (`1.0`), FLEXIBLE (`0.75`), and null/default price-sensitivity cases using the same median fixture.

- [ ] **Step 5: Run all focused tests and typecheck**

```powershell
Push-Location apps/api
& '.\node_modules\.bin\jest.CMD' --runInBand src/flight-match/flight-match-scorer.service.spec.ts
Pop-Location
pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit
```

Expected: both commands exit `0`.

- [ ] **Step 6: Refactor while green**

Remove duplication only within the scorer/spec, keep helpers private and pure, then rerun Step 5 unchanged.

- [ ] **Step 7: Record completion**

Mark only T023, T024, and T025 `[x]` in `specs/022-flight-match-scoring/tasks.md`. Update `context/progress-checker.md` with the exact test commands and outcomes; do not claim T026-T032 or full Phase 3 complete.

