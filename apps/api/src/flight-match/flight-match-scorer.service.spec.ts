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
