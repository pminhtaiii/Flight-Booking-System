import { FlightMatchScorerService } from './flight-match-scorer.service';
import { BASE_WEIGHTS, SCORING_POLICY_VERSION } from './flight-match.policy';
import type {
  DimensionScore,
  FlightMatchInput,
  ScoringPreferences,
} from './flight-match.types';

type MedianComparison = 'below' | 'at' | 'above';
type BaselineDimension = Extract<DimensionScore['dimension'], 'PRICE' | 'DURATION'>;
type BaselineExplanationKey = Extract<
  DimensionScore['explanation']['key'],
  | `match.price.${MedianComparison}_median`
  | `match.duration.${MedianComparison}_median`
>;

const baseOffer: FlightMatchInput = {
  id: 'offer-1',
  price: 100,
  currency: 'USD',
  stops: 0,
  duration: 120,
  outboundDepartureHour: 9,
  outboundArrivalHour: 11,
  carrierCodes: ['AA'],
  cabinClass: 'economy',
  hasCheckedBaggage: null,
  originalIndex: 0,
};

const basePreferences: ScoringPreferences = {
  preferredAirlines: [],
  blacklistedAirlines: [],
  classPreference: null,
  preferredDepartureWindow: null,
  preferredArrivalWindow: null,
  maxStops: null,
  priceSensitivity: null,
  requiresCheckedBaggage: null,
};

function offer(overrides: Partial<FlightMatchInput> = {}): FlightMatchInput {
  return { ...baseOffer, ...overrides };
}

function preferences(
  overrides: Partial<ScoringPreferences> = {},
): ScoringPreferences {
  return { ...basePreferences, ...overrides };
}

describe('FlightMatchScorerService eligibility (T023)', () => {
  const scorer = new FlightMatchScorerService();

  it('ignores invalid, empty, non-string, and malformed carrier codes', () => {
    const invalidCodes: readonly unknown[] = [
      '',
      '   ',
      'A',
      'ABCD',
      'A-',
      'A A',
      42,
      null,
      {},
      [],
    ];

    expect(
      scorer.checkEligibility(
        offer({ carrierCodes: invalidCodes as readonly string[] }),
        preferences({ blacklistedAirlines: invalidCodes as readonly string[] }),
      ),
    ).toEqual({ eligible: true, violations: [] });
  });

  it.each([
    {
      name: 'returns an eligible empty result when no carrier is blacklisted',
      input: offer({ carrierCodes: ['AA'] }),
      preferenceSnapshot: preferences({ blacklistedAirlines: ['DL'] }),
      expected: { eligible: true, violations: [] },
    },
    {
      name: 'normalizes whitespace and case before comparing blacklist codes',
      input: offer({ carrierCodes: [' aa ', 'DL'] }),
      preferenceSnapshot: preferences({ blacklistedAirlines: ['  Aa  '] }),
      expected: {
        eligible: false,
        violations: [
          {
            constraint: 'BLACKLISTED_AIRLINE',
            explanation: {
              key: 'constraint.airline.blacklisted',
              params: { airline: 'AA' },
            },
          },
        ],
      },
    },
    {
      name: 'gives blacklist precedence when a carrier is both preferred and blacklisted',
      input: offer({ carrierCodes: ['AA'] }),
      preferenceSnapshot: preferences({
        preferredAirlines: ['aa'],
        blacklistedAirlines: ['AA'],
      }),
      expected: {
        eligible: false,
        violations: [
          {
            constraint: 'BLACKLISTED_AIRLINE',
            explanation: {
              key: 'constraint.airline.blacklisted',
              params: { airline: 'AA' },
            },
          },
        ],
      },
    },
    {
      name: 'emits one violation for duplicated offer and blacklist codes',
      input: offer({ carrierCodes: ['AA', ' aa ', 'AA'] }),
      preferenceSnapshot: preferences({
        blacklistedAirlines: ['AA', ' aa ', 'AA'],
      }),
      expected: {
        eligible: false,
        violations: [
          {
            constraint: 'BLACKLISTED_AIRLINE',
            explanation: {
              key: 'constraint.airline.blacklisted',
              params: { airline: 'AA' },
            },
          },
        ],
      },
    },
    {
      name: 'preserves original normalized carrier order for distinct blacklisted codes',
      input: offer({ carrierCodes: ['DL', 'aa', 'UA', 'DL'] }),
      preferenceSnapshot: preferences({ blacklistedAirlines: ['UA', 'AA', 'DL'] }),
      expected: {
        eligible: false,
        violations: [
          {
            constraint: 'BLACKLISTED_AIRLINE',
            explanation: {
              key: 'constraint.airline.blacklisted',
              params: { airline: 'DL' },
            },
          },
          {
            constraint: 'BLACKLISTED_AIRLINE',
            explanation: {
              key: 'constraint.airline.blacklisted',
              params: { airline: 'AA' },
            },
          },
          {
            constraint: 'BLACKLISTED_AIRLINE',
            explanation: {
              key: 'constraint.airline.blacklisted',
              params: { airline: 'UA' },
            },
          },
        ],
      },
    },
  ])('$name', ({ input, preferenceSnapshot, expected }) => {
    expect(scorer.checkEligibility(input, preferenceSnapshot)).toEqual(expected);
  });
});

describe('FlightMatchScorerService result visibility (T024)', () => {
  const scorer = new FlightMatchScorerService();

  it('retains mixed eligible and ineligible offers in original input order', () => {
    const offers = [
      offer({ id: 'eligible-first', carrierCodes: ['DL'], originalIndex: 0 }),
      offer({ id: 'ineligible', carrierCodes: ['AA'], originalIndex: 1 }),
      offer({ id: 'eligible-last', carrierCodes: ['UA'], originalIndex: 2 }),
    ];

    const scoredOffers = scorer.scoreOffers(
      offers,
      preferences({ blacklistedAirlines: ['AA'] }),
    );

    expect(scoredOffers).toHaveLength(offers.length);
    expect(scoredOffers.map(({ offer: flightOffer }) => flightOffer.id)).toEqual([
      'eligible-first',
      'ineligible',
      'eligible-last',
    ]);
    expect(scoredOffers[0].matchResult.eligibility.eligible).toBe(true);
    expect(scoredOffers[1].matchResult).toEqual({
      eligibility: {
        eligible: false,
        violations: [
          {
            constraint: 'BLACKLISTED_AIRLINE',
            explanation: {
              key: 'constraint.airline.blacklisted',
              params: { airline: 'AA' },
            },
          },
        ],
      },
      score: null,
      matchLevel: null,
      breakdown: [],
      metadata: {
        scoringVersion: SCORING_POLICY_VERSION,
        activeWeights: BASE_WEIGHTS,
      },
    });
    expect(scoredOffers[2].matchResult.eligibility.eligible).toBe(true);
  });

  it('retains every offer when all offers are ineligible', () => {
    const scoredOffers = scorer.scoreOffers(
      [
        offer({ id: 'first', carrierCodes: ['AA'], originalIndex: 0 }),
        offer({ id: 'second', carrierCodes: ['DL'], originalIndex: 1 }),
      ],
      preferences({ blacklistedAirlines: ['AA', 'DL'] }),
    );

    expect(scoredOffers.map(({ offer: flightOffer }) => flightOffer.id)).toEqual([
      'first',
      'second',
    ]);
    expect(scoredOffers.every(({ matchResult }) => matchResult.score === null)).toBe(true);
    expect(scoredOffers.every(({ matchResult }) => matchResult.breakdown.length === 0)).toBe(true);
  });

  it('does not duplicate violations in a scored ineligible result', () => {
    const [scoredOffer] = scorer.scoreOffers(
      [offer({ carrierCodes: [' aa ', 'AA', 'AA'] })],
      preferences({ blacklistedAirlines: ['AA', ' aa '] }),
    );

    expect(scoredOffer.matchResult.eligibility).toEqual({
      eligible: false,
      violations: [
        {
          constraint: 'BLACKLISTED_AIRLINE',
          explanation: {
            key: 'constraint.airline.blacklisted',
            params: { airline: 'AA' },
          },
        },
      ],
    });
  });

  it('accepts recursively frozen inputs without mutation', () => {
    const frozenOffers = deepFreeze([
      offer({ id: 'frozen-eligible', carrierCodes: ['DL'] }),
      offer({ id: 'frozen-ineligible', carrierCodes: ['AA'] }),
    ]);
    const frozenPreferences = deepFreeze(
      preferences({ blacklistedAirlines: ['AA'] }),
    );
    const before = JSON.stringify({ frozenOffers, frozenPreferences });

    expect(() => scorer.scoreOffers(frozenOffers, frozenPreferences)).not.toThrow();
    expect(JSON.stringify({ frozenOffers, frozenPreferences })).toBe(before);
  });
});

describe('FlightMatchScorerService PRICE and DURATION curves (T025)', () => {
  const scorer = new FlightMatchScorerService();

  it('scores eligible offers against exact odd-set price and duration medians', () => {
    const results = scorer.scoreOffers([
      offer({ id: 'low', price: 80, duration: 100 }),
      offer({ id: 'median', price: 100, duration: 120 }),
      offer({ id: 'high', price: 120, duration: 140 }),
    ], preferences());

    expect(breakdownFor(results, 'low')).toEqual([
      dimensionScore('PRICE', 0.6, 0.2, 'NEUTRAL', 'match.price.below_median'),
      dimensionScore('DURATION', 0.583333, 0.08, 'NEUTRAL', 'match.duration.below_median'),
    ]);
    expect(breakdownFor(results, 'median')).toEqual([
      dimensionScore('PRICE', 0.5, 0.2, 'NEUTRAL', 'match.price.at_median'),
      dimensionScore('DURATION', 0.5, 0.08, 'NEUTRAL', 'match.duration.at_median'),
    ]);
    expect(breakdownFor(results, 'high')).toEqual([
      dimensionScore('PRICE', 0.4, 0.2, 'NEUTRAL', 'match.price.above_median'),
      dimensionScore('DURATION', 0.416667, 0.08, 'NEUTRAL', 'match.duration.above_median'),
    ]);
  });

  it('scores eligible offers against exact even-set price and duration medians', () => {
    const results = scorer.scoreOffers([
      offer({ id: 'low', price: 80, duration: 100 }),
      offer({ id: 'high', price: 120, duration: 140 }),
    ], preferences());

    expect(breakdownFor(results, 'low')).toEqual([
      dimensionScore('PRICE', 0.6, 0.2, 'NEUTRAL', 'match.price.below_median'),
      dimensionScore('DURATION', 0.583333, 0.08, 'NEUTRAL', 'match.duration.below_median'),
    ]);
    expect(breakdownFor(results, 'high')).toEqual([
      dimensionScore('PRICE', 0.4, 0.2, 'NEUTRAL', 'match.price.above_median'),
      dimensionScore('DURATION', 0.416667, 0.08, 'NEUTRAL', 'match.duration.above_median'),
    ]);
  });

  it('excludes extreme blacklisted offers from price and duration medians', () => {
    const results = scorer.scoreOffers(
      [
        offer({ id: 'eligible-low', price: 100, duration: 100, carrierCodes: ['DL'] }),
        offer({ id: 'eligible-high', price: 200, duration: 200, carrierCodes: ['UA'] }),
        offer({ id: 'blacklisted-extreme', price: 10000, duration: 10000, carrierCodes: ['AA'] }),
      ],
      preferences({ blacklistedAirlines: ['AA'] }),
    );

    expect(breakdownFor(results, 'eligible-low')).toEqual([
      dimensionScore('PRICE', 0.666667, 0.2, 'NEUTRAL', 'match.price.below_median'),
      dimensionScore('DURATION', 0.666667, 0.08, 'NEUTRAL', 'match.duration.below_median'),
    ]);
    expect(results[2].matchResult.score).toBeNull();
  });

  it.each([
    { id: 'below-negative-threshold', price: 132.0002, expectedScore: 0.339999, signal: 'NEGATIVE' },
    { id: 'at-neutral-threshold', price: 132, expectedScore: 0.34, signal: 'NEUTRAL' },
    { id: 'below-positive-threshold', price: 66.0002, expectedScore: 0.669999, signal: 'NEUTRAL' },
    { id: 'at-positive-threshold', price: 66, expectedScore: 0.67, signal: 'POSITIVE' },
  ])('applies PRICE signal threshold after rounding for $id', ({ id, price, expectedScore, signal }) => {
    const results = scorer.scoreOffers([
      offer({ id: 'reference-one', price: 100, duration: 100 }),
      offer({ id: 'reference-two', price: 100, duration: 100 }),
      offer({ id, price, duration: 100 }),
    ], preferences());

    const priceBreakdown = breakdownFor(results, id)[0];
    expect(priceBreakdown.score).toBe(expectedScore);
    expect(priceBreakdown.signal).toBe(signal);
  });

  it.each([
    { priceSensitivity: 'BUDGET' as const, expectedScore: 0.625 },
    { priceSensitivity: 'MODERATE' as const, expectedScore: 0.6 },
    { priceSensitivity: 'FLEXIBLE' as const, expectedScore: 0.575 },
    { priceSensitivity: null, expectedScore: 0.6 },
  ])('uses $priceSensitivity price sensitivity for the PRICE curve', ({ priceSensitivity, expectedScore }) => {
    const results = scorer.scoreOffers(
      [
        offer({ id: 'sensitivity-low', price: 80, duration: 100 }),
        offer({ id: 'sensitivity-median', price: 100, duration: 100 }),
        offer({ id: 'sensitivity-high', price: 120, duration: 100 }),
      ],
      preferences({ priceSensitivity }),
    );

    expect(breakdownFor(results, 'sensitivity-low')[0].score).toBe(expectedScore);
  });
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const nestedValue of Object.values(value)) {
      deepFreeze(nestedValue);
    }
  }
  return value;
}

function breakdownFor(
  scoredOffers: ReturnType<FlightMatchScorerService['scoreOffers']>,
  offerId: string,
): readonly DimensionScore[] {
  const scoredOffer = scoredOffers.find(({ offer: flightOffer }) => flightOffer.id === offerId);
  if (!scoredOffer || scoredOffer.matchResult.score === null) {
    throw new Error(`Expected an eligible scored offer with id ${offerId}`);
  }
  return scoredOffer.matchResult.breakdown;
}

function dimensionScore(
  dimension: BaselineDimension,
  score: number,
  weight: number,
  signal: DimensionScore['signal'],
  key: BaselineExplanationKey,
): DimensionScore {
  return {
    dimension,
    score,
    weight,
    contribution: Math.round(score * weight * 1_000_000) / 1_000_000,
    signal,
    explanation: { key, params: {} },
  };
}
