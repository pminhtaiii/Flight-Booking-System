import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ConstraintTypeSchema,
  ConstraintViolationSchema,
  DimensionScoreSchema,
  DimensionSignalSchema,
  EligibleFlightMatchResultSchema,
  ExplanationSchema,
  FlightMatchDimensionSchema,
  FlightMatchMetadataSchema,
  FlightMatchResultSchema,
  FlightSearchMetaSchema,
  FlightSearchOfferViewSchema,
  FlightSearchOutcomeSchema,
  FlightSearchQuerySchema,
  FlightSearchSuccessOutcomeSchema,
  FlightSelectionOutcomeSchema,
  IneligibleFlightMatchResultSchema,
  MatchLevelSchema,
  type ConstraintType,
  type ConstraintViolation,
  type DimensionScore,
  type DimensionSignal,
  type EligibleFlightMatchResult,
  type Explanation,
  type FlightMatchDimension,
  type FlightMatchMetadata,
  type FlightMatchResult,
  type FlightSearchOutcome,
  type FlightSearchSuccessOutcome,
  type FlightSelectionOutcome,
  type IneligibleFlightMatchResult,
  type MatchLevel,
} from './flight-search.types';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Assert<Condition extends true> = Condition;

type ExpectedFlightSelectionOutcome =
  | { ok: true; checkoutPath: string }
  | {
      ok: false;
      reason: 'OFFER_EXPIRED' | 'OFFER_UNAVAILABLE' | 'UNAUTHENTICATED';
      message: string;
      retryable: boolean;
    };
type FlightSelectionOutcomeInferenceParity = Assert<
  Equal<FlightSelectionOutcome, ExpectedFlightSelectionOutcome>
>;
void (0 as unknown as FlightSelectionOutcomeInferenceParity);

type ExpectedDimension =
  | 'PRICE'
  | 'AIRLINE'
  | 'ARRIVAL_SCHEDULE'
  | 'STOPS'
  | 'CABIN'
  | 'DEPARTURE_SCHEDULE'
  | 'BAGGAGE'
  | 'DURATION';
type DimensionInferenceParity = Assert<Equal<FlightMatchDimension, ExpectedDimension>>;
void (0 as unknown as DimensionInferenceParity);

type ExpectedSignal = 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE';
type SignalInferenceParity = Assert<Equal<DimensionSignal, ExpectedSignal>>;
void (0 as unknown as SignalInferenceParity);

type ExpectedMatchLevel = 'STRONG' | 'GOOD' | 'FAIR' | 'WEAK';
type MatchLevelInferenceParity = Assert<Equal<MatchLevel, ExpectedMatchLevel>>;
void (0 as unknown as MatchLevelInferenceParity);

type ExpectedExplanation = {
  key: string;
  params: Record<string, string | number | boolean>;
};
type ExplanationInferenceParity = Assert<Equal<Explanation, ExpectedExplanation>>;
void (0 as unknown as ExplanationInferenceParity);

type ExpectedDimensionScore = {
  dimension: ExpectedDimension;
  score: number;
  weight: number;
  contribution: number;
  signal: ExpectedSignal;
  explanation: ExpectedExplanation;
};
type DimensionScoreInferenceParity = Assert<Equal<DimensionScore, ExpectedDimensionScore>>;
void (0 as unknown as DimensionScoreInferenceParity);

type ExpectedConstraintType = 'BLACKLISTED_AIRLINE';
type ConstraintTypeInferenceParity = Assert<Equal<ConstraintType, ExpectedConstraintType>>;
void (0 as unknown as ConstraintTypeInferenceParity);

type ExpectedConstraintViolation = {
  constraint: ExpectedConstraintType;
  explanation: ExpectedExplanation;
};
type ConstraintViolationInferenceParity = Assert<
  Equal<ConstraintViolation, ExpectedConstraintViolation>
>;
void (0 as unknown as ConstraintViolationInferenceParity);

type ExpectedFlightMatchMetadata = {
  scoringVersion: 'flight-match-v1';
  activeWeights: Partial<Record<ExpectedDimension, number>>;
};
type MetadataInferenceParity = Assert<
  Equal<FlightMatchMetadata, ExpectedFlightMatchMetadata>
>;
void (0 as unknown as MetadataInferenceParity);

type ExpectedEligibleResult = {
  eligibility: {
    eligible: true;
    violations: ConstraintViolation[];
  };
  score: number;
  matchLevel: ExpectedMatchLevel;
  breakdown: DimensionScore[];
  metadata: FlightMatchMetadata;
};
type EligibleResultParity = Assert<Equal<EligibleFlightMatchResult, ExpectedEligibleResult>>;
void (0 as unknown as EligibleResultParity);

type ExpectedIneligibleResult = {
  eligibility: {
    eligible: false;
    violations: ConstraintViolation[];
  };
  score: null;
  matchLevel: null;
  breakdown: DimensionScore[];
  metadata: FlightMatchMetadata;
};
type IneligibleResultParity = Assert<Equal<IneligibleFlightMatchResult, ExpectedIneligibleResult>>;
void (0 as unknown as IneligibleResultParity);

type FlightMatchResultParity = Assert<
  Equal<FlightMatchResult, EligibleFlightMatchResult | IneligibleFlightMatchResult>
>;
void (0 as unknown as FlightMatchResultParity);

const offer = {
  id: 'local-offer-01',
  price: 250.5,
  currency: 'USD',
  airline: 'Vietnam Airlines',
  flightNumber: 'VN123',
  origin: 'SGN',
  destination: 'HAN',
  departureAt: '2026-09-01T09:00:00Z',
  arrivalAt: '2026-09-01T11:10:00Z',
  duration: 'PT2H10M',
  stops: 0,
  slices: [
    {
      origin: 'SGN',
      destination: 'HAN',
      departureAt: '2026-09-01T09:00:00Z',
      arrivalAt: '2026-09-01T11:10:00Z',
      duration: 'PT2H10M',
      stops: 0,
      segments: [
        {
          airline: 'Vietnam Airlines',
          flightNumber: 'VN123',
          origin: 'SGN',
          destination: 'HAN',
          departureAt: '2026-09-01T09:00:00Z',
          arrivalAt: '2026-09-01T11:10:00Z',
          duration: 'PT2H10M',
          cabinClass: 'economy',
        },
      ],
    },
  ],
};

const futureDate = (daysFromToday: number): string => {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + daysFromToday);
  return date.toISOString().slice(0, 10);
};

const validQuery = {
  origin: 'SGN',
  destination: 'HAN',
  departureDate: futureDate(2),
  returnDate: null,
  adults: 1,
  children: 0,
  infants: 0,
  cabinClass: 'economy' as const,
};

describe('Flight Search shared contracts', () => {
  it('parses valid query and success outcome', () => {
    assert.equal(FlightSearchQuerySchema.parse(validQuery).origin, 'SGN');

    const parsed: FlightSearchOutcome = FlightSearchOutcomeSchema.parse({
      ok: true,
      offers: [offer],
      meta: {
        totalCount: 1,
        currency: 'USD',
        minPrice: 250.5,
        maxPrice: 250.5,
        airlines: ['Vietnam Airlines'],
      },
    });
    assert.equal(parsed.ok, true);
  });

  it('parses valid search and selection failure outcomes', () => {
    assert.deepEqual(
      FlightSearchOutcomeSchema.parse({
        ok: false,
        reason: 'RATE_LIMITED',
        message: 'Try again shortly',
        retryable: true,
      }),
      { ok: false, reason: 'RATE_LIMITED', message: 'Try again shortly', retryable: true },
    );
    assert.deepEqual(
      FlightSelectionOutcomeSchema.parse({
        ok: false,
        reason: 'OFFER_EXPIRED',
        message: 'Choose another offer',
        retryable: true,
      }),
      { ok: false, reason: 'OFFER_EXPIRED', message: 'Choose another offer', retryable: true },
    );
  });

  it('parses a valid selection success outcome', () => {
    assert.deepEqual(
      FlightSelectionOutcomeSchema.parse({ ok: true, checkoutPath: '/checkout/local-offer-01' }),
      { ok: true, checkoutPath: '/checkout/local-offer-01' },
    );
  });

  it('rejects unexpected provider fields, malformed values, and unsupported reasons', () => {
    assert.throws(() => FlightSearchOfferViewSchema.parse({ ...offer, duffelOfferId: 'off_123' }));
    assert.throws(() =>
      FlightSearchQuerySchema.parse({
        origin: 'sgn',
        destination: 'HAN',
        departureDate: '2026/09/01',
        returnDate: null,
        adults: 0,
        children: 0,
        infants: 0,
        cabinClass: 'economy',
      }),
    );
    assert.throws(() =>
      FlightSearchOutcomeSchema.parse({
        ok: false,
        reason: 'PROVIDER_ERROR',
        message: 'No',
        retryable: false,
      }),
    );
    assert.throws(() => FlightSelectionOutcomeSchema.parse({ ok: true }));
  });

  it('rejects semantically invalid search queries', () => {
    assert.throws(() => FlightSearchQuerySchema.parse({ ...validQuery, destination: 'SGN' }));
    assert.throws(() =>
      FlightSearchQuerySchema.parse({ ...validQuery, adults: 8, children: 1, infants: 1 }),
    );
    assert.throws(() => FlightSearchQuerySchema.parse({ ...validQuery, infants: 2 }));
    assert.throws(() =>
      FlightSearchQuerySchema.parse({
        ...validQuery,
        departureDate: futureDate(3),
        returnDate: futureDate(2),
      }),
    );
    assert.throws(() =>
      FlightSearchQuerySchema.parse({ ...validQuery, departureDate: '2026-02-31' }),
    );
    assert.throws(() =>
      FlightSearchQuerySchema.parse({ ...validQuery, departureDate: '2000-01-01' }),
    );
  });
});

const validDimensionScore: DimensionScore = {
  dimension: 'PRICE',
  score: 0.85,
  weight: 0.2,
  contribution: 0.17,
  signal: 'POSITIVE',
  explanation: {
    key: 'match.price.below_median',
    params: { difference: '15%' },
  },
};

const validMetadata: FlightMatchMetadata = {
  scoringVersion: 'flight-match-v1',
  activeWeights: {
    PRICE: 0.2,
    AIRLINE: 0.15,
    ARRIVAL_SCHEDULE: 0.15,
    STOPS: 0.12,
    CABIN: 0.1,
    DEPARTURE_SCHEDULE: 0.1,
    BAGGAGE: 0.1,
    DURATION: 0.08,
  },
};

const validEligibleMatchResult: EligibleFlightMatchResult = {
  eligibility: {
    eligible: true,
    violations: [],
  },
  score: 82,
  matchLevel: 'STRONG',
  breakdown: [validDimensionScore],
  metadata: validMetadata,
};

const validIneligibleMatchResult: IneligibleFlightMatchResult = {
  eligibility: {
    eligible: false,
    violations: [
      {
        constraint: 'BLACKLISTED_AIRLINE',
        explanation: {
          key: 'constraint.airline.blacklisted',
          params: { airline: 'XX' },
        },
      },
    ],
  },
  score: null,
  matchLevel: null,
  breakdown: [],
  metadata: validMetadata,
};

describe('T001: MATCHED eligibility, score, matchLevel, and breakdown schemas', () => {
  it('parses valid dimensions, signals, and match levels', () => {
    const dimensions = [
      'PRICE',
      'AIRLINE',
      'ARRIVAL_SCHEDULE',
      'STOPS',
      'CABIN',
      'DEPARTURE_SCHEDULE',
      'BAGGAGE',
      'DURATION',
    ] as const;
    for (const d of dimensions) {
      assert.equal(FlightMatchDimensionSchema.parse(d), d);
    }
    assert.throws(() => FlightMatchDimensionSchema.parse('DISTANCE'));

    for (const s of ['POSITIVE', 'NEUTRAL', 'NEGATIVE'] as const) {
      assert.equal(DimensionSignalSchema.parse(s), s);
    }
    assert.throws(() => DimensionSignalSchema.parse('AVERAGE'));

    for (const l of ['STRONG', 'GOOD', 'FAIR', 'WEAK'] as const) {
      assert.equal(MatchLevelSchema.parse(l), l);
    }
    assert.throws(() => MatchLevelSchema.parse('EXCELLENT'));
  });

  it('parses valid EligibleFlightMatchResult and enforces score range (0..100) and match levels', () => {
    const parsed = EligibleFlightMatchResultSchema.parse(validEligibleMatchResult);
    assert.equal(parsed.eligibility.eligible, true);
    assert.equal(parsed.score, 82);
    assert.equal(parsed.matchLevel, 'STRONG');
    assert.equal(parsed.breakdown.length, 1);

    // Score boundary tests
    assert.equal(
      EligibleFlightMatchResultSchema.parse({ ...validEligibleMatchResult, score: 0 }).score,
      0,
    );
    assert.equal(
      EligibleFlightMatchResultSchema.parse({ ...validEligibleMatchResult, score: 100 }).score,
      100,
    );

    // Rejects out of bound scores or float scores
    assert.throws(() =>
      EligibleFlightMatchResultSchema.parse({ ...validEligibleMatchResult, score: -1 }),
    );
    assert.throws(() =>
      EligibleFlightMatchResultSchema.parse({ ...validEligibleMatchResult, score: 101 }),
    );
    assert.throws(() =>
      EligibleFlightMatchResultSchema.parse({ ...validEligibleMatchResult, score: 82.5 }),
    );

    // Rejects eligible with non-empty violations
    assert.throws(() =>
      EligibleFlightMatchResultSchema.parse({
        ...validEligibleMatchResult,
        eligibility: {
          eligible: true,
          violations: [
            {
              constraint: 'BLACKLISTED_AIRLINE',
              explanation: { key: 'constraint.airline.blacklisted', params: {} },
            },
          ],
        },
      }),
    );
  });

  it('parses valid IneligibleFlightMatchResult and enforces null score/level and empty breakdown', () => {
    const parsed = IneligibleFlightMatchResultSchema.parse(validIneligibleMatchResult);
    assert.equal(parsed.eligibility.eligible, false);
    assert.equal(parsed.score, null);
    assert.equal(parsed.matchLevel, null);
    assert.deepEqual(parsed.breakdown, []);
    assert.equal(parsed.eligibility.violations.length, 1);

    // Rejects non-null score or level for ineligible
    assert.throws(() =>
      IneligibleFlightMatchResultSchema.parse({ ...validIneligibleMatchResult, score: 50 }),
    );
    assert.throws(() =>
      IneligibleFlightMatchResultSchema.parse({ ...validIneligibleMatchResult, matchLevel: 'FAIR' }),
    );

    // Rejects empty violations for ineligible
    assert.throws(() =>
      IneligibleFlightMatchResultSchema.parse({
        ...validIneligibleMatchResult,
        eligibility: { eligible: false, violations: [] },
      }),
    );

    // Rejects non-empty breakdown for ineligible
    assert.throws(() =>
      IneligibleFlightMatchResultSchema.parse({
        ...validIneligibleMatchResult,
        breakdown: [validDimensionScore],
      }),
    );
  });

  it('parses FlightMatchResult union for both eligible and ineligible variants', () => {
    const parsedEligible = FlightMatchResultSchema.parse(validEligibleMatchResult);
    assert.equal(parsedEligible.eligibility.eligible, true);

    const parsedIneligible = FlightMatchResultSchema.parse(validIneligibleMatchResult);
    assert.equal(parsedIneligible.eligibility.eligible, false);

    assert.throws(() => FlightMatchResultSchema.parse({ unknown: true }));
  });

  it('validates DimensionScore constraints', () => {
    assert.equal(DimensionScoreSchema.parse(validDimensionScore).dimension, 'PRICE');

    // Rejects score / weight / contribution out of range [0, 1]
    assert.throws(() => DimensionScoreSchema.parse({ ...validDimensionScore, score: -0.1 }));
    assert.throws(() => DimensionScoreSchema.parse({ ...validDimensionScore, score: 1.1 }));
    assert.throws(() => DimensionScoreSchema.parse({ ...validDimensionScore, weight: -0.01 }));
    assert.throws(() => DimensionScoreSchema.parse({ ...validDimensionScore, weight: 1.01 }));
    assert.throws(() => DimensionScoreSchema.parse({ ...validDimensionScore, contribution: -0.1 }));
    assert.throws(() => DimensionScoreSchema.parse({ ...validDimensionScore, contribution: 1.5 }));
  });
});

describe('T002: RANKED nullability, active weights, explanation params, and provider-ID rejection', () => {
  it('allows matchResult to be null, omitted, or a valid FlightMatchResult in FlightSearchOfferViewSchema', () => {
    // matchResult null (RANKED mode)
    const offerWithNullMatch = FlightSearchOfferViewSchema.parse({
      ...offer,
      matchResult: null,
    });
    assert.equal(offerWithNullMatch.matchResult, null);

    // matchResult omitted (legacy/unspecified)
    const offerWithoutMatch = FlightSearchOfferViewSchema.parse(offer);
    assert.equal(offerWithoutMatch.matchResult, undefined);

    // matchResult with eligible match result (MATCHED mode)
    const offerWithEligibleMatch = FlightSearchOfferViewSchema.parse({
      ...offer,
      matchResult: validEligibleMatchResult,
    });
    assert.equal(offerWithEligibleMatch.matchResult?.score, 82);

    // matchResult with ineligible match result
    const offerWithIneligibleMatch = FlightSearchOfferViewSchema.parse({
      ...offer,
      matchResult: validIneligibleMatchResult,
    });
    assert.equal(offerWithIneligibleMatch.matchResult?.score, null);
  });

  it('strictly rejects provider-ID and supplier keys in FlightSearchOfferViewSchema', () => {
    assert.throws(() =>
      FlightSearchOfferViewSchema.parse({
        ...offer,
        duffelOfferId: 'off_123456',
      }),
    );
    assert.throws(() =>
      FlightSearchOfferViewSchema.parse({
        ...offer,
        supplierOfferId: 'sup_999',
      }),
    );
    assert.throws(() =>
      FlightSearchOfferViewSchema.parse({
        ...offer,
        rawOffer: {},
      }),
    );
  });

  it('validates FlightMatchMetadata active weights precision and keys', () => {
    const parsed = FlightMatchMetadataSchema.parse(validMetadata);
    assert.equal(parsed.scoringVersion, 'flight-match-v1');
    assert.equal(parsed.activeWeights.PRICE, 0.2);

    // Rejects unknown scoring version
    assert.throws(() =>
      FlightMatchMetadataSchema.parse({
        ...validMetadata,
        scoringVersion: 'flight-match-v2',
      }),
    );

    // Rejects negative weights or weights > 1
    assert.throws(() =>
      FlightMatchMetadataSchema.parse({
        ...validMetadata,
        activeWeights: { ...validMetadata.activeWeights, PRICE: -0.1 },
      }),
    );
    assert.throws(() =>
      FlightMatchMetadataSchema.parse({
        ...validMetadata,
        activeWeights: { ...validMetadata.activeWeights, PRICE: 1.05 },
      }),
    );

    // Rejects unknown dimension keys in activeWeights
    assert.throws(() =>
      FlightMatchMetadataSchema.parse({
        ...validMetadata,
        activeWeights: { ...validMetadata.activeWeights, INVALID_DIM: 0.5 },
      }),
    );
  });

  it('validates Explanation schema with key-specific primitive parameters and rejects non-primitives', () => {
    const validExplanation: Explanation = {
      key: 'match.price.below_median',
      params: {
        percentDiff: 15.5,
        currency: 'USD',
        isBest: true,
      },
    };
    const parsed = ExplanationSchema.parse(validExplanation);
    assert.equal(parsed.key, 'match.price.below_median');
    assert.equal(parsed.params.percentDiff, 15.5);
    assert.equal(parsed.params.currency, 'USD');
    assert.equal(parsed.params.isBest, true);

    // Rejects empty key
    assert.throws(() => ExplanationSchema.parse({ key: '', params: {} }));

    // Rejects non-primitive nested objects or arrays in params
    assert.throws(() =>
      ExplanationSchema.parse({
        key: 'match.price.below_median',
        params: { nested: { invalid: true } },
      }),
    );
    assert.throws(() =>
      ExplanationSchema.parse({
        key: 'match.price.below_median',
        params: { list: [1, 2, 3] },
      }),
    );
  });

  it('validates ConstraintViolation schema', () => {
    assert.equal(ConstraintTypeSchema.parse('BLACKLISTED_AIRLINE'), 'BLACKLISTED_AIRLINE');
    assert.throws(() => ConstraintTypeSchema.parse('WHITELISTED'));

    const violation: ConstraintViolation = {
      constraint: 'BLACKLISTED_AIRLINE',
      explanation: {
        key: 'constraint.airline.blacklisted',
        params: { airline: 'XX' },
      },
    };
    const parsed = ConstraintViolationSchema.parse(violation);
    assert.equal(parsed.constraint, 'BLACKLISTED_AIRLINE');
    assert.equal(parsed.explanation.params.airline, 'XX');

    assert.throws(() =>
      ConstraintViolationSchema.parse({
        constraint: 'INVALID_CONSTRAINT',
        explanation: { key: 'foo', params: {} },
      }),
    );
  });

  it('validates FlightSearchMetaSchema with optional scoringVersion, eligibleCount, and matchLevelCounts', () => {
    const metaWithScoring = FlightSearchMetaSchema.parse({
      totalCount: 1,
      currency: 'USD',
      minPrice: 250.5,
      maxPrice: 250.5,
      airlines: ['Vietnam Airlines'],
      scoringVersion: 'flight-match-v1',
      eligibleCount: 1,
      matchLevelCounts: {
        STRONG: 1,
        GOOD: 0,
        FAIR: 0,
        WEAK: 0,
      },
    });
    assert.equal(metaWithScoring.scoringVersion, 'flight-match-v1');
    assert.equal(metaWithScoring.eligibleCount, 1);
    assert.equal(metaWithScoring.matchLevelCounts?.STRONG, 1);

    // Accepts meta without optional scoring fields
    const baseMeta = FlightSearchMetaSchema.parse({
      totalCount: 1,
      currency: 'USD',
      minPrice: 250.5,
      maxPrice: 250.5,
      airlines: ['Vietnam Airlines'],
    });
    assert.equal(baseMeta.scoringVersion, undefined);
    assert.equal(baseMeta.eligibleCount, undefined);

    // Rejects invalid matchLevelCounts (e.g. negative numbers)
    assert.throws(() =>
      FlightSearchMetaSchema.parse({
        ...metaWithScoring,
        matchLevelCounts: { STRONG: -1, GOOD: 0, FAIR: 0, WEAK: 0 },
      }),
    );

    // Rejects unexpected provider fields in meta
    assert.throws(() =>
      FlightSearchMetaSchema.parse({
        ...metaWithScoring,
        duffelSearchId: 'sea_123',
      }),
    );
  });

  it('validates FlightSearchSuccessOutcomeSchema with mode MATCHED, RANKED, or omitted', () => {
    const matchedOutcome: FlightSearchSuccessOutcome = FlightSearchSuccessOutcomeSchema.parse({
      ok: true,
      mode: 'MATCHED',
      offers: [{ ...offer, matchResult: validEligibleMatchResult }],
      meta: {
        totalCount: 1,
        currency: 'USD',
        minPrice: 250.5,
        maxPrice: 250.5,
        airlines: ['Vietnam Airlines'],
      },
    });
    assert.equal(matchedOutcome.mode, 'MATCHED');

    const rankedOutcome: FlightSearchSuccessOutcome = FlightSearchSuccessOutcomeSchema.parse({
      ok: true,
      mode: 'RANKED',
      offers: [{ ...offer, matchResult: null }],
      meta: {
        totalCount: 1,
        currency: 'USD',
        minPrice: 250.5,
        maxPrice: 250.5,
        airlines: ['Vietnam Airlines'],
      },
    });
    assert.equal(rankedOutcome.mode, 'RANKED');

    // Also parses through FlightSearchOutcomeSchema union
    const parsedViaUnion = FlightSearchOutcomeSchema.parse(matchedOutcome);
    assert.equal(parsedViaUnion.ok, true);

    // Rejects invalid mode
    assert.throws(() =>
      FlightSearchSuccessOutcomeSchema.parse({
        ...matchedOutcome,
        mode: 'CUSTOM_SORT',
      }),
    );
  });
});
