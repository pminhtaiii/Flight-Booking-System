import { FlightMatchScorerService } from './flight-match-scorer.service';
import {
  BASE_WEIGHTS,
  POLICY_DIMENSION_ORDER,
  SCORING_POLICY_VERSION,
} from './flight-match.policy';
import type {
  DimensionScore,
  FlightMatchInput,
  ScoredOffer,
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
      dimensionScore('PRICE', 0.6, 0.2, 'NEUTRAL', 'match.price.below_median', { percentDiff: 20 }),
      dimensionScore('DURATION', 0.583333, 0.08, 'NEUTRAL', 'match.duration.below_median'),
    ]);
    expect(breakdownFor(results, 'median')).toEqual([
      dimensionScore('PRICE', 0.5, 0.2, 'NEUTRAL', 'match.price.at_median', { percentDiff: 0 }),
      dimensionScore('DURATION', 0.5, 0.08, 'NEUTRAL', 'match.duration.at_median'),
    ]);
    expect(breakdownFor(results, 'high')).toEqual([
      dimensionScore('PRICE', 0.4, 0.2, 'NEUTRAL', 'match.price.above_median', { percentDiff: -20 }),
      dimensionScore('DURATION', 0.416667, 0.08, 'NEUTRAL', 'match.duration.above_median'),
    ]);
  });

  it('scores eligible offers against exact even-set price and duration medians', () => {
    const results = scorer.scoreOffers([
      offer({ id: 'low', price: 80, duration: 100 }),
      offer({ id: 'high', price: 120, duration: 140 }),
    ], preferences());

    expect(breakdownFor(results, 'low')).toEqual([
      dimensionScore('PRICE', 0.6, 0.2, 'NEUTRAL', 'match.price.below_median', { percentDiff: 20 }),
      dimensionScore('DURATION', 0.583333, 0.08, 'NEUTRAL', 'match.duration.below_median'),
    ]);
    expect(breakdownFor(results, 'high')).toEqual([
      dimensionScore('PRICE', 0.4, 0.2, 'NEUTRAL', 'match.price.above_median', { percentDiff: -20 }),
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
      dimensionScore('PRICE', 0.666667, 0.2, 'NEUTRAL', 'match.price.below_median', { percentDiff: 33.333333 }),
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

describe('FlightMatchScorerService STOPS dimension and price sensitivity (T026)', () => {
  const scorer = new FlightMatchScorerService();

  describe('scorePrice explanation percentDiff', () => {
    it('passes positive percentDiff when price is below median', () => {
      const results = scorer.scoreOffers(
        [offer({ id: 'test-low', price: 80 }), offer({ id: 'test-med', price: 100 })],
        preferences(),
      );
      const priceScore = breakdownFor(results, 'test-low')[0];
      expect(priceScore.explanation).toEqual({
        key: 'match.price.below_median',
        params: { percentDiff: 11.111111 },
      });
    });

    it('passes 0 (not -0) percentDiff when price is exactly at median', () => {
      const results = scorer.scoreOffers(
        [offer({ id: 'test-exact', price: 100 })],
        preferences(),
      );
      const priceScore = breakdownFor(results, 'test-exact')[0];
      expect(priceScore.explanation).toEqual({
        key: 'match.price.at_median',
        params: { percentDiff: 0 },
      });
      // Type assertion needed to inspect percentDiff on explanation params union
      const params = priceScore.explanation.params as { percentDiff?: number };
      expect(Object.is(params.percentDiff, -0)).toBe(false);
    });

    it('passes negative percentDiff when price is above median', () => {
      const results = scorer.scoreOffers(
        [offer({ id: 'test-med', price: 100 }), offer({ id: 'test-high', price: 150 })],
        preferences(),
      );
      const priceScore = breakdownFor(results, 'test-high')[0];
      expect(priceScore.explanation).toEqual({
        key: 'match.price.above_median',
        params: { percentDiff: -20 },
      });
    });
  });

  describe('scoreStops with maxStops preference', () => {
    it('returns score 1.0, POSITIVE signal, and within_preference explanation when stops <= maxStops', () => {
      const flightOffer = offer({ stops: 0 });
      const prefs = preferences({ maxStops: 1 });
      const result = scorer.scoreStops(flightOffer, prefs, 0);

      expect(result).toEqual({
        dimension: 'STOPS',
        score: 1,
        weight: 0.12,
        contribution: 0.12,
        signal: 'POSITIVE',
        explanation: {
          key: 'match.stops.within_preference',
          params: { stops: 0, maxStops: 1 },
        },
      });
    });

    it('returns score 1.0 when stops exactly equals maxStops', () => {
      const flightOffer = offer({ stops: 1 });
      const prefs = preferences({ maxStops: 1 });
      const result = scorer.scoreStops(flightOffer, prefs, 0);

      expect(result).toEqual({
        dimension: 'STOPS',
        score: 1,
        weight: 0.12,
        contribution: 0.12,
        signal: 'POSITIVE',
        explanation: {
          key: 'match.stops.within_preference',
          params: { stops: 1, maxStops: 1 },
        },
      });
    });

    it('returns score 0.5, NEUTRAL signal, and exceeds_preference explanation when stops exceeds maxStops by 1', () => {
      const flightOffer = offer({ stops: 2 });
      const prefs = preferences({ maxStops: 1 });
      const result = scorer.scoreStops(flightOffer, prefs, 0);

      expect(result).toEqual({
        dimension: 'STOPS',
        score: 0.5,
        weight: 0.12,
        contribution: 0.06,
        signal: 'NEUTRAL',
        explanation: {
          key: 'match.stops.exceeds_preference',
          params: { stops: 2, maxStops: 1 },
        },
      });
    });

    it('returns score 0.0, NEGATIVE signal, and clamped score when stops exceeds maxStops by 2 or more', () => {
      const flightOffer = offer({ stops: 3 });
      const prefs = preferences({ maxStops: 1 });
      const result = scorer.scoreStops(flightOffer, prefs, 0);

      expect(result).toEqual({
        dimension: 'STOPS',
        score: 0,
        weight: 0.12,
        contribution: 0,
        signal: 'NEGATIVE',
        explanation: {
          key: 'match.stops.exceeds_preference',
          params: { stops: 3, maxStops: 1 },
        },
      });
    });

    it('clamps subScore to 0 when stops exceeds maxStops by 3 or more', () => {
      const flightOffer = offer({ stops: 4 });
      const prefs = preferences({ maxStops: 0 });
      const result = scorer.scoreStops(flightOffer, prefs, 0);

      expect(result.score).toBe(0);
      expect(result.contribution).toBe(0);
      expect(result.signal).toBe('NEGATIVE');
      expect(result.explanation).toEqual({
        key: 'match.stops.exceeds_preference',
        params: { stops: 4, maxStops: 0 },
      });
    });
  });

  describe('scoreStops without maxStops preference', () => {
    it.each([
      { maxStops: null },
      // Type assertion needed to test runtime resilience when preference is undefined at runtime
      { maxStops: undefined as unknown as null },
    ])('scores relative to minStops when maxStops is $maxStops', ({ maxStops }) => {
      const prefs = preferences({ maxStops });

      const zeroDiff = scorer.scoreStops(offer({ stops: 1 }), prefs, 1);
      expect(zeroDiff).toEqual({
        dimension: 'STOPS',
        score: 1,
        weight: 0.12,
        contribution: 0.12,
        signal: 'POSITIVE',
        explanation: {
          key: 'match.stops.relative',
          params: { stops: 1, minStops: 1 },
        },
      });

      const oneDiff = scorer.scoreStops(offer({ stops: 2 }), prefs, 1);
      expect(oneDiff).toEqual({
        dimension: 'STOPS',
        score: 0.5,
        weight: 0.12,
        contribution: 0.06,
        signal: 'NEUTRAL',
        explanation: {
          key: 'match.stops.relative',
          params: { stops: 2, minStops: 1 },
        },
      });

      const twoDiff = scorer.scoreStops(offer({ stops: 3 }), prefs, 1);
      expect(twoDiff).toEqual({
        dimension: 'STOPS',
        score: 0,
        weight: 0.12,
        contribution: 0,
        signal: 'NEGATIVE',
        explanation: {
          key: 'match.stops.relative',
          params: { stops: 3, minStops: 1 },
        },
      });
    });

    it('clamps subScore to 0 when stops exceeds minStops by more than 2', () => {
      const prefs = preferences({ maxStops: null });
      const result = scorer.scoreStops(offer({ stops: 5 }), prefs, 0);

      expect(result.score).toBe(0);
      expect(result.contribution).toBe(0);
      expect(result.signal).toBe('NEGATIVE');
      expect(result.explanation).toEqual({
        key: 'match.stops.relative',
        params: { stops: 5, minStops: 0 },
      });
    });
  });

  describe('scoreStops immutability and signal thresholds', () => {
    it('accepts frozen offer and preferences without mutation', () => {
      const frozenOffer = deepFreeze(offer({ stops: 2 }));
      const frozenPrefs = deepFreeze(preferences({ maxStops: 1 }));
      const beforeOffer = JSON.stringify(frozenOffer);
      const beforePrefs = JSON.stringify(frozenPrefs);

      expect(() => scorer.scoreStops(frozenOffer, frozenPrefs, 0)).not.toThrow();
      expect(JSON.stringify(frozenOffer)).toBe(beforeOffer);
      expect(JSON.stringify(frozenPrefs)).toBe(beforePrefs);
    });

    it('uses BASE_WEIGHTS.STOPS constant (0.12)', () => {
      const result = scorer.scoreStops(offer({ stops: 0 }), preferences(), 0);
      expect(result.weight).toBe(BASE_WEIGHTS.STOPS);
      expect(result.weight).toBe(0.12);
    });
  });

  describe('FlightMatchScorerService AIRLINE and CABIN dimensions (T027)', () => {
    describe('scoreAirline dimension', () => {
      it('returns score 1.0, POSITIVE signal, and match.airline.preferred when carrier matches preferred', () => {
        const flightOffer = offer({ carrierCodes: ['AA'] });
        const prefs = preferences({ preferredAirlines: ['AA'] });
        const result = scorer.scoreAirline(flightOffer, prefs);

        expect(result).toEqual({
          dimension: 'AIRLINE',
          score: 1,
          weight: BASE_WEIGHTS.AIRLINE,
          contribution: 0.15,
          signal: 'POSITIVE',
          explanation: {
            key: 'match.airline.preferred',
            params: { airline: 'AA' },
          },
        });
      });

      it('uses first matched normalized carrier code from offer when multiple match', () => {
        const flightOffer = offer({ carrierCodes: ['DL', 'AA'] });
        const prefs = preferences({ preferredAirlines: ['AA', 'DL'] });
        const result = scorer.scoreAirline(flightOffer, prefs);

        expect(result).toEqual({
          dimension: 'AIRLINE',
          score: 1,
          weight: BASE_WEIGHTS.AIRLINE,
          contribution: 0.15,
          signal: 'POSITIVE',
          explanation: {
            key: 'match.airline.preferred',
            params: { airline: 'DL' },
          },
        });
      });

      it('normalizes whitespace and case when matching carrier codes', () => {
        const flightOffer = offer({ carrierCodes: [' aa '] });
        const prefs = preferences({ preferredAirlines: ['  Aa  '] });
        const result = scorer.scoreAirline(flightOffer, prefs);

        expect(result).toEqual({
          dimension: 'AIRLINE',
          score: 1,
          weight: BASE_WEIGHTS.AIRLINE,
          contribution: 0.15,
          signal: 'POSITIVE',
          explanation: {
            key: 'match.airline.preferred',
            params: { airline: 'AA' },
          },
        });
      });

      it('returns score 0.5, NEUTRAL signal, and match.airline.neutral when carrier does not match preferred', () => {
        const flightOffer = offer({ carrierCodes: ['AA'] });
        const prefs = preferences({ preferredAirlines: ['DL'] });
        const result = scorer.scoreAirline(flightOffer, prefs);

        expect(result).toEqual({
          dimension: 'AIRLINE',
          score: 0.5,
          weight: BASE_WEIGHTS.AIRLINE,
          contribution: 0.075,
          signal: 'NEUTRAL',
          explanation: {
            key: 'match.airline.neutral',
            params: {},
          },
        });
      });

      it('returns score 0.5, NEUTRAL signal, and match.airline.neutral when preferredAirlines is empty', () => {
        const flightOffer = offer({ carrierCodes: ['AA'] });
        const prefs = preferences({ preferredAirlines: [] });
        const result = scorer.scoreAirline(flightOffer, prefs);

        expect(result).toEqual({
          dimension: 'AIRLINE',
          score: 0.5,
          weight: BASE_WEIGHTS.AIRLINE,
          contribution: 0.075,
          signal: 'NEUTRAL',
          explanation: {
            key: 'match.airline.neutral',
            params: {},
          },
        });
      });

      it('returns score 0.5 when preferredAirlines contains only invalid codes', () => {
        const flightOffer = offer({ carrierCodes: ['AA'] });
        // Type assertion needed to verify runtime tolerance against malformed non-string airline codes
        const prefs = preferences({ preferredAirlines: ['  ', 'TOOLONG', 42 as unknown as string] });
        const result = scorer.scoreAirline(flightOffer, prefs);

        expect(result).toEqual({
          dimension: 'AIRLINE',
          score: 0.5,
          weight: BASE_WEIGHTS.AIRLINE,
          contribution: 0.075,
          signal: 'NEUTRAL',
          explanation: {
            key: 'match.airline.neutral',
            params: {},
          },
        });
      });

      it('accepts frozen offer and preferences without mutation in scoreAirline', () => {
        const frozenOffer = deepFreeze(offer({ carrierCodes: ['AA', 'DL'] }));
        const frozenPrefs = deepFreeze(preferences({ preferredAirlines: ['AA'] }));
        const beforeOffer = JSON.stringify(frozenOffer);
        const beforePrefs = JSON.stringify(frozenPrefs);

        expect(() => scorer.scoreAirline(frozenOffer, frozenPrefs)).not.toThrow();
        expect(JSON.stringify(frozenOffer)).toBe(beforeOffer);
        expect(JSON.stringify(frozenPrefs)).toBe(beforePrefs);
      });

      it('uses BASE_WEIGHTS.AIRLINE constant (0.15)', () => {
        const result = scorer.scoreAirline(offer({ carrierCodes: ['AA'] }), preferences());
        expect(result.weight).toBe(BASE_WEIGHTS.AIRLINE);
        expect(result.weight).toBe(0.15);
      });
    });

    describe('scoreCabin dimension', () => {
      it('returns score 1.0, POSITIVE signal, and match.cabin.exact explanation for exact cabin match', () => {
        const flightOffer = offer({ cabinClass: 'economy' });
        const prefs = preferences({ classPreference: 'economy' });
        const result = scorer.scoreCabin(flightOffer, prefs);

        expect(result).toEqual({
          dimension: 'CABIN',
          score: 1,
          weight: BASE_WEIGHTS.CABIN,
          contribution: 0.1,
          signal: 'POSITIVE',
          explanation: {
            key: 'match.cabin.exact',
            params: { expected: 'economy', actual: 'economy' },
          },
        });
      });

      it('handles case-insensitivity and whitespace in classPreference for exact match', () => {
        const flightOffer = offer({ cabinClass: 'business' });
        const prefs = preferences({ classPreference: '  Business  ' });
        const result = scorer.scoreCabin(flightOffer, prefs);

        expect(result).toEqual({
          dimension: 'CABIN',
          score: 1,
          weight: BASE_WEIGHTS.CABIN,
          contribution: 0.1,
          signal: 'POSITIVE',
          explanation: {
            key: 'match.cabin.exact',
            params: { expected: '  Business  ', actual: 'business' },
          },
        });
      });

      it('returns score 0.5, NEUTRAL signal, and match.cabin.adjacent explanation for distance 1', () => {
        const flightOffer = offer({ cabinClass: 'premium_economy' });
        const prefs = preferences({ classPreference: 'economy' });
        const result = scorer.scoreCabin(flightOffer, prefs);

        expect(result).toEqual({
          dimension: 'CABIN',
          score: 0.5,
          weight: BASE_WEIGHTS.CABIN,
          contribution: 0.05,
          signal: 'NEUTRAL',
          explanation: {
            key: 'match.cabin.adjacent',
            params: { expected: 'economy', actual: 'premium_economy' },
          },
        });
      });

      it('returns score 0.5 for adjacent cabins between business and first', () => {
        const flightOffer = offer({ cabinClass: 'first' });
        const prefs = preferences({ classPreference: 'business' });
        const result = scorer.scoreCabin(flightOffer, prefs);

        expect(result.score).toBe(0.5);
        expect(result.signal).toBe('NEUTRAL');
        expect(result.contribution).toBe(0.05);
        expect(result.explanation).toEqual({
          key: 'match.cabin.adjacent',
          params: { expected: 'business', actual: 'first' },
        });
      });

      it('returns score 0.0, NEGATIVE signal, and match.cabin.mismatch explanation for distance >= 2', () => {
        const flightOffer = offer({ cabinClass: 'business' });
        const prefs = preferences({ classPreference: 'economy' });
        const result = scorer.scoreCabin(flightOffer, prefs);

        expect(result).toEqual({
          dimension: 'CABIN',
          score: 0,
          weight: BASE_WEIGHTS.CABIN,
          contribution: 0,
          signal: 'NEGATIVE',
          explanation: {
            key: 'match.cabin.mismatch',
            params: { expected: 'economy', actual: 'business' },
          },
        });
      });

      it('returns score 0.0 and match.cabin.mismatch when classPreference is null', () => {
        const flightOffer = offer({ cabinClass: 'economy' });
        const prefs = preferences({ classPreference: null });
        const result = scorer.scoreCabin(flightOffer, prefs);

        expect(result).toEqual({
          dimension: 'CABIN',
          score: 0,
          weight: BASE_WEIGHTS.CABIN,
          contribution: 0,
          signal: 'NEGATIVE',
          explanation: {
            key: 'match.cabin.mismatch',
            params: { expected: undefined, actual: 'economy' },
          },
        });
      });

      it('returns score 0.0 and match.cabin.mismatch when classPreference is invalid', () => {
        const flightOffer = offer({ cabinClass: 'economy' });
        const prefs = preferences({ classPreference: 'unknown_cabin' });
        const result = scorer.scoreCabin(flightOffer, prefs);

        expect(result).toEqual({
          dimension: 'CABIN',
          score: 0,
          weight: BASE_WEIGHTS.CABIN,
          contribution: 0,
          signal: 'NEGATIVE',
          explanation: {
            key: 'match.cabin.mismatch',
            params: { expected: 'unknown_cabin', actual: 'economy' },
          },
        });
      });

      it('accepts frozen offer and preferences without mutation in scoreCabin', () => {
        const frozenOffer = deepFreeze(offer({ cabinClass: 'business' }));
        const frozenPrefs = deepFreeze(preferences({ classPreference: 'economy' }));
        const beforeOffer = JSON.stringify(frozenOffer);
        const beforePrefs = JSON.stringify(frozenPrefs);

        expect(() => scorer.scoreCabin(frozenOffer, frozenPrefs)).not.toThrow();
        expect(JSON.stringify(frozenOffer)).toBe(beforeOffer);
        expect(JSON.stringify(frozenPrefs)).toBe(beforePrefs);
      });

      it('uses BASE_WEIGHTS.CABIN constant (0.10)', () => {
        const result = scorer.scoreCabin(offer({ cabinClass: 'economy' }), preferences());
        expect(result.weight).toBe(BASE_WEIGHTS.CABIN);
        expect(result.weight).toBe(0.10);
      });
    });
  });

  describe('FlightMatchScorerService SCHEDULE and BAGGAGE dimensions (T028)', () => {
    describe('scoreDepartureSchedule dimension', () => {
      it('returns score 1.0, POSITIVE signal, and match.departure.in_window for hour inside window', () => {
        const flightOffer = offer({ outboundDepartureHour: 9 });
        const prefs = preferences({ preferredDepartureWindow: { start: 8, end: 12 } });
        const result = scorer.scoreDepartureSchedule(flightOffer, prefs);

        expect(result).toEqual({
          dimension: 'DEPARTURE_SCHEDULE',
          score: 1,
          weight: BASE_WEIGHTS.DEPARTURE_SCHEDULE,
          contribution: 0.1,
          signal: 'POSITIVE',
          explanation: {
            key: 'match.departure.in_window',
            params: { time: '09:00', windowStart: 8, windowEnd: 12 },
          },
        });
      });

      it('returns score 1.0 on exact window boundary hours', () => {
        const prefs = preferences({ preferredDepartureWindow: { start: 8, end: 12 } });
        const startResult = scorer.scoreDepartureSchedule(offer({ outboundDepartureHour: 8 }), prefs);
        const endResult = scorer.scoreDepartureSchedule(offer({ outboundDepartureHour: 12 }), prefs);

        expect(startResult.score).toBe(1);
        expect(startResult.explanation.key).toBe('match.departure.in_window');
        expect(endResult.score).toBe(1);
        expect(endResult.explanation.key).toBe('match.departure.in_window');
      });

      it.each([
        { hour: 7, dist: 1, expectedScore: 0.833333, expectedSignal: 'POSITIVE' as const, key: 'match.departure.near_window' as const },
        { hour: 14, dist: 2, expectedScore: 0.666667, expectedSignal: 'NEUTRAL' as const, key: 'match.departure.near_window' as const },
        { hour: 15, dist: 3, expectedScore: 0.5, expectedSignal: 'NEUTRAL' as const, key: 'match.departure.near_window' as const },
        { hour: 16, dist: 4, expectedScore: 0.333333, expectedSignal: 'NEGATIVE' as const, key: 'match.departure.outside_window' as const },
        { hour: 17, dist: 5, expectedScore: 0.166667, expectedSignal: 'NEGATIVE' as const, key: 'match.departure.outside_window' as const },
        { hour: 18, dist: 6, expectedScore: 0, expectedSignal: 'NEGATIVE' as const, key: 'match.departure.outside_window' as const },
        { hour: 20, dist: 8, expectedScore: 0, expectedSignal: 'NEGATIVE' as const, key: 'match.departure.outside_window' as const },
      ])('decays linearly over 6-hour shoulder for hour $hour (dist $dist)', ({ hour, expectedScore, expectedSignal, key }) => {
        const flightOffer = offer({ outboundDepartureHour: hour });
        const prefs = preferences({ preferredDepartureWindow: { start: 8, end: 12 } });
        const result = scorer.scoreDepartureSchedule(flightOffer, prefs);

        expect(result.score).toBe(expectedScore);
        expect(result.signal).toBe(expectedSignal);
        expect(result.explanation.key).toBe(key);
        expect(result.explanation.params).toEqual({
          time: `${String(hour).padStart(2, '0')}:00`,
          windowStart: 8,
          windowEnd: 12,
        });
      });

      it('correctly evaluates overnight windows (start > end)', () => {
        const prefs = preferences({ preferredDepartureWindow: { start: 22, end: 6 } });

        // in-window hours
        const h23 = scorer.scoreDepartureSchedule(offer({ outboundDepartureHour: 23 }), prefs);
        expect(h23.score).toBe(1);
        expect(h23.explanation.key).toBe('match.departure.in_window');

        const h2 = scorer.scoreDepartureSchedule(offer({ outboundDepartureHour: 2 }), prefs);
        expect(h2.score).toBe(1);
        expect(h2.explanation.key).toBe('match.departure.in_window');

        // boundary hours
        const h22 = scorer.scoreDepartureSchedule(offer({ outboundDepartureHour: 22 }), prefs);
        expect(h22.score).toBe(1);
        const h6 = scorer.scoreDepartureSchedule(offer({ outboundDepartureHour: 6 }), prefs);
        expect(h6.score).toBe(1);

        // shoulder hour: 7 is dist 1 from 6
        const h7 = scorer.scoreDepartureSchedule(offer({ outboundDepartureHour: 7 }), prefs);
        expect(h7.score).toBe(0.833333);
        expect(h7.explanation.key).toBe('match.departure.near_window');

        // shoulder hour: 21 is dist 1 from 22
        const h21 = scorer.scoreDepartureSchedule(offer({ outboundDepartureHour: 21 }), prefs);
        expect(h21.score).toBe(0.833333);
        expect(h21.explanation.key).toBe('match.departure.near_window');

        // outside shoulder: hour 14 is circular distance 8 from both 6 and 22
        const h14 = scorer.scoreDepartureSchedule(offer({ outboundDepartureHour: 14 }), prefs);
        expect(h14.score).toBe(0);
        expect(h14.explanation.key).toBe('match.departure.outside_window');
      });

      it('returns neutral 0.5 score and near_window when preferredDepartureWindow is null or undefined', () => {
        const flightOffer = offer({ outboundDepartureHour: 9 });
        const nullResult = scorer.scoreDepartureSchedule(flightOffer, preferences({ preferredDepartureWindow: null }));

        expect(nullResult).toEqual({
          dimension: 'DEPARTURE_SCHEDULE',
          score: 0.5,
          weight: BASE_WEIGHTS.DEPARTURE_SCHEDULE,
          contribution: 0.05,
          signal: 'NEUTRAL',
          explanation: {
            key: 'match.departure.near_window',
            params: { time: '09:00' },
          },
        });

        const undefinedResult = scorer.scoreDepartureSchedule(
          offer({ outboundDepartureHour: 15 }),
          // Type assertion needed to test runtime resilience when window preference is undefined at runtime
          preferences({ preferredDepartureWindow: undefined as unknown as null }),
        );
        expect(undefinedResult.score).toBe(0.5);
        expect(undefinedResult.explanation).toEqual({
          key: 'match.departure.near_window',
          params: { time: '15:00' },
        });
      });

      it('accepts frozen offer and preferences without mutation in scoreDepartureSchedule', () => {
        const frozenOffer = deepFreeze(offer({ outboundDepartureHour: 9 }));
        const frozenPrefs = deepFreeze(preferences({ preferredDepartureWindow: { start: 8, end: 12 } }));
        const beforeOffer = JSON.stringify(frozenOffer);
        const beforePrefs = JSON.stringify(frozenPrefs);

        expect(() => scorer.scoreDepartureSchedule(frozenOffer, frozenPrefs)).not.toThrow();
        expect(JSON.stringify(frozenOffer)).toBe(beforeOffer);
        expect(JSON.stringify(frozenPrefs)).toBe(beforePrefs);
      });

      it('uses BASE_WEIGHTS.DEPARTURE_SCHEDULE constant (0.10)', () => {
        const result = scorer.scoreDepartureSchedule(offer({ outboundDepartureHour: 9 }), preferences());
        expect(result.weight).toBe(BASE_WEIGHTS.DEPARTURE_SCHEDULE);
        expect(result.weight).toBe(0.10);
      });
    });

    describe('scoreArrivalSchedule dimension', () => {
      it('returns score 1.0, POSITIVE signal, and match.arrival.in_window for hour inside window', () => {
        const flightOffer = offer({ outboundArrivalHour: 16 });
        const prefs = preferences({ preferredArrivalWindow: { start: 14, end: 18 } });
        const result = scorer.scoreArrivalSchedule(flightOffer, prefs);

        expect(result).toEqual({
          dimension: 'ARRIVAL_SCHEDULE',
          score: 1,
          weight: BASE_WEIGHTS.ARRIVAL_SCHEDULE,
          contribution: 0.15,
          signal: 'POSITIVE',
          explanation: {
            key: 'match.arrival.in_window',
            params: { time: '16:00', windowStart: 14, windowEnd: 18 },
          },
        });
      });

      it('returns score 1.0 on exact boundary hours', () => {
        const prefs = preferences({ preferredArrivalWindow: { start: 14, end: 18 } });
        const startResult = scorer.scoreArrivalSchedule(offer({ outboundArrivalHour: 14 }), prefs);
        const endResult = scorer.scoreArrivalSchedule(offer({ outboundArrivalHour: 18 }), prefs);

        expect(startResult.score).toBe(1);
        expect(startResult.explanation.key).toBe('match.arrival.in_window');
        expect(endResult.score).toBe(1);
        expect(endResult.explanation.key).toBe('match.arrival.in_window');
      });

      it.each([
        { hour: 13, dist: 1, expectedScore: 0.833333, expectedContribution: 0.125, expectedSignal: 'POSITIVE' as const, key: 'match.arrival.near_window' as const },
        { hour: 20, dist: 2, expectedScore: 0.666667, expectedContribution: 0.1, expectedSignal: 'NEUTRAL' as const, key: 'match.arrival.near_window' as const },
        { hour: 21, dist: 3, expectedScore: 0.5, expectedContribution: 0.075, expectedSignal: 'NEUTRAL' as const, key: 'match.arrival.near_window' as const },
        { hour: 22, dist: 4, expectedScore: 0.333333, expectedContribution: 0.05, expectedSignal: 'NEGATIVE' as const, key: 'match.arrival.outside_window' as const },
        { hour: 23, dist: 5, expectedScore: 0.166667, expectedContribution: 0.025, expectedSignal: 'NEGATIVE' as const, key: 'match.arrival.outside_window' as const },
        { hour: 0, dist: 6, expectedScore: 0, expectedContribution: 0, expectedSignal: 'NEGATIVE' as const, key: 'match.arrival.outside_window' as const },
        { hour: 4, dist: 10, expectedScore: 0, expectedContribution: 0, expectedSignal: 'NEGATIVE' as const, key: 'match.arrival.outside_window' as const },
      ])('decays linearly over 6-hour shoulder for hour $hour (dist $dist)', ({ hour, expectedScore, expectedContribution, expectedSignal, key }) => {
        const flightOffer = offer({ outboundArrivalHour: hour });
        const prefs = preferences({ preferredArrivalWindow: { start: 14, end: 18 } });
        const result = scorer.scoreArrivalSchedule(flightOffer, prefs);

        expect(result.score).toBe(expectedScore);
        expect(result.contribution).toBe(expectedContribution);
        expect(result.signal).toBe(expectedSignal);
        expect(result.explanation.key).toBe(key);
        expect(result.explanation.params).toEqual({
          time: `${String(hour).padStart(2, '0')}:00`,
          windowStart: 14,
          windowEnd: 18,
        });
      });

      it('correctly evaluates overnight windows (start > end)', () => {
        const prefs = preferences({ preferredArrivalWindow: { start: 20, end: 2 } });

        // in-window hours
        const h23 = scorer.scoreArrivalSchedule(offer({ outboundArrivalHour: 23 }), prefs);
        expect(h23.score).toBe(1);
        expect(h23.explanation.key).toBe('match.arrival.in_window');

        const h1 = scorer.scoreArrivalSchedule(offer({ outboundArrivalHour: 1 }), prefs);
        expect(h1.score).toBe(1);
        expect(h1.explanation.key).toBe('match.arrival.in_window');

        // boundary hours
        const h20 = scorer.scoreArrivalSchedule(offer({ outboundArrivalHour: 20 }), prefs);
        expect(h20.score).toBe(1);
        const h2 = scorer.scoreArrivalSchedule(offer({ outboundArrivalHour: 2 }), prefs);
        expect(h2.score).toBe(1);

        // shoulder hour: 3 is dist 1 from 2
        const h3 = scorer.scoreArrivalSchedule(offer({ outboundArrivalHour: 3 }), prefs);
        expect(h3.score).toBe(0.833333);
        expect(h3.explanation.key).toBe('match.arrival.near_window');

        // outside shoulder: hour 11 is circular distance 9 from both 2 and 20
        const h11 = scorer.scoreArrivalSchedule(offer({ outboundArrivalHour: 11 }), prefs);
        expect(h11.score).toBe(0);
        expect(h11.explanation.key).toBe('match.arrival.outside_window');
      });

      it('returns neutral 0.5 score and near_window when preferredArrivalWindow is null or undefined', () => {
        const flightOffer = offer({ outboundArrivalHour: 11 });
        const nullResult = scorer.scoreArrivalSchedule(flightOffer, preferences({ preferredArrivalWindow: null }));

        expect(nullResult).toEqual({
          dimension: 'ARRIVAL_SCHEDULE',
          score: 0.5,
          weight: BASE_WEIGHTS.ARRIVAL_SCHEDULE,
          contribution: 0.075,
          signal: 'NEUTRAL',
          explanation: {
            key: 'match.arrival.near_window',
            params: { time: '11:00' },
          },
        });

        const undefinedResult = scorer.scoreArrivalSchedule(
          offer({ outboundArrivalHour: 20 }),
          // Type assertion needed to test runtime resilience when window preference is undefined at runtime
          preferences({ preferredArrivalWindow: undefined as unknown as null }),
        );
        expect(undefinedResult.score).toBe(0.5);
        expect(undefinedResult.explanation).toEqual({
          key: 'match.arrival.near_window',
          params: { time: '20:00' },
        });
      });

      it('accepts frozen offer and preferences without mutation in scoreArrivalSchedule', () => {
        const frozenOffer = deepFreeze(offer({ outboundArrivalHour: 16 }));
        const frozenPrefs = deepFreeze(preferences({ preferredArrivalWindow: { start: 14, end: 18 } }));
        const beforeOffer = JSON.stringify(frozenOffer);
        const beforePrefs = JSON.stringify(frozenPrefs);

        expect(() => scorer.scoreArrivalSchedule(frozenOffer, frozenPrefs)).not.toThrow();
        expect(JSON.stringify(frozenOffer)).toBe(beforeOffer);
        expect(JSON.stringify(frozenPrefs)).toBe(beforePrefs);
      });

      it('uses BASE_WEIGHTS.ARRIVAL_SCHEDULE constant (0.15)', () => {
        const result = scorer.scoreArrivalSchedule(offer({ outboundArrivalHour: 11 }), preferences());
        expect(result.weight).toBe(BASE_WEIGHTS.ARRIVAL_SCHEDULE);
        expect(result.weight).toBe(0.15);
      });
    });

    describe('scoreBaggage dimension', () => {
      describe('when requiresCheckedBaggage is true', () => {
        it('returns score 1.0, POSITIVE signal, and match.baggage.checked_included when offer has checked baggage', () => {
          const flightOffer = offer({ hasCheckedBaggage: true });
          const prefs = preferences({ requiresCheckedBaggage: true });
          const result = scorer.scoreBaggage(flightOffer, prefs);

          expect(result).toEqual({
            dimension: 'BAGGAGE',
            score: 1,
            weight: BASE_WEIGHTS.BAGGAGE,
            contribution: 0.1,
            signal: 'POSITIVE',
            explanation: {
              key: 'match.baggage.checked_included',
              params: { checkedBags: 1, required: true },
            },
          });
        });

        it('returns score 0.0, NEGATIVE signal, and match.baggage.checked_missing when offer has hasCheckedBaggage: false', () => {
          const flightOffer = offer({ hasCheckedBaggage: false });
          const prefs = preferences({ requiresCheckedBaggage: true });
          const result = scorer.scoreBaggage(flightOffer, prefs);

          expect(result).toEqual({
            dimension: 'BAGGAGE',
            score: 0,
            weight: BASE_WEIGHTS.BAGGAGE,
            contribution: 0,
            signal: 'NEGATIVE',
            explanation: {
              key: 'match.baggage.checked_missing',
              params: { checkedBags: 0, required: true },
            },
          });
        });

        it('returns score 0.0, NEGATIVE signal, and match.baggage.checked_missing when offer has hasCheckedBaggage: null', () => {
          const flightOffer = offer({ hasCheckedBaggage: null });
          const prefs = preferences({ requiresCheckedBaggage: true });
          const result = scorer.scoreBaggage(flightOffer, prefs);

          expect(result).toEqual({
            dimension: 'BAGGAGE',
            score: 0,
            weight: BASE_WEIGHTS.BAGGAGE,
            contribution: 0,
            signal: 'NEGATIVE',
            explanation: {
              key: 'match.baggage.checked_missing',
              params: { checkedBags: 0, required: true },
            },
          });
        });
      });

      describe('when requiresCheckedBaggage is false', () => {
        it('returns score 1.0, POSITIVE signal, and checkedBags: 1 when offer has checked baggage', () => {
          const flightOffer = offer({ hasCheckedBaggage: true });
          const prefs = preferences({ requiresCheckedBaggage: false });
          const result = scorer.scoreBaggage(flightOffer, prefs);

          expect(result).toEqual({
            dimension: 'BAGGAGE',
            score: 1,
            weight: BASE_WEIGHTS.BAGGAGE,
            contribution: 0.1,
            signal: 'POSITIVE',
            explanation: {
              key: 'match.baggage.not_required',
              params: { checkedBags: 1, required: false },
            },
          });
        });

        it('returns score 1.0, POSITIVE signal, and checkedBags: 0 when offer has hasCheckedBaggage: false', () => {
          const flightOffer = offer({ hasCheckedBaggage: false });
          const prefs = preferences({ requiresCheckedBaggage: false });
          const result = scorer.scoreBaggage(flightOffer, prefs);

          expect(result).toEqual({
            dimension: 'BAGGAGE',
            score: 1,
            weight: BASE_WEIGHTS.BAGGAGE,
            contribution: 0.1,
            signal: 'POSITIVE',
            explanation: {
              key: 'match.baggage.not_required',
              params: { checkedBags: 0, required: false },
            },
          });
        });

        it('returns score 1.0, POSITIVE signal, and checkedBags: 0 when offer has hasCheckedBaggage: null', () => {
          const flightOffer = offer({ hasCheckedBaggage: null });
          const prefs = preferences({ requiresCheckedBaggage: false });
          const result = scorer.scoreBaggage(flightOffer, prefs);

          expect(result).toEqual({
            dimension: 'BAGGAGE',
            score: 1,
            weight: BASE_WEIGHTS.BAGGAGE,
            contribution: 0.1,
            signal: 'POSITIVE',
            explanation: {
              key: 'match.baggage.not_required',
              params: { checkedBags: 0, required: false },
            },
          });
        });
      });

      describe('when requiresCheckedBaggage is null or undefined', () => {
        it('returns score 0.5, NEUTRAL signal, and checkedBags: 1 when offer has checked baggage', () => {
          const flightOffer = offer({ hasCheckedBaggage: true });
          const prefs = preferences({ requiresCheckedBaggage: null });
          const result = scorer.scoreBaggage(flightOffer, prefs);

          expect(result).toEqual({
            dimension: 'BAGGAGE',
            score: 0.5,
            weight: BASE_WEIGHTS.BAGGAGE,
            contribution: 0.05,
            signal: 'NEUTRAL',
            explanation: {
              key: 'match.baggage.not_required',
              params: { checkedBags: 1, required: false },
            },
          });
        });

        it('returns score 0.5, NEUTRAL signal, and checkedBags: 0 when offer has hasCheckedBaggage: false', () => {
          const flightOffer = offer({ hasCheckedBaggage: false });
          const prefs = preferences({ requiresCheckedBaggage: null });
          const result = scorer.scoreBaggage(flightOffer, prefs);

          expect(result).toEqual({
            dimension: 'BAGGAGE',
            score: 0.5,
            weight: BASE_WEIGHTS.BAGGAGE,
            contribution: 0.05,
            signal: 'NEUTRAL',
            explanation: {
              key: 'match.baggage.not_required',
              params: { checkedBags: 0, required: false },
            },
          });
        });

        it('returns score 0.5 when requiresCheckedBaggage is undefined', () => {
          const flightOffer = offer({ hasCheckedBaggage: null });
          // Type assertion needed to test runtime resilience when requiresCheckedBaggage is undefined at runtime
          const prefs = preferences({ requiresCheckedBaggage: undefined as unknown as null });
          const result = scorer.scoreBaggage(flightOffer, prefs);

          expect(result).toEqual({
            dimension: 'BAGGAGE',
            score: 0.5,
            weight: BASE_WEIGHTS.BAGGAGE,
            contribution: 0.05,
            signal: 'NEUTRAL',
            explanation: {
              key: 'match.baggage.not_required',
              params: { checkedBags: 0, required: false },
            },
          });
        });
      });

      it('accepts frozen offer and preferences without mutation in scoreBaggage', () => {
        const frozenOffer = deepFreeze(offer({ hasCheckedBaggage: true }));
        const frozenPrefs = deepFreeze(preferences({ requiresCheckedBaggage: true }));
        const beforeOffer = JSON.stringify(frozenOffer);
        const beforePrefs = JSON.stringify(frozenPrefs);

        expect(() => scorer.scoreBaggage(frozenOffer, frozenPrefs)).not.toThrow();
        expect(JSON.stringify(frozenOffer)).toBe(beforeOffer);
        expect(JSON.stringify(frozenPrefs)).toBe(beforePrefs);
      });

      it('uses BASE_WEIGHTS.BAGGAGE constant (0.10)', () => {
        const result = scorer.scoreBaggage(offer({ hasCheckedBaggage: true }), preferences());
        expect(result.weight).toBe(BASE_WEIGHTS.BAGGAGE);
        expect(result.weight).toBe(0.10);
      });
    });
  });

  describe('FlightMatchScorerService weight resolution (T029)', () => {
    const scorer = new FlightMatchScorerService();

    const fullPreferences: ScoringPreferences = {
      preferredAirlines: ['AA'],
      blacklistedAirlines: [],
      classPreference: 'economy',
      preferredDepartureWindow: { start: 8, end: 12 },
      preferredArrivalWindow: { start: 14, end: 18 },
      maxStops: 1,
      priceSensitivity: 'MODERATE',
      requiresCheckedBaggage: true,
    };

    // offerA and offerB have different sub-scores on ALL 8 dimensions
    const offerA: FlightMatchInput = offer({
      id: 'offer-a',
      price: 100,
      duration: 120,
      stops: 0,
      carrierCodes: ['AA'],
      cabinClass: 'economy',
      outboundDepartureHour: 9, // inside [8, 12] -> subScore 1.0
      outboundArrivalHour: 15,   // inside [14, 18] -> subScore 1.0
      hasCheckedBaggage: true,   // required true, bag true -> 1.0
      originalIndex: 0,
    });

    const offerB: FlightMatchInput = offer({
      id: 'offer-b',
      price: 200,
      duration: 180,
      stops: 2,                  // exceeds maxStops 1 by 1 -> 0.5
      carrierCodes: ['DL'],      // neutral carrier -> 0.5
      cabinClass: 'premium_economy', // adjacent -> 0.5
      outboundDepartureHour: 14, // shoulder distance 2 -> ~0.666667
      outboundArrivalHour: 20,   // shoulder distance 2 -> ~0.666667
      hasCheckedBaggage: false,  // required true, bag false -> 0.0
      originalIndex: 1,
    });

    function sumWeights(weights: Record<string, number>): number {
      return (
        Math.round(
          Object.values(weights).reduce((sum, w) => sum + (typeof w === 'number' ? w : 0), 0) *
            1_000_000,
        ) / 1_000_000
      );
    }

    describe('Base weights and dimension pools', () => {
      it('returns exact BASE_WEIGHTS when all preferences are present and offers have variance on all dimensions', () => {
        const weights = scorer.resolveWeights([offerA, offerB], fullPreferences);

        expect(weights).toEqual({
          PRICE: 0.20,
          AIRLINE: 0.15,
          ARRIVAL_SCHEDULE: 0.15,
          STOPS: 0.12,
          CABIN: 0.10,
          DEPARTURE_SCHEDULE: 0.10,
          BAGGAGE: 0.10,
          DURATION: 0.08,
        });

        expect(sumWeights(weights)).toBe(1.000000);
      });
    });

    describe('Missing personalized transfer', () => {
      it('releases AIRLINE weight (0.15) to baseline pool when preferredAirlines is empty', () => {
        const prefs = preferences({
          ...fullPreferences,
          preferredAirlines: [],
        });
        const weights = scorer.resolveWeights([offerA, offerB], prefs);

        expect(weights.AIRLINE).toBe(0);
        // Baseline target pool = 0.40 + 0.15 = 0.55
        // PRICE = (0.20 / 0.40) * 0.55 = 0.275000
        // STOPS = (0.12 / 0.40) * 0.55 = 0.165000
        // DURATION = (0.08 / 0.40) * 0.55 = 0.110000
        expect(weights.PRICE).toBe(0.275);
        expect(weights.STOPS).toBe(0.165);
        expect(weights.DURATION).toBe(0.11);
        expect(weights.ARRIVAL_SCHEDULE).toBe(0.15);
        expect(weights.CABIN).toBe(0.10);
        expect(weights.DEPARTURE_SCHEDULE).toBe(0.10);
        expect(weights.BAGGAGE).toBe(0.10);

        expect(sumWeights(weights)).toBe(1.000000);
      });

      it('releases AIRLINE weight to baseline pool when preferredAirlines contains only invalid codes', () => {
        const prefs = preferences({
          ...fullPreferences,
          preferredAirlines: ['   ', 'INVALID', '1'],
        });
        const weights = scorer.resolveWeights([offerA, offerB], prefs);

        expect(weights.AIRLINE).toBe(0);
        expect(weights.PRICE).toBe(0.275);
        expect(weights.STOPS).toBe(0.165);
        expect(weights.DURATION).toBe(0.11);
      });

      it('releases ARRIVAL_SCHEDULE weight (0.15) to baseline pool when preferredArrivalWindow is null', () => {
        const prefs = preferences({
          ...fullPreferences,
          preferredArrivalWindow: null,
        });
        const weights = scorer.resolveWeights([offerA, offerB], prefs);

        expect(weights.ARRIVAL_SCHEDULE).toBe(0);
        expect(weights.PRICE).toBe(0.275);
        expect(weights.STOPS).toBe(0.165);
        expect(weights.DURATION).toBe(0.11);
        expect(weights.AIRLINE).toBe(0.15);

        expect(sumWeights(weights)).toBe(1.000000);
      });

      it('releases CABIN weight (0.10) to baseline pool when classPreference is null', () => {
        const prefs = preferences({
          ...fullPreferences,
          classPreference: null,
        });
        const weights = scorer.resolveWeights([offerA, offerB], prefs);

        expect(weights.CABIN).toBe(0);
        // Baseline target pool = 0.40 + 0.10 = 0.50
        // PRICE = (0.20 / 0.40) * 0.50 = 0.250000
        // STOPS = (0.12 / 0.40) * 0.50 = 0.150000
        // DURATION = (0.08 / 0.40) * 0.50 = 0.100000
        expect(weights.PRICE).toBe(0.25);
        expect(weights.STOPS).toBe(0.15);
        expect(weights.DURATION).toBe(0.10);

        expect(sumWeights(weights)).toBe(1.000000);
      });

      it('releases CABIN weight (0.10) to baseline pool when classPreference is empty or whitespace', () => {
        const prefs = preferences({
          ...fullPreferences,
          classPreference: '   ',
        });
        const weights = scorer.resolveWeights([offerA, offerB], prefs);

        expect(weights.CABIN).toBe(0);
        expect(weights.PRICE).toBe(0.25);
        expect(weights.STOPS).toBe(0.15);
        expect(weights.DURATION).toBe(0.10);
      });

      it('releases DEPARTURE_SCHEDULE weight (0.10) to baseline pool when preferredDepartureWindow is null', () => {
        const prefs = preferences({
          ...fullPreferences,
          preferredDepartureWindow: null,
        });
        const weights = scorer.resolveWeights([offerA, offerB], prefs);

        expect(weights.DEPARTURE_SCHEDULE).toBe(0);
        expect(weights.PRICE).toBe(0.25);
        expect(weights.STOPS).toBe(0.15);
        expect(weights.DURATION).toBe(0.10);

        expect(sumWeights(weights)).toBe(1.000000);
      });

      it('releases BAGGAGE weight (0.10) to baseline pool when requiresCheckedBaggage is null', () => {
        const prefs = preferences({
          ...fullPreferences,
          requiresCheckedBaggage: null,
        });
        const weights = scorer.resolveWeights([offerA, offerB], prefs);

        expect(weights.BAGGAGE).toBe(0);
        expect(weights.PRICE).toBe(0.25);
        expect(weights.STOPS).toBe(0.15);
        expect(weights.DURATION).toBe(0.10);

        expect(sumWeights(weights)).toBe(1.000000);
      });

      it('releases all 0.60 personalized weight to baseline pool when all personalized preferences are missing', () => {
        const weights = scorer.resolveWeights([offerA, offerB], basePreferences);

        expect(weights).toEqual({
          PRICE: 0.50,
          STOPS: 0.30,
          DURATION: 0.20,
          AIRLINE: 0,
          ARRIVAL_SCHEDULE: 0,
          CABIN: 0,
          DEPARTURE_SCHEDULE: 0,
          BAGGAGE: 0,
        });

        expect(sumWeights(weights)).toBe(1.000000);
      });
    });

    describe('Zero-variance detection and single-offer sets', () => {
      it('does NOT apply zero-variance collapse for single-offer sets', () => {
        const singleOffer = [offerA];
        const weights = scorer.resolveWeights(singleOffer, fullPreferences);

        // With single offer, no collapse occurs even though 1 offer has trivial zero variance
        expect(weights).toEqual({
          PRICE: 0.20,
          AIRLINE: 0.15,
          ARRIVAL_SCHEDULE: 0.15,
          STOPS: 0.12,
          CABIN: 0.10,
          DEPARTURE_SCHEDULE: 0.10,
          BAGGAGE: 0.10,
          DURATION: 0.08,
        });
      });

      it('does NOT collapse single-offer sets but transfers missing personalized dimensions', () => {
        const singleOffer = [offerA];
        const weights = scorer.resolveWeights(singleOffer, basePreferences);

        expect(weights).toEqual({
          PRICE: 0.50,
          STOPS: 0.30,
          DURATION: 0.20,
          AIRLINE: 0,
          ARRIVAL_SCHEDULE: 0,
          CABIN: 0,
          DEPARTURE_SCHEDULE: 0,
          BAGGAGE: 0,
        });
      });

      it('collapses STOPS when all eligible offers have identical stops (>= 2 offers)', () => {
        const offers = [
          offerA, // stops: 0
          offer({ ...offerB, stops: 0 }), // now both have stops: 0
        ];
        const weights = scorer.resolveWeights(offers, fullPreferences);

        expect(weights.STOPS).toBe(0);
        // Active baseline base weights: PRICE (0.20), DURATION (0.08) -> sum = 0.28
        // Baseline target pool = 0.40
        // PRICE = (0.20 / 0.28) * 0.40 = 0.285714
        // DURATION = (0.08 / 0.28) * 0.40 = 0.114286
        expect(weights.PRICE).toBe(0.285714);
        expect(weights.DURATION).toBe(0.114286);
        expect(weights.AIRLINE).toBe(0.15);
        expect(weights.ARRIVAL_SCHEDULE).toBe(0.15);
        expect(weights.CABIN).toBe(0.10);
        expect(weights.DEPARTURE_SCHEDULE).toBe(0.10);
        expect(weights.BAGGAGE).toBe(0.10);

        expect(sumWeights(weights)).toBe(1.000000);
      });

      it('collapses PRICE when all eligible offers have identical prices (>= 2 offers)', () => {
        const offers = [
          offerA, // price: 100
          offer({ ...offerB, price: 100 }), // both price: 100
        ];
        const weights = scorer.resolveWeights(offers, fullPreferences);

        expect(weights.PRICE).toBe(0);
        // Active baseline: STOPS (0.12), DURATION (0.08) -> sum = 0.20
        // STOPS = (0.12 / 0.20) * 0.40 = 0.240000
        // DURATION = (0.08 / 0.20) * 0.40 = 0.160000
        expect(weights.STOPS).toBe(0.24);
        expect(weights.DURATION).toBe(0.16);

        expect(sumWeights(weights)).toBe(1.000000);
      });

      it('collapses DURATION when all eligible offers have identical durations (>= 2 offers)', () => {
        const offers = [
          offerA, // duration: 120
          offer({ ...offerB, duration: 120 }), // both duration: 120
        ];
        const weights = scorer.resolveWeights(offers, fullPreferences);

        expect(weights.DURATION).toBe(0);
        // Active baseline: PRICE (0.20), STOPS (0.12) -> sum = 0.32
        // PRICE = (0.20 / 0.32) * 0.40 = 0.250000
        // STOPS = (0.12 / 0.32) * 0.40 = 0.150000
        expect(weights.PRICE).toBe(0.25);
        expect(weights.STOPS).toBe(0.15);

        expect(sumWeights(weights)).toBe(1.000000);
      });
    });

    describe('Redistribution with personalized caps', () => {
      it('collapses zero-variance personalized dimension and overflows all weight to baseline target due to caps', () => {
        const offers = [
          offerA, // cabinClass: 'economy' (score 1.0)
          offer({ ...offerB, cabinClass: 'economy' }), // both have cabinClass: 'economy' (score 1.0)
        ];
        const weights = scorer.resolveWeights(offers, fullPreferences);

        // CABIN collapses to 0
        expect(weights.CABIN).toBe(0);
        // Active personalized dimensions (AIRLINE 0.15, ARRIVAL 0.15, DEPARTURE 0.10, BAGGAGE 0.10) CANNOT exceed base weights
        expect(weights.AIRLINE).toBe(0.15);
        expect(weights.ARRIVAL_SCHEDULE).toBe(0.15);
        expect(weights.DEPARTURE_SCHEDULE).toBe(0.10);
        expect(weights.BAGGAGE).toBe(0.10);

        // CABIN 0.10 overflows down to baseline target pool: 0.40 + 0.10 = 0.50
        // PRICE = (0.20 / 0.40) * 0.50 = 0.250000
        // STOPS = (0.12 / 0.40) * 0.50 = 0.150000
        // DURATION = (0.08 / 0.40) * 0.50 = 0.100000
        expect(weights.PRICE).toBe(0.25);
        expect(weights.STOPS).toBe(0.15);
        expect(weights.DURATION).toBe(0.10);

        expect(sumWeights(weights)).toBe(1.000000);
      });

      it('collapses BAGGAGE when requiresCheckedBaggage is false because all offers score 1.0', () => {
        const prefs = preferences({
          ...fullPreferences,
          requiresCheckedBaggage: false,
        });
        const weights = scorer.resolveWeights([offerA, offerB], prefs);

        // All offers score 1.0 when requiresCheckedBaggage is false -> zero variance
        expect(weights.BAGGAGE).toBe(0);
        // BAGGAGE 0.10 overflows to baseline pool -> baseline target pool = 0.50
        expect(weights.PRICE).toBe(0.25);
        expect(weights.STOPS).toBe(0.15);
        expect(weights.DURATION).toBe(0.10);

        expect(sumWeights(weights)).toBe(1.000000);
      });

      it('collapses ARRIVAL_SCHEDULE when all eligible offers fall 6+ hours outside preferredArrivalWindow (score 0.0)', () => {
        const prefs = preferences({
          ...fullPreferences,
          preferredArrivalWindow: { start: 14, end: 18 },
        });
        const offers = [
          offer({ ...offerA, outboundArrivalHour: 0 }), // dist: 6 -> score 0.0
          offer({ ...offerB, outboundArrivalHour: 4 }), // dist: 10 -> score 0.0
        ];
        const weights = scorer.resolveWeights(offers, prefs);

        // Both offers score 0.0 for arrival schedule -> zero variance -> ARRIVAL_SCHEDULE collapses to 0
        expect(weights.ARRIVAL_SCHEDULE).toBe(0);
        expect(weights.AIRLINE).toBe(0.15);
        expect(weights.CABIN).toBe(0.10);
        expect(weights.DEPARTURE_SCHEDULE).toBe(0.10);
        expect(weights.BAGGAGE).toBe(0.10);
        // Baseline target pool = 0.40 + 0.15 = 0.55
        expect(weights.PRICE).toBe(0.275);
        expect(weights.STOPS).toBe(0.165);
        expect(weights.DURATION).toBe(0.11);
        expect(sumWeights(weights)).toBe(1.000000);
      });

      it('collapses DEPARTURE_SCHEDULE when all eligible offers fall 6+ hours outside preferredDepartureWindow (score 0.0)', () => {
        const prefs = preferences({
          ...fullPreferences,
          preferredDepartureWindow: { start: 9, end: 12 },
        });
        const offers = [
          offer({ ...offerA, outboundDepartureHour: 3 }), // dist: 6 -> score 0.0
          offer({ ...offerB, outboundDepartureHour: 23 }), // dist: 10 -> score 0.0
        ];
        const weights = scorer.resolveWeights(offers, prefs);

        // Both offers score 0.0 for departure schedule -> zero variance -> DEPARTURE_SCHEDULE collapses to 0
        expect(weights.DEPARTURE_SCHEDULE).toBe(0);
        expect(weights.AIRLINE).toBe(0.15);
        expect(weights.ARRIVAL_SCHEDULE).toBe(0.15);
        expect(weights.CABIN).toBe(0.10);
        expect(weights.BAGGAGE).toBe(0.10);
        // Baseline target pool = 0.40 + 0.10 = 0.50
        expect(weights.PRICE).toBe(0.25);
        expect(weights.STOPS).toBe(0.15);
        expect(weights.DURATION).toBe(0.10);
        expect(sumWeights(weights)).toBe(1.000000);
      });

      it('cancels collapse when all baseline dimensions are zero-variance and distributes full target in 20:12:8 ratio', () => {
        // Both offers have identical price, stops, duration
        const offers = [
          offerA,
          offer({
            ...offerB,
            price: offerA.price,
            stops: offerA.stops,
            duration: offerA.duration,
          }),
        ];
        // Airline-only preference: preferredAirlines: ['AA'], others missing
        const prefs = preferences({
          preferredAirlines: ['AA'],
        });
        const weights = scorer.resolveWeights(offers, prefs);

        // Missing personalized: ARRIVAL (0.15), CABIN (0.10), DEPARTURE (0.10), BAGGAGE (0.10) = 0.45
        // Baseline target pool = 0.40 + 0.45 = 0.85
        // AIRLINE has variance (offerA carrier AA -> 1.0, offerB carrier DL -> 0.5) -> AIRLINE = 0.15
        // All baseline dimensions have zero variance -> collapse is cancelled!
        // PRICE = (0.20 / 0.40) * 0.85 = 0.425
        // STOPS = (0.12 / 0.40) * 0.85 = 0.255
        // DURATION = (0.08 / 0.40) * 0.85 = 0.170
        expect(weights).toEqual({
          PRICE: 0.425,
          STOPS: 0.255,
          DURATION: 0.170,
          AIRLINE: 0.150,
          ARRIVAL_SCHEDULE: 0,
          CABIN: 0,
          DEPARTURE_SCHEDULE: 0,
          BAGGAGE: 0,
        });

        expect(sumWeights(weights)).toBe(1.000000);
      });
    });

    describe('Ineligible offers and edge cases', () => {
      it('excludes blacklisted ineligible offers from zero-variance detection', () => {
        const blacklistedOffer = offer({
          id: 'blacklisted',
          carrierCodes: ['NK'],
          price: 999,
          stops: 5,
          duration: 999,
        });
        const offers = [
          offerA, // stops: 0
          offer({ ...offerB, stops: 0 }), // stops: 0
          blacklistedOffer, // stops: 5, but blacklisted!
        ];
        const prefs = preferences({
          ...fullPreferences,
          blacklistedAirlines: ['NK'],
        });

        const weights = scorer.resolveWeights(offers, prefs);
        // Only eligible offers (offerA and offerB) are considered; both have stops: 0 -> STOPS collapses!
        expect(weights.STOPS).toBe(0);
      });

      it('returns BASE_WEIGHTS when all offers are ineligible', () => {
        const blacklisted1 = offer({ id: 'b1', carrierCodes: ['NK'] });
        const blacklisted2 = offer({ id: 'b2', carrierCodes: ['NK'] });
        const prefs = preferences({ blacklistedAirlines: ['NK'] });

        const weights = scorer.resolveWeights([blacklisted1, blacklisted2], prefs);
        expect(weights).toEqual(BASE_WEIGHTS);
      });

      it('returns BASE_WEIGHTS when offers array is empty', () => {
        const weights = scorer.resolveWeights([], fullPreferences);
        expect(weights).toEqual(BASE_WEIGHTS);
      });
    });

    describe('Exact 1.000000 invariant and remainder assignment', () => {
      it('assigns 6-decimal rounding remainder to highest-priority active baseline dimension (PRICE)', () => {
        // Construct a scenario where floating division creates a remainder
        // Baseline target pool = 0.85 (airline only), with STOPS collapsed to 0
        // Active baseline: PRICE (0.20) and DURATION (0.08) -> sum = 0.28
        // PRICE: round6((0.20 / 0.28) * 0.85) = round6(0.607142857...) = 0.607143
        // DURATION: round6((0.08 / 0.28) * 0.85) = round6(0.242857142...) = 0.242857
        // Sum = 0.607143 + 0.242857 + 0.15 = 1.000000
        const offers = [
          offerA,
          offer({ ...offerB, stops: offerA.stops }),
        ];
        const prefs = preferences({ preferredAirlines: ['AA'] });
        const weights = scorer.resolveWeights(offers, prefs);

        expect(sumWeights(weights)).toBe(1.000000);
      });

      it('assigns rounding remainder to STOPS when PRICE is collapsed', () => {
        // If PRICE is collapsed (zero variance), highest active baseline is STOPS
        const offers = [
          offerA,
          offer({ ...offerB, price: offerA.price }), // price identical -> PRICE collapses
        ];
        const prefs = preferences({ preferredAirlines: ['AA'] });
        const weights = scorer.resolveWeights(offers, prefs);

        expect(weights.PRICE).toBe(0);
        expect(weights.STOPS).toBeGreaterThan(0);
        expect(sumWeights(weights)).toBe(1.000000);
      });

      it('assigns rounding remainder to DURATION when PRICE and STOPS are collapsed', () => {
        // If PRICE and STOPS are both collapsed, highest active baseline is DURATION
        const offers = [
          offerA,
          offer({
            ...offerB,
            price: offerA.price,
            stops: offerA.stops,
          }), // price and stops identical
        ];
        const prefs = preferences({ preferredAirlines: ['AA'] });
        const weights = scorer.resolveWeights(offers, prefs);

        expect(weights.PRICE).toBe(0);
        expect(weights.STOPS).toBe(0);
        expect(weights.DURATION).toBe(0.85);
        expect(weights.AIRLINE).toBe(0.15);
        expect(sumWeights(weights)).toBe(1.000000);
      });

      it('guarantees sum of active weights is exactly 1.000000 across multiple random/arbitrary scenarios', () => {
        // Test with different combination of missing preferences and offers
        const scenarios: ScoringPreferences[] = [
          fullPreferences,
          basePreferences,
          preferences({ preferredAirlines: ['AA'] }),
          preferences({ classPreference: 'business', maxStops: 0 }),
          preferences({ requiresCheckedBaggage: true, preferredArrivalWindow: { start: 10, end: 12 } }),
        ];

        for (const scenario of scenarios) {
          const weights = scorer.resolveWeights([offerA, offerB], scenario);
          expect(sumWeights(weights)).toBe(1.000000);
        }
      });
    });

    describe('Immutability and purity', () => {
      it('accepts deeply frozen offers and preferences without mutation in resolveWeights', () => {
        const frozenOffers = deepFreeze([offerA, offerB]);
        const frozenPrefs = deepFreeze(fullPreferences);
        const beforeOffers = JSON.stringify(frozenOffers);
        const beforePrefs = JSON.stringify(frozenPrefs);

        expect(() => scorer.resolveWeights(frozenOffers, frozenPrefs)).not.toThrow();
        expect(JSON.stringify(frozenOffers)).toBe(beforeOffers);
        expect(JSON.stringify(frozenPrefs)).toBe(beforePrefs);
      });
    });
  });
});

describe('FlightMatchScorerService full baseline collapse fallback & degenerate sets (T030)', () => {
  const scorer = new FlightMatchScorerService();

  function sumWeights(weights: Record<string, number>): number {
    return (
      Math.round(
        Object.values(weights).reduce((sum, w) => sum + (typeof w === 'number' ? w : 0), 0) *
          1_000_000,
      ) / 1_000_000
    );
  }

  describe('Full baseline collapse fallback', () => {
    it('cancels collapse when all baseline dimensions (PRICE, STOPS, DURATION) have zero variance and distributes entire baseline target in 20:12:8 ratio', () => {
      // 3 offers with identical price, stops, duration
      const offers = [
        offer({ id: 'o1', price: 150, stops: 1, duration: 180, carrierCodes: ['AA'] }),
        offer({ id: 'o2', price: 150, stops: 1, duration: 180, carrierCodes: ['DL'] }),
        offer({ id: 'o3', price: 150, stops: 1, duration: 180, carrierCodes: ['UA'] }),
      ];
      // All personalized preferences missing -> baseline target pool is 1.0
      const prefs = preferences();
      const weights = scorer.resolveWeights(offers, prefs);

      // Entire baseline target pool (1.0) distributed in 20:12:8 ratio:
      // PRICE: (0.20 / 0.40) * 1.0 = 0.500000
      // STOPS: (0.12 / 0.40) * 1.0 = 0.300000
      // DURATION: (0.08 / 0.40) * 1.0 = 0.200000
      expect(weights).toEqual({
        PRICE: 0.500000,
        STOPS: 0.300000,
        DURATION: 0.200000,
        AIRLINE: 0,
        ARRIVAL_SCHEDULE: 0,
        CABIN: 0,
        DEPARTURE_SCHEDULE: 0,
        BAGGAGE: 0,
      });
      expect(weights.PRICE).toBe(0.500000);
      expect(weights.STOPS).toBe(0.300000);
      expect(weights.DURATION).toBe(0.200000);
      expect(sumWeights(weights)).toBe(1.000000);
    });

    it('cancels baseline collapse and distributes entire target in 20:12:8 ratio when some personalized dimensions are active', () => {
      const offers = [
        offer({
          id: 'o1',
          price: 250,
          stops: 0,
          duration: 300,
          cabinClass: 'economy',
          outboundDepartureHour: 9,
        }),
        offer({
          id: 'o2',
          price: 250,
          stops: 0,
          duration: 300,
          cabinClass: 'business',
          outboundDepartureHour: 15,
        }),
      ];
      // CABIN (0.10) and DEPARTURE_SCHEDULE (0.10) have variance -> active sum = 0.20
      // Missing personalized: AIRLINE (0.15), ARRIVAL (0.15), BAGGAGE (0.10) = 0.40
      // Baseline target pool = 0.40 + 0.40 = 0.80
      const prefs = preferences({
        classPreference: 'economy',
        preferredDepartureWindow: { start: 8, end: 11 },
      });
      const weights = scorer.resolveWeights(offers, prefs);

      // Entire baseline target pool (0.80) distributed in 20:12:8 ratio:
      // PRICE: (0.20 / 0.40) * 0.80 = 0.400000
      // STOPS: (0.12 / 0.40) * 0.80 = 0.240000
      // DURATION: (0.08 / 0.40) * 0.80 = 0.160000
      expect(weights.PRICE).toBe(0.400000);
      expect(weights.STOPS).toBe(0.240000);
      expect(weights.DURATION).toBe(0.160000);
      expect(weights.CABIN).toBe(0.100000);
      expect(weights.DEPARTURE_SCHEDULE).toBe(0.100000);
      expect(weights.AIRLINE).toBe(0);
      expect(weights.ARRIVAL_SCHEDULE).toBe(0);
      expect(weights.BAGGAGE).toBe(0);
      expect(sumWeights(weights)).toBe(1.000000);
    });
  });

  describe('Airline-only personalization golden fixture', () => {
    it('yields exact 0.425000 / 0.255000 / 0.170000 / 0.150000 active weights when all baseline dimensions collapse', () => {
      // User only supplies preferredAirlines, all other personalized dimensions missing/null
      const prefs = preferences({
        preferredAirlines: ['AA'],
      });

      // Eligible offers have identical price, stops, duration (all baseline dimensions collapse),
      // but have variance in carrierCodes (AA -> score 1.0, DL -> score 0.5)
      const offers = [
        offer({
          id: 'offer-aa',
          price: 199.99,
          stops: 0,
          duration: 150,
          carrierCodes: ['AA'],
        }),
        offer({
          id: 'offer-dl',
          price: 199.99,
          stops: 0,
          duration: 150,
          carrierCodes: ['DL'],
        }),
      ];

      const weights = scorer.resolveWeights(offers, prefs);

      expect(weights).toEqual({
        PRICE: 0.425000,
        STOPS: 0.255000,
        DURATION: 0.170000,
        AIRLINE: 0.150000,
        ARRIVAL_SCHEDULE: 0,
        CABIN: 0,
        DEPARTURE_SCHEDULE: 0,
        BAGGAGE: 0,
      });

      expect(weights.PRICE).toBe(0.425000);
      expect(weights.STOPS).toBe(0.255000);
      expect(weights.DURATION).toBe(0.170000);
      expect(weights.AIRLINE).toBe(0.150000);
      expect(sumWeights(weights)).toBe(1.000000);
    });
  });

  describe('Degenerate Sets', () => {
    describe('Single eligible offer', () => {
      it('does not apply zero-variance collapse and transfers missing personalized weights to baseline in 20:12:8 ratio', () => {
        const singleOffer = [
          offer({
            id: 'single-1',
            price: 350,
            stops: 1,
            duration: 240,
            carrierCodes: ['AA'],
          }),
        ];

        // Case A: All personalized dimensions missing -> 0.60 transferred to baseline pool (total 1.0)
        const weightsBase = scorer.resolveWeights(singleOffer, preferences());
        expect(weightsBase).toEqual({
          PRICE: 0.500000,
          STOPS: 0.300000,
          DURATION: 0.200000,
          AIRLINE: 0,
          ARRIVAL_SCHEDULE: 0,
          CABIN: 0,
          DEPARTURE_SCHEDULE: 0,
          BAGGAGE: 0,
        });
        expect(weightsBase.PRICE).toBe(0.500000);
        expect(weightsBase.STOPS).toBe(0.300000);
        expect(weightsBase.DURATION).toBe(0.200000);
        expect(sumWeights(weightsBase)).toBe(1.000000);

        // Case B: Airline-only preference with single offer: AIRLINE (0.15) active, missing = 0.45 transferred to baseline (total 0.85)
        const weightsAirlineOnly = scorer.resolveWeights(
          singleOffer,
          preferences({ preferredAirlines: ['AA'] }),
        );
        expect(weightsAirlineOnly).toEqual({
          PRICE: 0.425000,
          STOPS: 0.255000,
          DURATION: 0.170000,
          AIRLINE: 0.150000,
          ARRIVAL_SCHEDULE: 0,
          CABIN: 0,
          DEPARTURE_SCHEDULE: 0,
          BAGGAGE: 0,
        });
        expect(weightsAirlineOnly.PRICE).toBe(0.425000);
        expect(weightsAirlineOnly.STOPS).toBe(0.255000);
        expect(weightsAirlineOnly.DURATION).toBe(0.170000);
        expect(weightsAirlineOnly.AIRLINE).toBe(0.150000);
        expect(sumWeights(weightsAirlineOnly)).toBe(1.000000);

        // Case C: Full preferences with single offer: no zero-variance collapse occurs
        const fullPrefs: ScoringPreferences = {
          preferredAirlines: ['AA'],
          blacklistedAirlines: [],
          classPreference: 'economy',
          preferredDepartureWindow: { start: 8, end: 12 },
          preferredArrivalWindow: { start: 14, end: 18 },
          maxStops: 1,
          priceSensitivity: 'MODERATE',
          requiresCheckedBaggage: true,
        };
        const weightsFull = scorer.resolveWeights(singleOffer, fullPrefs);
        expect(weightsFull).toEqual(BASE_WEIGHTS);
        expect(sumWeights(weightsFull)).toBe(1.000000);
      });
    });

    describe('All offers ineligible', () => {
      it('returns score: null, matchLevel: null, and breakdown: [] for each offer without throwing', () => {
        const ineligibleOffers = [
          offer({ id: 'ineligible-1', carrierCodes: ['NK'] }),
          offer({ id: 'ineligible-2', carrierCodes: ['F9'] }),
        ];
        const prefs = preferences({
          blacklistedAirlines: ['NK', 'F9'],
        });

        let scoredOffers: readonly ScoredOffer[] = [];
        expect(() => {
          scoredOffers = scorer.scoreOffers(ineligibleOffers, prefs);
        }).not.toThrow();

        expect(scoredOffers).toHaveLength(2);
        for (const scored of scoredOffers) {
          expect(scored.matchResult.eligibility.eligible).toBe(false);
          expect(scored.matchResult.eligibility.violations.length).toBeGreaterThan(0);
          expect(scored.matchResult.score).toBeNull();
          expect(scored.matchResult.matchLevel).toBeNull();
          expect(scored.matchResult.breakdown).toEqual([]);
          expect(scored.matchResult.metadata.scoringVersion).toBe(SCORING_POLICY_VERSION);
        }
      });

      it('returns BASE_WEIGHTS without throwing in resolveWeights when all offers are ineligible', () => {
        const ineligibleOffers = [
          offer({ id: 'ineligible-1', carrierCodes: ['NK'] }),
          offer({ id: 'ineligible-2', carrierCodes: ['F9'] }),
        ];
        const prefs = preferences({
          blacklistedAirlines: ['NK', 'F9'],
        });

        let weights: Record<string, number> | undefined;
        expect(() => {
          weights = scorer.resolveWeights(ineligibleOffers, prefs);
        }).not.toThrow();
        expect(weights).toEqual(BASE_WEIGHTS);
      });
    });

    describe('Empty offers array', () => {
      it('returns [] without throwing in scoreOffers', () => {
        let result: readonly ScoredOffer[] | undefined;
        expect(() => {
          result = scorer.scoreOffers([], preferences());
        }).not.toThrow();
        expect(result).toEqual([]);
      });

      it('returns BASE_WEIGHTS without throwing in resolveWeights', () => {
        let weights: Record<string, number> | undefined;
        expect(() => {
          weights = scorer.resolveWeights([], preferences());
        }).not.toThrow();
        expect(weights).toEqual(BASE_WEIGHTS);
      });
    });

    describe('Ineligible offers mixed with eligible', () => {
      it('asserts ineligible offers do not affect activeWeights computation or medians/variance', () => {
        const eligible1 = offer({
          id: 'el-1',
          price: 100,
          stops: 0,
          duration: 120,
          carrierCodes: ['AA'],
        });
        const eligible2 = offer({
          id: 'el-2',
          price: 100,
          stops: 0,
          duration: 120,
          carrierCodes: ['DL'],
        });
        // Ineligible offer has extreme outlier values in price, stops, duration and blacklisted carrier
        const ineligible = offer({
          id: 'inel-1',
          price: 9999,
          stops: 5,
          duration: 1500,
          carrierCodes: ['NK'],
        });

        const prefs = preferences({
          preferredAirlines: ['AA'],
          blacklistedAirlines: ['NK'],
        });

        // 1. activeWeights computation:
        const weightsMixed = scorer.resolveWeights([eligible1, eligible2, ineligible], prefs);
        const weightsEligibleOnly = scorer.resolveWeights([eligible1, eligible2], prefs);

        expect(weightsMixed).toEqual(weightsEligibleOnly);
        expect(weightsMixed).toEqual({
          PRICE: 0.425000,
          STOPS: 0.255000,
          DURATION: 0.170000,
          AIRLINE: 0.150000,
          ARRIVAL_SCHEDULE: 0,
          CABIN: 0,
          DEPARTURE_SCHEDULE: 0,
          BAGGAGE: 0,
        });

        // 2. Medians and variance in scoreOffers:
        const scoredMixed = scorer.scoreOffers([eligible1, eligible2, ineligible], prefs);
        const scoredEligibleOnly = scorer.scoreOffers([eligible1, eligible2], prefs);

        // Ineligible offer is preserved with null score and empty breakdown
        expect(scoredMixed[2].offer.id).toBe('inel-1');
        expect(scoredMixed[2].matchResult.eligibility.eligible).toBe(false);
        expect(scoredMixed[2].matchResult.score).toBeNull();
        expect(scoredMixed[2].matchResult.matchLevel).toBeNull();
        expect(scoredMixed[2].matchResult.breakdown).toEqual([]);

        // Eligible offers scores and breakdowns are unaffected by ineligible offer's outlier values
        expect(scoredMixed[0].matchResult.score).toBe(scoredEligibleOnly[0].matchResult.score);
        expect(scoredMixed[1].matchResult.score).toBe(scoredEligibleOnly[1].matchResult.score);
        expect(scoredMixed[0].matchResult.breakdown).toEqual(scoredEligibleOnly[0].matchResult.breakdown);
        expect(scoredMixed[1].matchResult.breakdown).toEqual(scoredEligibleOnly[1].matchResult.breakdown);
      });
    });

    describe('Immutability and purity', () => {
      it('accepts deeply frozen inputs across degenerate sets and full baseline collapse without mutation', () => {
        const frozenOffers = deepFreeze([
          offer({ id: 'f-1', price: 100, stops: 0, duration: 120, carrierCodes: ['AA'] }),
          offer({ id: 'f-2', price: 100, stops: 0, duration: 120, carrierCodes: ['DL'] }),
          offer({ id: 'f-3', price: 9999, stops: 4, duration: 999, carrierCodes: ['NK'] }),
        ]);
        const frozenPrefs = deepFreeze(
          preferences({
            preferredAirlines: ['AA'],
            blacklistedAirlines: ['NK'],
          }),
        );

        const offersJsonBefore = JSON.stringify(frozenOffers);
        const prefsJsonBefore = JSON.stringify(frozenPrefs);

        expect(() => scorer.resolveWeights(frozenOffers, frozenPrefs)).not.toThrow();
        expect(() => scorer.scoreOffers(frozenOffers, frozenPrefs)).not.toThrow();

        expect(JSON.stringify(frozenOffers)).toBe(offersJsonBefore);
        expect(JSON.stringify(frozenPrefs)).toBe(prefsJsonBefore);
      });
    });
  });
});

describe('FlightMatchScorerService dimension contributions, final score & match level buckets (T031)', () => {
  const scorer = new FlightMatchScorerService();

  const makeScore = (
    dimension: DimensionScore['dimension'],
    score: number,
    weight: number,
    contribution: number,
  ): DimensionScore => ({
    dimension,
    score,
    weight,
    contribution,
    signal: score >= 0.67 ? 'POSITIVE' : score >= 0.34 ? 'NEUTRAL' : 'NEGATIVE',
    explanation: { key: 'match.price.at_median', params: {} },
  });

  describe('Dimension contributions precision', () => {
    it('computes contribution as round6(subScore * effectiveWeight) at 6-decimal precision', () => {
      // Standard cases
      expect(scorer.computeContribution(1.0, 0.2)).toBe(0.2);
      expect(scorer.computeContribution(0.5, 0.2)).toBe(0.1);
      expect(scorer.computeContribution(0.75, 0.15)).toBe(0.1125);

      // Sub-scores requiring exact 6-decimal rounding
      // 0.1234567 * 0.3 = 0.03703701 -> 0.037037
      expect(scorer.computeContribution(0.1234567, 0.3)).toBe(0.037037);
      // 0.1234567 * 0.12 = 0.014814804 -> 0.014815
      expect(scorer.computeContribution(0.1234567, 0.12)).toBe(0.014815);
      // 0.333333 * 0.15 = 0.04999995 -> 0.05
      expect(scorer.computeContribution(0.333333, 0.15)).toBe(0.05);

      // Zero subScore and weights
      expect(scorer.computeContribution(0, 0.2)).toBe(0);
      expect(scorer.computeContribution(1.0, 0)).toBe(0);

      // No negative zero (-0)
      expect(Object.is(scorer.computeContribution(-0, 0.2), 0)).toBe(true);
    });

    it('verifies dimension contributions in scored offers match round6(score * weight)', () => {
      const sampleOffers = [
        offer({ id: 'o-1', price: 80, duration: 100, stops: 0, cabinClass: 'economy', carrierCodes: ['AA'] }),
        offer({ id: 'o-2', price: 120, duration: 140, stops: 1, cabinClass: 'business', carrierCodes: ['DL'] }),
      ];
      const samplePrefs = preferences({
        preferredAirlines: ['AA'],
        classPreference: 'economy',
        maxStops: 0,
        requiresCheckedBaggage: true,
      });

      const scored = scorer.scoreOffers(sampleOffers, samplePrefs);
      for (const { matchResult } of scored) {
        if (matchResult.score !== null) {
          for (const dim of matchResult.breakdown) {
            const expectedContribution = Math.round(dim.score * dim.weight * 1_000_000) / 1_000_000;
            expect(dim.contribution).toBe(expectedContribution);
          }
        }
      }
    });
  });

  describe('Total score computation', () => {
    it('computes score = clamp(roundHalfAwayFromZero(sum(contribution) * 100), 0, 100)', () => {
      const breakdown = [
        makeScore('PRICE', 1.0, 0.2, 0.2),
        makeScore('AIRLINE', 1.0, 0.15, 0.15),
        makeScore('ARRIVAL_SCHEDULE', 1.0, 0.15, 0.15),
        makeScore('STOPS', 1.0, 0.12, 0.12),
        makeScore('CABIN', 1.0, 0.1, 0.1),
        makeScore('DEPARTURE_SCHEDULE', 1.0, 0.1, 0.1),
        makeScore('BAGGAGE', 1.0, 0.1, 0.1),
        makeScore('DURATION', 1.0, 0.08, 0.08),
      ];

      expect(scorer.computeFinalScore(breakdown)).toBe(100);
      expect(scorer.computeScoreResult(breakdown)).toEqual({
        score: 100,
        matchLevel: 'STRONG',
      });
    });

    it('computes score 0 when all contributions are 0', () => {
      const breakdown = [
        makeScore('PRICE', 0, 0.2, 0),
        makeScore('STOPS', 0, 0.12, 0),
        makeScore('DURATION', 0, 0.08, 0),
      ];

      expect(scorer.computeFinalScore(breakdown)).toBe(0);
      expect(scorer.computeScoreResult(breakdown)).toEqual({
        score: 0,
        matchLevel: 'WEAK',
      });
    });

    it('rounds exact .5 contribution percentages half-away-from-zero', () => {
      // 0.5% (sum = 0.005) -> 1
      expect(scorer.computeFinalScore([makeScore('PRICE', 0.025, 0.2, 0.005)])).toBe(1);
      // 0.49% (sum = 0.0049) -> 0
      expect(scorer.computeFinalScore([makeScore('PRICE', 0.0245, 0.2, 0.0049)])).toBe(0);

      // 24.5% (sum = 0.245) -> 25
      expect(scorer.computeFinalScore([makeScore('PRICE', 1.225, 0.2, 0.245)])).toBe(25);
      // 24.49% (sum = 0.2449) -> 24
      expect(scorer.computeFinalScore([makeScore('PRICE', 1.2245, 0.2, 0.2449)])).toBe(24);

      // 49.5% (sum = 0.495) -> 50
      expect(scorer.computeFinalScore([makeScore('PRICE', 2.475, 0.2, 0.495)])).toBe(50);
      // 49.49% (sum = 0.4949) -> 49
      expect(scorer.computeFinalScore([makeScore('PRICE', 2.4745, 0.2, 0.4949)])).toBe(49);

      // 74.5% (sum = 0.745) -> 75
      expect(scorer.computeFinalScore([makeScore('PRICE', 3.725, 0.2, 0.745)])).toBe(75);
      // 74.49% (sum = 0.7449) -> 74
      expect(scorer.computeFinalScore([makeScore('PRICE', 3.7245, 0.2, 0.7449)])).toBe(74);

      // 99.5% (sum = 0.995) -> 100
      expect(scorer.computeFinalScore([makeScore('PRICE', 4.975, 0.2, 0.995)])).toBe(100);
      // 99.49% (sum = 0.9949) -> 99
      expect(scorer.computeFinalScore([makeScore('PRICE', 4.9745, 0.2, 0.9949)])).toBe(99);
    });

    it('clamps negative contribution sums (< 0) to 0', () => {
      const negativeBreakdown = [makeScore('PRICE', -0.5, 0.2, -0.1)];
      expect(scorer.computeFinalScore(negativeBreakdown)).toBe(0);
      expect(scorer.computeScoreResult(negativeBreakdown)).toEqual({
        score: 0,
        matchLevel: 'WEAK',
      });
    });

    it('clamps contribution sums exceeding 1.0 (> 100) to 100', () => {
      const overflownBreakdown = [
        makeScore('PRICE', 2.0, 0.5, 1.0),
        makeScore('DURATION', 1.0, 0.5, 0.5),
      ];
      expect(scorer.computeFinalScore(overflownBreakdown)).toBe(100);
      expect(scorer.computeScoreResult(overflownBreakdown)).toEqual({
        score: 100,
        matchLevel: 'STRONG',
      });
    });
  });

  describe('Exact match level bucket boundaries', () => {
    describe('STRONG (75–100)', () => {
      it('categorizes 74.49 as score 74 -> GOOD and 74.5 as score 75 -> STRONG', () => {
        const justBelow = scorer.computeScoreResult([makeScore('PRICE', 1, 1, 0.7449)]);
        expect(justBelow.score).toBe(74);
        expect(justBelow.matchLevel).toBe('GOOD');

        const atThreshold = scorer.computeScoreResult([makeScore('PRICE', 1, 1, 0.745)]);
        expect(atThreshold.score).toBe(75);
        expect(atThreshold.matchLevel).toBe('STRONG');
      });

      it('categorizes boundary score 75 as STRONG', () => {
        expect(scorer.getMatchLevel(75)).toBe('STRONG');
        const res = scorer.computeScoreResult([makeScore('PRICE', 1, 1, 0.75)]);
        expect(res.score).toBe(75);
        expect(res.matchLevel).toBe('STRONG');
      });

      it('categorizes boundary score 100 as STRONG', () => {
        expect(scorer.getMatchLevel(100)).toBe('STRONG');
        const res = scorer.computeScoreResult([makeScore('PRICE', 1, 1, 1.0)]);
        expect(res.score).toBe(100);
        expect(res.matchLevel).toBe('STRONG');
      });
    });

    describe('GOOD (50–74)', () => {
      it('categorizes 49.49 as score 49 -> FAIR and 49.5 as score 50 -> GOOD', () => {
        const justBelow = scorer.computeScoreResult([makeScore('PRICE', 1, 1, 0.4949)]);
        expect(justBelow.score).toBe(49);
        expect(justBelow.matchLevel).toBe('FAIR');

        const atThreshold = scorer.computeScoreResult([makeScore('PRICE', 1, 1, 0.495)]);
        expect(atThreshold.score).toBe(50);
        expect(atThreshold.matchLevel).toBe('GOOD');
      });

      it('categorizes boundary score 50 as GOOD', () => {
        expect(scorer.getMatchLevel(50)).toBe('GOOD');
        const res = scorer.computeScoreResult([makeScore('PRICE', 1, 1, 0.5)]);
        expect(res.score).toBe(50);
        expect(res.matchLevel).toBe('GOOD');
      });

      it('categorizes boundary score 74 as GOOD', () => {
        expect(scorer.getMatchLevel(74)).toBe('GOOD');
        const res = scorer.computeScoreResult([makeScore('PRICE', 1, 1, 0.74)]);
        expect(res.score).toBe(74);
        expect(res.matchLevel).toBe('GOOD');
      });
    });

    describe('FAIR (25–49)', () => {
      it('categorizes 24.49 as score 24 -> WEAK and 24.5 as score 25 -> FAIR', () => {
        const justBelow = scorer.computeScoreResult([makeScore('PRICE', 1, 1, 0.2449)]);
        expect(justBelow.score).toBe(24);
        expect(justBelow.matchLevel).toBe('WEAK');

        const atThreshold = scorer.computeScoreResult([makeScore('PRICE', 1, 1, 0.245)]);
        expect(atThreshold.score).toBe(25);
        expect(atThreshold.matchLevel).toBe('FAIR');
      });

      it('categorizes boundary score 25 as FAIR', () => {
        expect(scorer.getMatchLevel(25)).toBe('FAIR');
        const res = scorer.computeScoreResult([makeScore('PRICE', 1, 1, 0.25)]);
        expect(res.score).toBe(25);
        expect(res.matchLevel).toBe('FAIR');
      });

      it('categorizes boundary score 49 as FAIR', () => {
        expect(scorer.getMatchLevel(49)).toBe('FAIR');
        const res = scorer.computeScoreResult([makeScore('PRICE', 1, 1, 0.49)]);
        expect(res.score).toBe(49);
        expect(res.matchLevel).toBe('FAIR');
      });
    });

    describe('WEAK (0–24)', () => {
      it('categorizes boundary score 0 as WEAK', () => {
        expect(scorer.getMatchLevel(0)).toBe('WEAK');
        const res = scorer.computeScoreResult([makeScore('PRICE', 1, 1, 0.0)]);
        expect(res.score).toBe(0);
        expect(res.matchLevel).toBe('WEAK');
      });

      it('categorizes boundary score 24 as WEAK', () => {
        expect(scorer.getMatchLevel(24)).toBe('WEAK');
        const res = scorer.computeScoreResult([makeScore('PRICE', 1, 1, 0.24)]);
        expect(res.score).toBe(24);
        expect(res.matchLevel).toBe('WEAK');
      });
    });
  });

  describe('Ineligible offers', () => {
    it('returns score: null, matchLevel: null, and breakdown: [] for ineligible offers', () => {
      const blacklistedOffer = offer({ carrierCodes: ['NK'] });
      const prefs = preferences({ blacklistedAirlines: ['NK'] });

      const [scored] = scorer.scoreOffers([blacklistedOffer], prefs);

      expect(scored.matchResult.eligibility.eligible).toBe(false);
      expect(scored.matchResult.score).toBeNull();
      expect(scored.matchResult.matchLevel).toBeNull();
      expect(scored.matchResult.breakdown).toEqual([]);
      expect(scored.matchResult.eligibility.violations).toEqual([
        {
          constraint: 'BLACKLISTED_AIRLINE',
          explanation: {
            key: 'constraint.airline.blacklisted',
            params: { airline: 'NK' },
          },
        },
      ]);
    });
  });

  describe('Immutability and purity', () => {
    it('accepts deeply frozen inputs without mutation across contribution, score, and level calculations', () => {
      const frozenBreakdown = deepFreeze([
        makeScore('PRICE', 0.8, 0.2, 0.16),
        makeScore('AIRLINE', 1.0, 0.15, 0.15),
        makeScore('STOPS', 0.5, 0.12, 0.06),
        makeScore('DURATION', 0.75, 0.08, 0.06),
      ]);
      const frozenOffers = deepFreeze([
        offer({ id: 'f-1', price: 200, carrierCodes: ['AA'] }),
        offer({ id: 'f-2', price: 300, carrierCodes: ['NK'] }),
      ]);
      const frozenPrefs = deepFreeze(
        preferences({
          preferredAirlines: ['AA'],
          blacklistedAirlines: ['NK'],
        }),
      );

      const breakdownJsonBefore = JSON.stringify(frozenBreakdown);
      const offersJsonBefore = JSON.stringify(frozenOffers);
      const prefsJsonBefore = JSON.stringify(frozenPrefs);

      expect(() => scorer.computeContribution(0.8, 0.2)).not.toThrow();
      expect(() => scorer.computeFinalScore(frozenBreakdown)).not.toThrow();
      expect(() => scorer.computeScoreResult(frozenBreakdown)).not.toThrow();
      expect(() => scorer.getMatchLevel(75)).not.toThrow();
      expect(() => scorer.scoreOffers(frozenOffers, frozenPrefs)).not.toThrow();

      expect(JSON.stringify(frozenBreakdown)).toBe(breakdownJsonBefore);
      expect(JSON.stringify(frozenOffers)).toBe(offersJsonBefore);
      expect(JSON.stringify(frozenPrefs)).toBe(prefsJsonBefore);
    });
  });
});

describe('FlightMatchScorerService breakdown order, metadata & stable tie-breaking ranking (T032)', () => {
  const scorer = new FlightMatchScorerService();

  describe('Breakdown order and metadata', () => {
    it('strictly follows canonical POLICY_DIMENSION_ORDER for eligible offers with matching activeWeights and round6 contributions', () => {
      const prefs = preferences({
        preferredAirlines: ['AA'],
        classPreference: 'economy',
        preferredDepartureWindow: { start: 8, end: 12 },
        preferredArrivalWindow: { start: 12, end: 16 },
        maxStops: 1,
        priceSensitivity: 'MODERATE',
        requiresCheckedBaggage: true,
      });

      const offers = [
        offer({
          id: 'o-1',
          price: 150,
          stops: 0,
          duration: 180,
          outboundDepartureHour: 9,
          outboundArrivalHour: 13,
          carrierCodes: ['AA'],
          cabinClass: 'economy',
          hasCheckedBaggage: true,
          originalIndex: 0,
        }),
        offer({
          id: 'o-2',
          price: 250,
          stops: 1,
          duration: 240,
          outboundDepartureHour: 10,
          outboundArrivalHour: 15,
          carrierCodes: ['DL'],
          cabinClass: 'premium_economy',
          hasCheckedBaggage: false,
          originalIndex: 1,
        }),
      ];

      const activeWeights = scorer.resolveWeights(offers, prefs);
      const results = scorer.scoreAll(offers, prefs);

      expect(results).toHaveLength(2);
      for (const result of results) {
        expect(result.matchResult.eligibility.eligible).toBe(true);
        expect(result.matchResult.score).not.toBeNull();
        expect(result.matchResult.matchLevel).not.toBeNull();

        // Canonical POLICY_DIMENSION_ORDER check
        const dimensionNames = result.matchResult.breakdown.map(
          (d: DimensionScore) => d.dimension,
        );
        expect(dimensionNames).toEqual([...POLICY_DIMENSION_ORDER]);

        // Verify each dimension's weight matches resolved activeWeights and contribution matches round6(score * weight)
        for (const dimScore of result.matchResult.breakdown) {
          const expectedWeight = activeWeights[dimScore.dimension as keyof typeof activeWeights];
          expect(dimScore.weight).toBe(expectedWeight);
          expect(dimScore.contribution).toBe(
            Math.round(dimScore.score * dimScore.weight * 1_000_000) / 1_000_000,
          );
        }

        // Verify metadata
        expect(result.matchResult.metadata).toEqual({
          scoringVersion: SCORING_POLICY_VERSION,
          activeWeights,
        });
      }
    });

    it('returns score: null, matchLevel: null, breakdown: [], and valid metadata for ineligible offers placed AFTER eligible offers', () => {
      const prefs = preferences({
        blacklistedAirlines: ['NK'],
      });

      const offers = [
        offer({
          id: 'ineligible-1',
          carrierCodes: ['NK'],
          originalIndex: 0,
        }),
        offer({
          id: 'eligible-1',
          carrierCodes: ['AA'],
          originalIndex: 1,
        }),
      ];

      const activeWeights = scorer.resolveWeights(offers, prefs);
      const results = scorer.scoreAll(offers, prefs);

      expect(results).toHaveLength(2);

      // Eligible offer placed first
      expect(results[0].offer.id).toBe('eligible-1');
      expect(results[0].matchResult.eligibility.eligible).toBe(true);

      // Ineligible offer placed after
      expect(results[1].offer.id).toBe('ineligible-1');
      expect(results[1].matchResult.eligibility.eligible).toBe(false);
      expect(results[1].matchResult.score).toBeNull();
      expect(results[1].matchResult.matchLevel).toBeNull();
      expect(results[1].matchResult.breakdown).toEqual([]);
      expect(results[1].matchResult.metadata).toEqual({
        scoringVersion: SCORING_POLICY_VERSION,
        activeWeights,
      });
    });
  });

  describe('Stable sorting order (MATCHED mode) and tie-breaking ladder', () => {
    it('sorts eligible offers before ineligible offers regardless of initial position', () => {
      const prefs = preferences({ blacklistedAirlines: ['NK'] });
      const offers = [
        offer({ id: 'ineligible-early', carrierCodes: ['NK'], originalIndex: 0 }),
        offer({ id: 'eligible-late', carrierCodes: ['AA'], originalIndex: 1 }),
      ];

      const results = scorer.scoreAll(offers, prefs);
      expect(results[0].offer.id).toBe('eligible-late');
      expect(results[1].offer.id).toBe('ineligible-early');
    });

    it('sorts eligible offers by score descending when scores differ', () => {
      const prefs = preferences({
        preferredAirlines: ['AA'],
      });
      const offers = [
        offer({ id: 'lower-score', carrierCodes: ['DL'], originalIndex: 0 }),
        offer({ id: 'higher-score', carrierCodes: ['AA'], originalIndex: 1 }),
      ];

      const results = scorer.scoreAll(offers, prefs);
      expect(results[0].offer.id).toBe('higher-score');
      expect(results[1].offer.id).toBe('lower-score');
      expect(results[0].matchResult.score!).toBeGreaterThan(results[1].matchResult.score!);
    });

    it('breaks tie on score by stops ascending (Layer 1)', () => {
      // Both within maxStops = 2 -> both receive stops subscore 1.0; other dims identical -> scores equal
      const prefs = preferences({
        maxStops: 2,
      });
      const offers = [
        offer({ id: 'more-stops', stops: 1, originalIndex: 0 }),
        offer({ id: 'fewer-stops', stops: 0, originalIndex: 1 }),
      ];

      const results = scorer.scoreAll(offers, prefs);
      expect(results[0].matchResult.score).toBe(results[1].matchResult.score);
      expect(results[0].offer.id).toBe('fewer-stops');
      expect(results[1].offer.id).toBe('more-stops');
    });

    it('breaks tie on score + stops by price ascending (Layer 2)', () => {
      // Same stops, price delta small enough that final rounded scores remain identical
      const prefs = preferences({
        maxStops: 1,
      });
      const offers = [
        offer({ id: 'higher-price', price: 100.01, stops: 0, originalIndex: 0 }),
        offer({ id: 'lower-price', price: 100.00, stops: 0, originalIndex: 1 }),
      ];

      const results = scorer.scoreAll(offers, prefs);
      expect(results[0].matchResult.score).toBe(results[1].matchResult.score);
      expect(results[0].offer.stops).toBe(results[1].offer.stops);
      expect(results[0].offer.id).toBe('lower-price');
      expect(results[1].offer.id).toBe('higher-price');
    });

    it('breaks tie on score + stops + price by duration ascending (Layer 3)', () => {
      // Same stops, same price, duration delta small enough that final rounded scores remain identical
      const prefs = preferences({
        maxStops: 1,
      });
      const offers = [
        offer({ id: 'longer-duration', price: 100, stops: 0, duration: 120.01, originalIndex: 0 }),
        offer({ id: 'shorter-duration', price: 100, stops: 0, duration: 120.00, originalIndex: 1 }),
      ];

      const results = scorer.scoreAll(offers, prefs);
      expect(results[0].matchResult.score).toBe(results[1].matchResult.score);
      expect(results[0].offer.stops).toBe(results[1].offer.stops);
      expect(results[0].offer.price).toBe(results[1].offer.price);
      expect(results[0].offer.id).toBe('shorter-duration');
      expect(results[1].offer.id).toBe('longer-duration');
    });

    it('breaks tie on score + stops + price + duration by departure red-eye penalty ascending (Layer 4)', () => {
      // 03:00 red-eye (penalty 1) loses to 10:00 non-red-eye (penalty 0)
      // When preferredDepartureWindow is null, schedule score is neutral 0.5 for both
      const prefs = preferences({
        preferredDepartureWindow: null,
      });
      const offers = [
        offer({
          id: 'red-eye-offer',
          price: 100,
          stops: 0,
          duration: 120,
          outboundDepartureHour: 3,
          originalIndex: 0,
        }),
        offer({
          id: 'daytime-offer',
          price: 100,
          stops: 0,
          duration: 120,
          outboundDepartureHour: 10,
          originalIndex: 1,
        }),
      ];

      const results = scorer.scoreAll(offers, prefs);
      expect(results[0].matchResult.score).toBe(results[1].matchResult.score);
      expect(results[0].offer.stops).toBe(results[1].offer.stops);
      expect(results[0].offer.price).toBe(results[1].offer.price);
      expect(results[0].offer.duration).toBe(results[1].offer.duration);
      expect(results[0].offer.id).toBe('daytime-offer');
      expect(results[1].offer.id).toBe('red-eye-offer');
    });

    it('breaks tie on all criteria by originalIndex ascending (Layer 5)', () => {
      const prefs = preferences();
      const offers = [
        offer({ id: 'second-offer', price: 100, stops: 0, duration: 120, outboundDepartureHour: 10, originalIndex: 5 }),
        offer({ id: 'first-offer', price: 100, stops: 0, duration: 120, outboundDepartureHour: 10, originalIndex: 2 }),
      ];

      // Test passed in reversed order
      const results = scorer.scoreAll(offers, prefs);
      expect(results[0].offer.id).toBe('first-offer');
      expect(results[1].offer.id).toBe('second-offer');
    });

    it('sorts multiple ineligible offers stably by originalIndex at the end', () => {
      const prefs = preferences({ blacklistedAirlines: ['NK', 'F9'] });
      const offers = [
        offer({ id: 'ineligible-2', carrierCodes: ['NK'], originalIndex: 8 }),
        offer({ id: 'eligible-1', carrierCodes: ['AA'], originalIndex: 4 }),
        offer({ id: 'ineligible-1', carrierCodes: ['F9'], originalIndex: 1 }),
      ];

      const results = scorer.scoreAll(offers, prefs);
      expect(results.map((r: ScoredOffer) => r.offer.id)).toEqual([
        'eligible-1',
        'ineligible-1',
        'ineligible-2',
      ]);
    });
  });

  describe('Degenerate cases', () => {
    it('returns empty array when offers array is empty', () => {
      const results = scorer.scoreAll([], preferences());
      expect(results).toEqual([]);
    });

    it('returns sorted 1-element array for single eligible offer', () => {
      const single = offer({ id: 'solo', originalIndex: 0 });
      const results = scorer.scoreAll([single], preferences());
      expect(results).toHaveLength(1);
      expect(results[0].offer.id).toBe('solo');
      expect(results[0].matchResult.eligibility.eligible).toBe(true);
    });

    it('returns all ineligible offers at end with originalIndex order preserved', () => {
      const prefs = preferences({ blacklistedAirlines: ['NK'] });
      const offers = [
        offer({ id: 'inelig-b', carrierCodes: ['NK'], originalIndex: 10 }),
        offer({ id: 'inelig-a', carrierCodes: ['NK'], originalIndex: 3 }),
      ];

      const results = scorer.scoreAll(offers, prefs);
      expect(results).toHaveLength(2);
      expect(results[0].offer.id).toBe('inelig-a');
      expect(results[1].offer.id).toBe('inelig-b');
      expect(results[0].matchResult.eligibility.eligible).toBe(false);
      expect(results[1].matchResult.eligibility.eligible).toBe(false);
    });
  });

  describe('Immutability and purity', () => {
    it('does not mutate frozen offers array, offer objects, or preferences', () => {
      const frozenOffers = deepFreeze([
        offer({ id: 'f-1', price: 200, stops: 1, duration: 150, outboundDepartureHour: 10, carrierCodes: ['AA'], originalIndex: 1 }),
        offer({ id: 'f-2', price: 100, stops: 0, duration: 120, outboundDepartureHour: 9, carrierCodes: ['AA'], originalIndex: 0 }),
        offer({ id: 'f-3', carrierCodes: ['NK'], originalIndex: 2 }),
      ]);
      const frozenPrefs = deepFreeze(
        preferences({
          preferredAirlines: ['AA'],
          blacklistedAirlines: ['NK'],
          classPreference: 'economy',
        }),
      );

      const offersJsonBefore = JSON.stringify(frozenOffers);
      const prefsJsonBefore = JSON.stringify(frozenPrefs);

      let results: readonly ScoredOffer[] = [];
      expect(() => {
        results = scorer.scoreAll(frozenOffers, frozenPrefs);
      }).not.toThrow();

      expect(results).toHaveLength(3);
      expect(JSON.stringify(frozenOffers)).toBe(offersJsonBefore);
      expect(JSON.stringify(frozenPrefs)).toBe(prefsJsonBefore);
    });
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
  params: Record<string, unknown> = {},
): DimensionScore {
  return {
    dimension,
    score,
    weight,
    contribution: Math.round(score * weight * 1_000_000) / 1_000_000,
    signal,
    // Type assertion needed because test helper constructs generic Explanation with arbitrary key/params for assertions
    explanation: { key, params } as unknown as DimensionScore['explanation'],
  };
}
