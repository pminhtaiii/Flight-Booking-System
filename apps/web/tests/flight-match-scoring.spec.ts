import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { DimensionScore, FlightMatchResult, FlightSearchOfferView } from '@shared/types';
import { FlightMatchBadge } from '../components/search/FlightMatchBadge';
import { FlightMatchBreakdown } from '../components/search/FlightMatchBreakdown';
import { FlightRankingBanner } from '../components/search/FlightRankingBanner';
import { FlightResultsControls } from '../components/search/FlightResultsControls';

describe('FlightMatchBadge (T050)', (): void => {
  const mockEligibleResult = (
    score: number,
    matchLevel: 'STRONG' | 'GOOD' | 'FAIR' | 'WEAK',
  ): FlightMatchResult => ({
    eligibility: {
      eligible: true,
      violations: [],
    },
    score,
    matchLevel,
    breakdown: [],
    metadata: {
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
    },
  });

  const mockIneligibleResult = (airlineName?: string): FlightMatchResult => ({
    eligibility: {
      eligible: false,
      violations: [
        {
          constraint: 'BLACKLISTED_AIRLINE',
          explanation: {
            key: 'constraint.airline.blacklisted',
            params: airlineName ? { airline: airlineName } : {},
          },
        },
      ],
    },
    score: null,
    matchLevel: null,
    breakdown: [],
    metadata: {
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
    },
  });

  describe('Null / undefined handling', (): void => {
    it('returns empty output when matchResult is null', (): void => {
      const html = renderToStaticMarkup(
        React.createElement(FlightMatchBadge, { matchResult: null }),
      );
      assert.equal(html, '');
    });

    it('returns empty output when matchResult is undefined', (): void => {
      const html = renderToStaticMarkup(
        React.createElement(FlightMatchBadge, { matchResult: undefined }),
      );
      assert.equal(html, '');
    });

    it('returns empty output when props are omitted', (): void => {
      const html = renderToStaticMarkup(React.createElement(FlightMatchBadge, {}));
      assert.equal(html, '');
    });
  });

  describe('Eligible presentation with semantic styling', (): void => {
    it('renders STRONG match level with semantic classes and 85% score', (): void => {
      const result = mockEligibleResult(85, 'STRONG');
      const html = renderToStaticMarkup(
        React.createElement(FlightMatchBadge, { matchResult: result }),
      );

      assert.match(html, /text-text-match-strong/);
      assert.match(html, /bg-bg-match-strong/);
      assert.match(html, /border-text-match-strong\/30/);
      assert.match(html, /85%/);
      assert.match(html, /Strong Match/i);
    });

    it('renders GOOD match level with semantic classes and 65% score', (): void => {
      const result = mockEligibleResult(65, 'GOOD');
      const html = renderToStaticMarkup(
        React.createElement(FlightMatchBadge, { matchResult: result }),
      );

      assert.match(html, /text-text-match-good/);
      assert.match(html, /bg-bg-match-good/);
      assert.match(html, /border-text-match-good\/30/);
      assert.match(html, /65%/);
      assert.match(html, /Good Match/i);
    });

    it('renders FAIR match level with semantic classes and 40% score', (): void => {
      const result = mockEligibleResult(40, 'FAIR');
      const html = renderToStaticMarkup(
        React.createElement(FlightMatchBadge, { matchResult: result }),
      );

      assert.match(html, /text-text-match-fair/);
      assert.match(html, /bg-bg-match-fair/);
      assert.match(html, /border-text-match-fair\/30/);
      assert.match(html, /40%/);
      assert.match(html, /Fair Match/i);
    });

    it('renders WEAK match level with semantic classes and 15% score', (): void => {
      const result = mockEligibleResult(15, 'WEAK');
      const html = renderToStaticMarkup(
        React.createElement(FlightMatchBadge, { matchResult: result }),
      );

      assert.match(html, /text-text-match-weak/);
      assert.match(html, /bg-bg-match-weak/);
      assert.match(html, /border-text-match-weak\/30/);
      assert.match(html, /15%/);
      assert.match(html, /Weak Match/i);
    });

    it('appends custom className when provided', (): void => {
      const result = mockEligibleResult(90, 'STRONG');
      const html = renderToStaticMarkup(
        React.createElement(FlightMatchBadge, {
          matchResult: result,
          className: 'custom-test-class',
        }),
      );

      assert.match(html, /custom-test-class/);
    });
  });

  describe('Ineligible warning presentation', (): void => {
    it('renders accessible warning badge with default blacklisted airline reason', (): void => {
      const result = mockIneligibleResult();
      const html = renderToStaticMarkup(
        React.createElement(FlightMatchBadge, { matchResult: result }),
      );

      assert.match(html, /aria-label="Flight violates preference: Blacklisted airline"/);
      assert.match(html, /Blacklisted airline/);
      assert.match(html, /text-text-cancelled/);
      assert.match(html, /bg-bg-cancelled/);
      assert.match(html, /border-danger-border/);
      assert.doesNotMatch(html, /#/); // Never use hardcoded hex
    });

    it('renders accessible warning badge with specific blacklisted carrier name', (): void => {
      const result = mockIneligibleResult('Spirit');
      const html = renderToStaticMarkup(
        React.createElement(FlightMatchBadge, { matchResult: result }),
      );

      assert.match(html, /aria-label="Flight violates preference: Blacklisted airline \(Spirit\)"/);
      assert.match(html, /Blacklisted airline \(Spirit\)/);
    });
  });
});

describe('FlightMatchBreakdown (T051)', (): void => {
  const mockDimensions: DimensionScore[] = [
    {
      dimension: 'PRICE',
      score: 0.9,
      weight: 0.2,
      contribution: 0.18,
      signal: 'POSITIVE',
      explanation: {
        key: 'match.price.below_median',
        params: { percentDiff: 15 },
      },
    },
    {
      dimension: 'AIRLINE',
      score: 1.0,
      weight: 0.15,
      contribution: 0.15,
      signal: 'POSITIVE',
      explanation: {
        key: 'match.airline.preferred',
        params: { airline: 'Delta' },
      },
    },
    {
      dimension: 'ARRIVAL_SCHEDULE',
      score: 0.5,
      weight: 0.15,
      contribution: 0.075,
      signal: 'NEUTRAL',
      explanation: {
        key: 'match.arrival.near_window',
        params: {},
      },
    },
    {
      dimension: 'STOPS',
      score: 1.0,
      weight: 0.12,
      contribution: 0.12,
      signal: 'POSITIVE',
      explanation: {
        key: 'match.stops.within_preference',
        params: { stops: 0 },
      },
    },
    {
      dimension: 'CABIN',
      score: 1.0,
      weight: 0.1,
      contribution: 0.1,
      signal: 'POSITIVE',
      explanation: {
        key: 'match.cabin.exact',
        params: {},
      },
    },
    {
      dimension: 'DEPARTURE_SCHEDULE',
      score: 0.0,
      weight: 0.1,
      contribution: 0.0,
      signal: 'NEGATIVE',
      explanation: {
        key: 'match.departure.outside_window',
        params: {},
      },
    },
    {
      dimension: 'BAGGAGE',
      score: 1.0,
      weight: 0.1,
      contribution: 0.1,
      signal: 'POSITIVE',
      explanation: {
        key: 'match.baggage.checked_included',
        params: {},
      },
    },
    {
      dimension: 'DURATION',
      score: 0.5,
      weight: 0.08,
      contribution: 0.04,
      signal: 'NEUTRAL',
      explanation: {
        key: 'match.duration.at_median',
        params: {},
      },
    },
  ];

  const mockEligibleResult = (breakdown: DimensionScore[] = mockDimensions): FlightMatchResult => ({
    eligibility: {
      eligible: true,
      violations: [],
    },
    score: 85,
    matchLevel: 'STRONG',
    breakdown,
    metadata: {
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
    },
  });

  const mockIneligibleResult = (carrier = 'Spirit'): FlightMatchResult => ({
    eligibility: {
      eligible: false,
      violations: [
        {
          constraint: 'BLACKLISTED_AIRLINE',
          explanation: {
            key: 'constraint.airline.blacklisted',
            params: { airline: carrier },
          },
        },
      ],
    },
    score: null,
    matchLevel: null,
    breakdown: [],
    metadata: {
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
    },
  });

  describe('Null / undefined handling', (): void => {
    it('returns empty output when matchResult is null', (): void => {
      const html = renderToStaticMarkup(
        React.createElement(FlightMatchBreakdown, { matchResult: null }),
      );
      assert.equal(html, '');
    });

    it('returns empty output when matchResult is undefined', (): void => {
      const html = renderToStaticMarkup(
        React.createElement(FlightMatchBreakdown, { matchResult: undefined }),
      );
      assert.equal(html, '');
    });

    it('returns empty output when props are omitted', (): void => {
      const html = renderToStaticMarkup(React.createElement(FlightMatchBreakdown, {}));
      assert.equal(html, '');
    });
  });

  describe('Accessible disclosure and summary structure', (): void => {
    it('renders native <details> and <summary> disclosure elements', (): void => {
      const result = mockEligibleResult();
      const html = renderToStaticMarkup(
        React.createElement(FlightMatchBreakdown, { matchResult: result }),
      );

      assert.match(html, /<details/);
      assert.match(html, /<summary/);
      assert.match(html, /Why this flight\?|View match breakdown/i);
    });

    it('appends custom className when provided', (): void => {
      const result = mockEligibleResult();
      const html = renderToStaticMarkup(
        React.createElement(FlightMatchBreakdown, {
          matchResult: result,
          className: 'custom-breakdown-style',
        }),
      );

      assert.match(html, /custom-breakdown-style/);
    });
  });

  describe('Eligible dimension scores presentation', (): void => {
    it('renders active dimension scores strictly in policy order even if provided reversed', (): void => {
      const reversedDimensions = [...mockDimensions].reverse();
      const result = mockEligibleResult(reversedDimensions);
      const html = renderToStaticMarkup(
        React.createElement(FlightMatchBreakdown, { matchResult: result }),
      );

      // Verify policy order: PRICE -> AIRLINE -> ARRIVAL_SCHEDULE -> STOPS -> CABIN -> DEPARTURE_SCHEDULE -> BAGGAGE -> DURATION
      const priceIndex = html.indexOf('15% below median price');
      const airlineIndex = html.indexOf('Matches preferred airline (Delta)');
      const arrivalIndex = html.indexOf('Arrives near preferred window');
      const stopsIndex = html.indexOf('Within preferred stops (0 stops)');
      const cabinIndex = html.indexOf('Matches requested cabin');
      const departureIndex = html.indexOf('Departs outside preferred window');
      const baggageIndex = html.indexOf('Checked bag included');
      const durationIndex = html.indexOf('Median duration');

      assert.ok(priceIndex !== -1, 'Price explanation must be present');
      assert.ok(airlineIndex !== -1, 'Airline explanation must be present');
      assert.ok(arrivalIndex !== -1, 'Arrival explanation must be present');
      assert.ok(stopsIndex !== -1, 'Stops explanation must be present');
      assert.ok(cabinIndex !== -1, 'Cabin explanation must be present');
      assert.ok(departureIndex !== -1, 'Departure explanation must be present');
      assert.ok(baggageIndex !== -1, 'Baggage explanation must be present');
      assert.ok(durationIndex !== -1, 'Duration explanation must be present');

      assert.ok(priceIndex < airlineIndex, 'PRICE must precede AIRLINE');
      assert.ok(airlineIndex < arrivalIndex, 'AIRLINE must precede ARRIVAL_SCHEDULE');
      assert.ok(arrivalIndex < stopsIndex, 'ARRIVAL_SCHEDULE must precede STOPS');
      assert.ok(stopsIndex < cabinIndex, 'STOPS must precede CABIN');
      assert.ok(cabinIndex < departureIndex, 'CABIN must precede DEPARTURE_SCHEDULE');
      assert.ok(departureIndex < baggageIndex, 'DEPARTURE_SCHEDULE must precede BAGGAGE');
      assert.ok(baggageIndex < durationIndex, 'BAGGAGE must precede DURATION');
    });

    it('renders semantic indicators for POSITIVE, NEUTRAL, and NEGATIVE signals without hardcoded hex', (): void => {
      const result = mockEligibleResult();
      const html = renderToStaticMarkup(
        React.createElement(FlightMatchBreakdown, { matchResult: result }),
      );

      // Semantic tokens for POSITIVE
      assert.match(html, /text-text-match-strong|bg-bg-match-strong/);
      // Semantic tokens for NEUTRAL
      assert.match(html, /text-text-secondary|bg-background/);
      // Semantic tokens for NEGATIVE
      assert.match(html, /text-text-cancelled|bg-bg-cancelled/);
      // No hardcoded hex
      assert.doesNotMatch(html, /#[0-9a-fA-F]{3,6}/);
    });

    it('renders human-readable copy from formatExplanation', (): void => {
      const result = mockEligibleResult();
      const html = renderToStaticMarkup(
        React.createElement(FlightMatchBreakdown, { matchResult: result }),
      );

      assert.match(html, /15% below median price/);
      assert.match(html, /Matches preferred airline \(Delta\)/);
      assert.match(html, /Arrives near preferred window/);
      assert.match(html, /Within preferred stops \(0 stops\)/);
      assert.match(html, /Matches requested cabin/);
      assert.match(html, /Departs outside preferred window/);
      assert.match(html, /Checked bag included/);
      assert.match(html, /Median duration/);
    });
  });

  describe('Ineligible constraint violations presentation', (): void => {
    it('renders constraint violations list prominently with formatted copy', (): void => {
      const result = mockIneligibleResult('Spirit');
      const html = renderToStaticMarkup(
        React.createElement(FlightMatchBreakdown, { matchResult: result }),
      );

      assert.match(html, /<details/);
      assert.match(html, /Blacklisted airline \(Spirit\)/);
      assert.match(html, /text-text-cancelled|bg-bg-cancelled|border-danger-border/);
      assert.match(html, /focus-visible:ring-accent/);
      assert.doesNotMatch(html, /#[0-9a-fA-F]{3,6}/);
    });
  });

  describe('Selection Invariant: Ineligible offers remain selectable', (): void => {
    it('does not disable offer selection or booking for ineligible offers', (): void => {
      const ineligibleResult = mockIneligibleResult('Spirit');
      const mockOffer: FlightSearchOfferView = {
        id: 'offer-local-123',
        price: 350,
        currency: 'USD',
        airline: 'Spirit',
        flightNumber: 'NK123',
        origin: 'JFK',
        destination: 'LAX',
        departureAt: '2026-10-01T08:00:00Z',
        arrivalAt: '2026-10-01T11:00:00Z',
        duration: 'PT6H00M',
        stops: 0,
        slices: [
          {
            origin: 'JFK',
            destination: 'LAX',
            departureAt: '2026-10-01T08:00:00Z',
            arrivalAt: '2026-10-01T11:00:00Z',
            duration: 'PT6H00M',
            stops: 0,
            segments: [
              {
                airline: 'Spirit',
                flightNumber: 'NK123',
                origin: 'JFK',
                destination: 'LAX',
                departureAt: '2026-10-01T08:00:00Z',
                arrivalAt: '2026-10-01T11:00:00Z',
                duration: 'PT6H00M',
                cabinClass: 'economy',
              },
            ],
          },
        ],
        matchResult: ineligibleResult,
      };

      // Breakdown itself must not contain disabled attributes or disable mechanisms
      const breakdownHtml = renderToStaticMarkup(
        React.createElement(FlightMatchBreakdown, { matchResult: mockOffer.matchResult }),
      );
      assert.doesNotMatch(breakdownHtml, /disabled/);

      // In an offer card composition with breakdown, selection button remains fully enabled
      const compositeCardHtml = renderToStaticMarkup(
        React.createElement(
          'div',
          { 'data-testid': 'flight-offer-card' },
          React.createElement(FlightMatchBreakdown, { matchResult: mockOffer.matchResult }),
          React.createElement(
            'button',
            {
              type: 'button',
              'data-offer-id': mockOffer.id,
              'aria-label': `Select flight ${mockOffer.flightNumber}`,
            },
            'Select',
          ),
        ),
      );

      assert.match(compositeCardHtml, /data-offer-id="offer-local-123"/);
      assert.doesNotMatch(compositeCardHtml, /disabled/);
    });
  });
});

describe('FlightRankingBanner (T052)', (): void => {
  describe('Mode handling and conditional rendering', (): void => {
    it('returns empty output when mode is MATCHED', (): void => {
      const html = renderToStaticMarkup(
        React.createElement(FlightRankingBanner, { mode: 'MATCHED' }),
      );
      assert.equal(html, '');
    });

    it('returns empty output when mode is not RANKED', (): void => {
      const html = renderToStaticMarkup(
        React.createElement(FlightRankingBanner, { mode: 'UNKNOWN' as unknown as 'RANKED' }),
      );
      assert.equal(html, '');
    });
  });

  describe('RANKED presentation and requirements', (): void => {
    it('renders container with role="status" or role="region" when mode is RANKED', (): void => {
      const html = renderToStaticMarkup(
        React.createElement(FlightRankingBanner, { mode: 'RANKED' }),
      );
      assert.match(html, /role="(status|region)"/);
    });

    it('renders the exact category ranking copy', (): void => {
      const html = renderToStaticMarkup(
        React.createElement(FlightRankingBanner, { mode: 'RANKED' }),
      );
      assert.match(
        html,
        /Showing standard category ranking \(stops, price, duration\)\. Customize your flight preferences in your traveler profile\./,
      );
    });

    it('renders an accessible CTA link to /profile with text "Update Preferences"', (): void => {
      const html = renderToStaticMarkup(
        React.createElement(FlightRankingBanner, { mode: 'RANKED' }),
      );
      assert.match(html, /href="\/profile"/);
      assert.match(html, /Update Preferences/);
    });

    it('appends custom className when provided', (): void => {
      const html = renderToStaticMarkup(
        React.createElement(FlightRankingBanner, {
          mode: 'RANKED',
          className: 'custom-banner-class',
        }),
      );
      assert.match(html, /custom-banner-class/);
    });
  });

  describe('Strict No-Score Invariant & Semantic styling', (): void => {
    it('strictly contains zero percentages, match level badges, or match score claims', (): void => {
      const html = renderToStaticMarkup(
        React.createElement(FlightRankingBanner, { mode: 'RANKED' }),
      );
      assert.doesNotMatch(html, /\d+%/);
      assert.doesNotMatch(html, /Strong Match|Good Match|Fair Match|Weak Match/i);
      assert.doesNotMatch(html, /match score|match breakdown/i);
    });

    it('uses semantic Tailwind classes with zero hardcoded hex colors', (): void => {
      const html = renderToStaticMarkup(
        React.createElement(FlightRankingBanner, { mode: 'RANKED' }),
      );
      assert.match(html, /border-card-border/);
      assert.match(html, /bg-card/);
      assert.match(html, /text-text-secondary/);
      assert.match(html, /text-accent/);
      assert.match(html, /focus-visible:ring-accent/);
      assert.doesNotMatch(html, /#[0-9a-fA-F]{3,6}/);
    });
  });
});

describe('FlightResultsControls (T052)', (): void => {
  describe('Mode-specific default sort options', (): void => {
    it('renders "Best Match" as the primary sort option in MATCHED mode', (): void => {
      const html = renderToStaticMarkup(
        React.createElement(FlightResultsControls, { mode: 'MATCHED' }),
      );
      assert.match(html, /Best Match/);
      assert.match(html, /value="BEST_MATCH"/);
      assert.doesNotMatch(html, /Recommended \(Category Rank\)/);
    });

    it('defaults to selected BEST_MATCH when sortBy is omitted in MATCHED mode', (): void => {
      const html = renderToStaticMarkup(
        React.createElement(FlightResultsControls, { mode: 'MATCHED' }),
      );
      assert.match(html, /<option[^>]*value="BEST_MATCH"[^>]*selected/);
    });

    it('renders "Recommended (Category Rank)" as the primary sort option in RANKED mode', (): void => {
      const html = renderToStaticMarkup(
        React.createElement(FlightResultsControls, { mode: 'RANKED' }),
      );
      assert.match(html, /Recommended \(Category Rank\)/);
      assert.match(html, /value="RECOMMENDED"/);
      assert.doesNotMatch(html, /Best Match/);
    });

    it('defaults to selected RECOMMENDED when sortBy is omitted in RANKED mode', (): void => {
      const html = renderToStaticMarkup(
        React.createElement(FlightResultsControls, { mode: 'RANKED' }),
      );
      assert.match(html, /<option[^>]*value="RECOMMENDED"[^>]*selected/);
    });
  });

  describe('Objective sort options available in both modes', (): void => {
    it('renders Price, Duration, Stops, and Departure Time sort options in MATCHED mode', (): void => {
      const html = renderToStaticMarkup(
        React.createElement(FlightResultsControls, { mode: 'MATCHED' }),
      );
      assert.match(html, /<option[^>]*value="PRICE"[^>]*>.*(?:Cheapest|Price).*<\/option>/);
      assert.match(html, /<option[^>]*value="DURATION"[^>]*>.*(?:Fastest|Duration).*<\/option>/);
      assert.match(html, /<option[^>]*value="STOPS"[^>]*>.*(?:Fewest Stops|Stops).*<\/option>/);
      assert.match(html, /<option[^>]*value="DEPARTURE_TIME"[^>]*>.*Departure Time.*<\/option>/);
    });

    it('renders Price, Duration, Stops, and Departure Time sort options in RANKED mode', (): void => {
      const html = renderToStaticMarkup(
        React.createElement(FlightResultsControls, { mode: 'RANKED' }),
      );
      assert.match(html, /<option[^>]*value="PRICE"[^>]*>.*(?:Cheapest|Price).*<\/option>/);
      assert.match(html, /<option[^>]*value="DURATION"[^>]*>.*(?:Fastest|Duration).*<\/option>/);
      assert.match(html, /<option[^>]*value="STOPS"[^>]*>.*(?:Fewest Stops|Stops).*<\/option>/);
      assert.match(html, /<option[^>]*value="DEPARTURE_TIME"[^>]*>.*Departure Time.*<\/option>/);
    });
  });

  describe('Selection state, count display, and accessibility', (): void => {
    it('respects explicit sortBy prop for objective sorting', (): void => {
      const html = renderToStaticMarkup(
        React.createElement(FlightResultsControls, { mode: 'MATCHED', sortBy: 'PRICE' }),
      );
      assert.match(html, /<option[^>]*value="PRICE"[^>]*selected/);
    });

    it('includes accessible aria-label on select control', (): void => {
      const html = renderToStaticMarkup(
        React.createElement(FlightResultsControls, { mode: 'MATCHED' }),
      );
      assert.match(html, /<select[^>]*aria-label="Sort flight results"/);
    });

    it('displays totalResults count when provided (plural and singular)', (): void => {
      const htmlPlural = renderToStaticMarkup(
        React.createElement(FlightResultsControls, { mode: 'MATCHED', totalResults: 24 }),
      );
      assert.match(htmlPlural, /24 flights found|24 results/i);

      const htmlSingle = renderToStaticMarkup(
        React.createElement(FlightResultsControls, { mode: 'RANKED', totalResults: 1 }),
      );
      assert.match(htmlSingle, /1 flight found|1 result/i);

      const htmlZero = renderToStaticMarkup(
        React.createElement(FlightResultsControls, { mode: 'RANKED', totalResults: 0 }),
      );
      assert.match(htmlZero, /0 flights found|0 results/i);
    });

    it('appends custom className when provided', (): void => {
      const html = renderToStaticMarkup(
        React.createElement(FlightResultsControls, {
          mode: 'MATCHED',
          className: 'custom-controls-class',
        }),
      );
      assert.match(html, /custom-controls-class/);
    });

    it('uses semantic Tailwind classes with zero hardcoded hex colors', (): void => {
      const html = renderToStaticMarkup(
        React.createElement(FlightResultsControls, { mode: 'MATCHED' }),
      );
      assert.match(html, /text-text-secondary/);
      assert.match(html, /border-secondary-border/);
      assert.match(html, /bg-card/);
      assert.match(html, /text-text-primary/);
      assert.match(html, /focus:border-accent/);
      assert.match(html, /focus:ring-accent/);
      assert.doesNotMatch(html, /#[0-9a-fA-F]{3,6}/);
    });
  });
});


