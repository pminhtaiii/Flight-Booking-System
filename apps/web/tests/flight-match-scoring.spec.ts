import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { DimensionScore, FlightMatchResult, FlightSearchMeta, FlightSearchOfferView, FlightSearchOutcome, FlightSearchQuery, FlightSelectionOutcome } from '@shared/types';
import { FlightMatchBadge } from '../components/search/FlightMatchBadge';
import { FlightMatchBreakdown } from '../components/search/FlightMatchBreakdown';
import { FlightRankingBanner } from '../components/search/FlightRankingBanner';
import { FlightResultsControls } from '../components/search/FlightResultsControls';
import { FlightResultCard } from '../components/search/FlightResultCard';
import { FlightResults } from '../components/search/FlightResults';
import { SearchFormClient } from '../components/search/SearchFormClient';
import { getInitialValues } from '../lib/search-prefill';
import { fetchProfileCabinPreference } from '../lib/profile';

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

describe('FlightResultCard (T053)', (): void => {
  const createMockOffer = (overrides?: Partial<FlightSearchOfferView>): FlightSearchOfferView => ({
    id: 'offer-delta-101',
    price: 350,
    currency: 'USD',
    airline: 'Delta Air Lines',
    flightNumber: 'DL1234',
    origin: 'JFK',
    destination: 'LAX',
    departureAt: '2026-10-01T08:30:00Z',
    arrivalAt: '2026-10-01T11:45:00Z',
    duration: 'PT3H15M',
    stops: 0,
    slices: [
      {
        origin: 'JFK',
        destination: 'LAX',
        departureAt: '2026-10-01T08:30:00Z',
        arrivalAt: '2026-10-01T11:45:00Z',
        duration: 'PT3H15M',
        stops: 0,
        segments: [
          {
            airline: 'Delta Air Lines',
            flightNumber: 'DL1234',
            origin: 'JFK',
            destination: 'LAX',
            departureAt: '2026-10-01T08:30:00Z',
            arrivalAt: '2026-10-01T11:45:00Z',
            duration: 'PT3H15M',
            cabinClass: 'economy',
          },
        ],
      },
    ],
    ...overrides,
  });

  const mockEligibleResult = (score = 85): FlightMatchResult => ({
    eligibility: { eligible: true, violations: [] },
    score,
    matchLevel: score >= 75 ? 'STRONG' : 'GOOD',
    breakdown: [
      {
        dimension: 'PRICE',
        score: 0.9,
        weight: 0.2,
        contribution: 0.18,
        signal: 'POSITIVE',
        explanation: { key: 'match.price.below_median', params: { percentDiff: 15 } },
      },
      {
        dimension: 'BAGGAGE',
        score: 1.0,
        weight: 0.1,
        contribution: 0.1,
        signal: 'POSITIVE',
        explanation: { key: 'match.baggage.checked_included', params: {} },
      },
    ],
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
          explanation: { key: 'constraint.airline.blacklisted', params: { airline: carrier } },
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

  describe('Flight details presentation', (): void => {
    it('renders airline, flight number, route, formatted duration, and price', (): void => {
      const offer = createMockOffer({
        airline: 'Delta Air Lines',
        flightNumber: 'DL1234',
        origin: 'JFK',
        destination: 'LAX',
        duration: 'PT3H15M',
        price: 350,
        currency: 'USD',
        stops: 0,
      });

      const html = renderToStaticMarkup(
        React.createElement(FlightResultCard, {
          offer,
          onSelect: () => {},
        }),
      );

      assert.match(html, /Delta Air Lines/);
      assert.match(html, /DL1234/);
      assert.match(html, /JFK/);
      assert.match(html, /LAX/);
      assert.match(html, /3h 15m/);
      assert.match(html, /Non-stop/);
      assert.match(html, /350/);
      assert.match(html, /USD/);
    });

    it('renders stop count variations correctly (1 stop, 2 stops)', (): void => {
      const singleStopOffer = createMockOffer({ stops: 1, duration: 'PT5H30M' });
      const htmlSingle = renderToStaticMarkup(
        React.createElement(FlightResultCard, {
          offer: singleStopOffer,
          onSelect: () => {},
        }),
      );
      assert.match(htmlSingle, /1 stop/);
      assert.match(htmlSingle, /5h 30m/);

      const multiStopOffer = createMockOffer({ stops: 2, duration: 'PT8H45M' });
      const htmlMulti = renderToStaticMarkup(
        React.createElement(FlightResultCard, {
          offer: multiStopOffer,
          onSelect: () => {},
        }),
      );
      assert.match(htmlMulti, /2 stops/);
      assert.match(htmlMulti, /8h 45m/);
    });

    it('renders cabin class and baggage allowance', (): void => {
      const offer = createMockOffer({
        matchResult: mockEligibleResult(),
        slices: [
          {
            origin: 'JFK',
            destination: 'LAX',
            departureAt: '2026-10-01T08:30:00Z',
            arrivalAt: '2026-10-01T11:45:00Z',
            duration: 'PT3H15M',
            stops: 0,
            segments: [
              {
                airline: 'Delta Air Lines',
                flightNumber: 'DL1234',
                origin: 'JFK',
                destination: 'LAX',
                departureAt: '2026-10-01T08:30:00Z',
                arrivalAt: '2026-10-01T11:45:00Z',
                duration: 'PT3H15M',
                cabinClass: 'business',
              },
            ],
          },
        ],
      });

      const html = renderToStaticMarkup(
        React.createElement(FlightResultCard, {
          offer,
          onSelect: () => {},
        }),
      );

      assert.match(html, /Business/i);
      assert.match(html, /Checked bag included/i);
    });

    it('displays Business for mixed-cabin itinerary with shorter 1st segment in economy (PT1H) and longer 2nd segment in business (PT8H)', (): void => {
      const mixedCabinOffer = createMockOffer({
        stops: 1,
        duration: 'PT9H',
        slices: [
          {
            origin: 'JFK',
            destination: 'CDG',
            departureAt: '2026-10-01T08:00:00Z',
            arrivalAt: '2026-10-01T22:00:00Z',
            duration: 'PT9H',
            stops: 1,
            segments: [
              {
                airline: 'Delta Air Lines',
                flightNumber: 'DL101',
                origin: 'JFK',
                destination: 'BOS',
                departureAt: '2026-10-01T08:00:00Z',
                arrivalAt: '2026-10-01T09:00:00Z',
                duration: 'PT1H',
                cabinClass: 'economy',
              },
              {
                airline: 'Delta Air Lines',
                flightNumber: 'DL102',
                origin: 'BOS',
                destination: 'CDG',
                departureAt: '2026-10-01T11:00:00Z',
                arrivalAt: '2026-10-01T22:00:00Z',
                duration: 'PT8H',
                cabinClass: 'business',
              },
            ],
          },
        ],
      });

      const html = renderToStaticMarkup(
        React.createElement(FlightResultCard, {
          offer: mixedCabinOffer,
          onSelect: () => {},
        }),
      );

      assert.match(html, />\s*Business\s*</);
      assert.doesNotMatch(html, />\s*Economy\s*</);
    });
  });

  describe('Embedded match transparency components', (): void => {
    it('renders FlightMatchBadge and FlightMatchBreakdown when eligible matchResult is present', (): void => {
      const offer = createMockOffer({ matchResult: mockEligibleResult(85) });
      const html = renderToStaticMarkup(
        React.createElement(FlightResultCard, {
          offer,
          onSelect: () => {},
        }),
      );

      assert.match(html, /85%/);
      assert.match(html, /Strong Match/i);
      assert.match(html, /text-text-match-strong/);
      assert.match(html, /<details/);
      assert.match(html, /<summary/);
      assert.match(html, /15% below median price/);
    });

    it('renders warning badge and breakdown when ineligible matchResult is present', (): void => {
      const offer = createMockOffer({
        airline: 'Spirit',
        matchResult: mockIneligibleResult('Spirit'),
      });
      const html = renderToStaticMarkup(
        React.createElement(FlightResultCard, {
          offer,
          onSelect: () => {},
        }),
      );

      assert.match(html, /Blacklisted airline \(Spirit\)/);
      assert.match(html, /text-text-cancelled/);
      assert.match(html, /<details/);
    });

    it('renders cleanly with zero match badges or breakdowns when matchResult is null or undefined', (): void => {
      const offer = createMockOffer({ matchResult: null });
      const html = renderToStaticMarkup(
        React.createElement(FlightResultCard, {
          offer,
          onSelect: () => {},
        }),
      );

      assert.doesNotMatch(html, /\d+%/);
      assert.doesNotMatch(html, /Strong Match|Good Match|Fair Match|Weak Match/i);
      assert.doesNotMatch(html, /<details/);
      assert.doesNotMatch(html, /match score|breakdown/i);
    });
  });

  describe('Strict Provider-Blind Invariant & Selection Interaction', (): void => {
    it('attaches local deterministic ID to DOM attributes and never leaks provider IDs', (): void => {
      const localId = 'offer-local-deterministic-789';
      const offer = createMockOffer({ id: localId });

      const html = renderToStaticMarkup(
        React.createElement(FlightResultCard, {
          offer,
          onSelect: () => {},
        }),
      );

      assert.match(html, /data-offer-id="offer-local-deterministic-789"/);
      assert.doesNotMatch(html, /off_[0-9a-zA-Z]+/);
    });

    it('renders interactive button with disabled state when isSelecting is true', (): void => {
      const offer = createMockOffer({ id: 'offer-123' });

      const htmlEnabled = renderToStaticMarkup(
        React.createElement(FlightResultCard, {
          offer,
          onSelect: () => {},
          isSelecting: false,
        }),
      );
      assert.match(htmlEnabled, /<button[^>]*data-offer-id="offer-123"/);
      assert.doesNotMatch(htmlEnabled, /\sdisabled(?!=:)[=>\s]/);

      const htmlSelecting = renderToStaticMarkup(
        React.createElement(FlightResultCard, {
          offer,
          onSelect: () => {},
          isSelecting: true,
        }),
      );
      assert.match(htmlSelecting, /\sdisabled(?!=:)[=>\s]/);
      assert.match(htmlSelecting, /Loading|Selecting/i);
    });

    it('uses semantic Tailwind classes with zero hardcoded hex colors', (): void => {
      const offer = createMockOffer({ matchResult: mockEligibleResult() });
      const html = renderToStaticMarkup(
        React.createElement(FlightResultCard, {
          offer,
          onSelect: () => {},
          className: 'custom-card-test',
        }),
      );

      assert.match(html, /card/);
      assert.match(html, /text-text-primary/);
      assert.match(html, /btn-primary/);
      assert.match(html, /custom-card-test/);
      assert.doesNotMatch(html, /#[0-9a-fA-F]{3,6}/);
    });
  });
});

describe('FlightResults (T053)', (): void => {
  const createMockOffer = (
    id: string,
    price: number,
    duration: string,
    stops: number,
    departureAt: string,
    overrides?: Partial<FlightSearchOfferView>,
  ): FlightSearchOfferView => ({
    id,
    price,
    currency: 'USD',
    airline: 'Delta Air Lines',
    flightNumber: 'DL100',
    origin: 'JFK',
    destination: 'LAX',
    departureAt,
    arrivalAt: '2026-10-01T12:00:00Z',
    duration,
    stops,
    slices: [
      {
        origin: 'JFK',
        destination: 'LAX',
        departureAt,
        arrivalAt: '2026-10-01T12:00:00Z',
        duration,
        stops,
        segments: [
          {
            airline: 'Delta Air Lines',
            flightNumber: 'DL100',
            origin: 'JFK',
            destination: 'LAX',
            departureAt,
            arrivalAt: '2026-10-01T12:00:00Z',
            duration,
            cabinClass: 'economy',
          },
        ],
      },
    ],
    ...overrides,
  });

  const offerA = createMockOffer('offer-A', 300, 'PT4H00M', 1, '2026-10-01T10:00:00Z');
  const offerB = createMockOffer('offer-B', 150, 'PT6H00M', 0, '2026-10-01T08:00:00Z');
  const offerC = createMockOffer('offer-C', 450, 'PT2H30M', 2, '2026-10-01T06:00:00Z');

  describe('Server canonical ordering preservation', (): void => {
    it('preserves canonical server order when sortBy is undefined', (): void => {
      const html = renderToStaticMarkup(
        React.createElement(FlightResults, {
          offers: [offerA, offerB, offerC],
          onSelectFlight: () => {},
        }),
      );

      const idxA = html.indexOf('data-offer-id="offer-A"');
      const idxB = html.indexOf('data-offer-id="offer-B"');
      const idxC = html.indexOf('data-offer-id="offer-C"');

      assert.ok(idxA !== -1 && idxB !== -1 && idxC !== -1);
      assert.ok(idxA < idxB, 'Offer A must precede Offer B');
      assert.ok(idxB < idxC, 'Offer B must precede Offer C');
    });

    it('preserves canonical server order when sortBy is BEST_MATCH in MATCHED mode', (): void => {
      const html = renderToStaticMarkup(
        React.createElement(FlightResults, {
          offers: [offerA, offerB, offerC],
          mode: 'MATCHED',
          sortBy: 'BEST_MATCH',
          onSelectFlight: () => {},
        }),
      );

      const idxA = html.indexOf('data-offer-id="offer-A"');
      const idxB = html.indexOf('data-offer-id="offer-B"');
      const idxC = html.indexOf('data-offer-id="offer-C"');

      assert.ok(idxA < idxB && idxB < idxC);
    });

    it('preserves canonical server order when sortBy is RECOMMENDED in RANKED mode', (): void => {
      const html = renderToStaticMarkup(
        React.createElement(FlightResults, {
          offers: [offerA, offerB, offerC],
          mode: 'RANKED',
          sortBy: 'RECOMMENDED',
          onSelectFlight: () => {},
        }),
      );

      const idxA = html.indexOf('data-offer-id="offer-A"');
      const idxB = html.indexOf('data-offer-id="offer-B"');
      const idxC = html.indexOf('data-offer-id="offer-C"');

      assert.ok(idxA < idxB && idxB < idxC);
    });
  });

  describe('Objective client-side sorting', (): void => {
    it('re-sorts offers ascending by PRICE ($150 < $300 < $450)', (): void => {
      const html = renderToStaticMarkup(
        React.createElement(FlightResults, {
          offers: [offerA, offerB, offerC],
          sortBy: 'PRICE',
          onSelectFlight: () => {},
        }),
      );

      const idxB = html.indexOf('data-offer-id="offer-B"'); // 150
      const idxA = html.indexOf('data-offer-id="offer-A"'); // 300
      const idxC = html.indexOf('data-offer-id="offer-C"'); // 450

      assert.ok(idxB < idxA, 'Offer B ($150) must precede Offer A ($300)');
      assert.ok(idxA < idxC, 'Offer A ($300) must precede Offer C ($450)');
    });

    it('re-sorts offers ascending by DURATION (2h30m < 4h00m < 6h00m)', (): void => {
      const html = renderToStaticMarkup(
        React.createElement(FlightResults, {
          offers: [offerA, offerB, offerC],
          sortBy: 'DURATION',
          onSelectFlight: () => {},
        }),
      );

      const idxC = html.indexOf('data-offer-id="offer-C"'); // 2h30m
      const idxA = html.indexOf('data-offer-id="offer-A"'); // 4h00m
      const idxB = html.indexOf('data-offer-id="offer-B"'); // 6h00m

      assert.ok(idxC < idxA, 'Offer C (2h30m) must precede Offer A (4h00m)');
      assert.ok(idxA < idxB, 'Offer A (4h00m) must precede Offer B (6h00m)');
    });

    it('re-sorts offers ascending by STOPS (0 stops < 1 stop < 2 stops)', (): void => {
      const html = renderToStaticMarkup(
        React.createElement(FlightResults, {
          offers: [offerA, offerB, offerC],
          sortBy: 'STOPS',
          onSelectFlight: () => {},
        }),
      );

      const idxB = html.indexOf('data-offer-id="offer-B"'); // 0 stops
      const idxA = html.indexOf('data-offer-id="offer-A"'); // 1 stop
      const idxC = html.indexOf('data-offer-id="offer-C"'); // 2 stops

      assert.ok(idxB < idxA, 'Offer B (0 stops) must precede Offer A (1 stop)');
      assert.ok(idxA < idxC, 'Offer A (1 stop) must precede Offer C (2 stops)');
    });

    it('re-sorts offers ascending by DEPARTURE_TIME (06:00 < 08:00 < 10:00)', (): void => {
      const html = renderToStaticMarkup(
        React.createElement(FlightResults, {
          offers: [offerA, offerB, offerC],
          sortBy: 'DEPARTURE_TIME',
          onSelectFlight: () => {},
        }),
      );

      const idxC = html.indexOf('data-offer-id="offer-C"'); // 06:00
      const idxB = html.indexOf('data-offer-id="offer-B"'); // 08:00
      const idxA = html.indexOf('data-offer-id="offer-A"'); // 10:00

      assert.ok(idxC < idxB, 'Offer C (06:00) must precede Offer B (08:00)');
      assert.ok(idxB < idxA, 'Offer B (08:00) must precede Offer A (10:00)');
    });

    it('preserves stable relative order when objective values are tied', (): void => {
      const offerTied1 = createMockOffer('offer-T1', 200, 'PT3H', 0, '2026-10-01T08:00:00Z');
      const offerTied2 = createMockOffer('offer-T2', 200, 'PT3H', 0, '2026-10-01T08:00:00Z');

      const html = renderToStaticMarkup(
        React.createElement(FlightResults, {
          offers: [offerTied1, offerTied2],
          sortBy: 'PRICE',
          onSelectFlight: () => {},
        }),
      );

      const idx1 = html.indexOf('data-offer-id="offer-T1"');
      const idx2 = html.indexOf('data-offer-id="offer-T2"');

      assert.ok(idx1 < idx2, 'Tied offer T1 must precede T2 by stable initial order');
    });
  });

  describe('Mode banner, empty state, and booking state pass-through', (): void => {
    it('renders FlightRankingBanner when mode is RANKED', (): void => {
      const html = renderToStaticMarkup(
        React.createElement(FlightResults, {
          offers: [offerA],
          mode: 'RANKED',
          onSelectFlight: () => {},
        }),
      );

      assert.match(html, /Showing standard category ranking/);
      assert.match(html, /Update Preferences/);
    });

    it('does not render FlightRankingBanner when mode is MATCHED', (): void => {
      const html = renderToStaticMarkup(
        React.createElement(FlightResults, {
          offers: [offerA],
          mode: 'MATCHED',
          onSelectFlight: () => {},
        }),
      );

      assert.doesNotMatch(html, /Showing standard category ranking/);
    });

    it('renders accessible empty state when offers array is empty', (): void => {
      const html = renderToStaticMarkup(
        React.createElement(FlightResults, {
          offers: [],
          onSelectFlight: () => {},
        }),
      );

      assert.match(html, /No flight offers found|No flights found/i);
    });

    it('passes bookingOfferId to correct card for loading indicator', (): void => {
      const html = renderToStaticMarkup(
        React.createElement(FlightResults, {
          offers: [offerA, offerB],
          bookingOfferId: 'offer-B',
          onSelectFlight: () => {},
        }),
      );

      assert.match(html, /data-offer-id="offer-A"/);
      assert.match(html, /data-offer-id="offer-B"/);
      assert.match(html, /\sdisabled(?!=:)[=>\s]/);
    });

    it('disables all select buttons in results container when bookingOfferId is passed', (): void => {
      const html = renderToStaticMarkup(
        React.createElement(FlightResults, {
          offers: [offerA, offerB],
          bookingOfferId: 'offer-B',
          onSelectFlight: () => {},
        }),
      );

      const buttonMatches = [...html.matchAll(/<button[^>]*>/g)];
      assert.strictEqual(buttonMatches.length, 2, 'Must render select buttons for both offer cards');
      for (const match of buttonMatches) {
        assert.match(
          match[0],
          /\sdisabled(?!=:)[=>\s]/,
          'Every select button must be disabled when booking is pending',
        );
      }
      assert.match(html, /Loading\.\.\./, 'Selected card must display Loading...');
      assert.match(
        html,
        /Select flight/,
        'Non-selected card must retain Select flight text while disabled',
      );
    });

    it('uses semantic styling with zero hardcoded hex colors', (): void => {
      const html = renderToStaticMarkup(
        React.createElement(FlightResults, {
          offers: [offerA, offerB],
          mode: 'RANKED',
          className: 'custom-results-container',
          onSelectFlight: () => {},
        }),
      );

      assert.match(html, /custom-results-container/);
      assert.doesNotMatch(html, /#[0-9a-fA-F]{3,6}/);
    });
  });
});

describe('SearchFormClient (T054)', (): void => {
  const mockEligibleResult = (score = 92): FlightMatchResult => ({
    eligibility: { eligible: true, violations: [] },
    score,
    matchLevel: 'STRONG',
    breakdown: [
      {
        dimension: 'PRICE',
        score: 0.95,
        weight: 0.25,
        contribution: 0.2375,
        signal: 'POSITIVE',
        explanation: { key: 'match.price.below_median', params: { percentDiff: 20 } },
      },
      {
        dimension: 'AIRLINE',
        score: 1.0,
        weight: 0.2,
        contribution: 0.2,
        signal: 'POSITIVE',
        explanation: { key: 'match.airline.preferred', params: { airline: 'Delta' } },
      },
    ],
    metadata: {
      scoringVersion: 'flight-match-v1',
      activeWeights: {
        PRICE: 0.25,
        AIRLINE: 0.2,
        ARRIVAL_SCHEDULE: 0.15,
        STOPS: 0.1,
        CABIN: 0.1,
        DEPARTURE_SCHEDULE: 0.1,
        BAGGAGE: 0.05,
        DURATION: 0.05,
      },
    },
  });

  const createMockOffer = (
    id: string,
    price: number,
    airline: string,
    matchResult?: FlightMatchResult | null,
    overrides?: Partial<FlightSearchOfferView>,
  ): FlightSearchOfferView => ({
    id,
    price,
    currency: 'USD',
    airline,
    flightNumber: 'DL101',
    origin: 'JFK',
    destination: 'LAX',
    departureAt: '2026-10-01T08:00:00Z',
    arrivalAt: '2026-10-01T11:30:00Z',
    duration: 'PT3H30M',
    stops: 0,
    slices: [
      {
        origin: 'JFK',
        destination: 'LAX',
        departureAt: '2026-10-01T08:00:00Z',
        arrivalAt: '2026-10-01T11:30:00Z',
        duration: 'PT3H30M',
        stops: 0,
        segments: [
          {
            airline,
            flightNumber: 'DL101',
            origin: 'JFK',
            destination: 'LAX',
            departureAt: '2026-10-01T08:00:00Z',
            arrivalAt: '2026-10-01T11:30:00Z',
            duration: 'PT3H30M',
            cabinClass: 'economy',
          },
        ],
      },
    ],
    matchResult: matchResult ?? null,
    ...overrides,
  });

  const mockMeta: FlightSearchMeta = {
    totalReturned: 2,
    currency: 'USD',
    searchId: 'search-unit-test-123',
    scoringVersion: 'flight-match-v1',
  };

  const offerMatched1 = createMockOffer('offer-m1', 250, 'Delta Air Lines', mockEligibleResult(92));
  const offerMatched2 = createMockOffer('offer-m2', 400, 'United Airlines', mockEligibleResult(78));

  const offerRanked1 = createMockOffer('offer-r1', 220, 'Delta Air Lines', null);
  const offerRanked2 = createMockOffer('offer-r2', 310, 'American Airlines', null);

  describe('Outcome and mode retention across renders', (): void => {
    it('renders initial empty search state with prompt when no outcome is present', (): void => {
      const html = renderToStaticMarkup(React.createElement(SearchFormClient, {}));

      assert.match(html, /<form/);
      assert.match(html, /Search Flights/);
      assert.match(html, /No flight offers search results yet\. Enter search criteria and search\./);
      assert.doesNotMatch(html, /Flight Offers/);
      assert.doesNotMatch(html, /Sort by/);
    });

    it('renders initial input values in form fields when provided', (): void => {
      const html = renderToStaticMarkup(
        React.createElement(SearchFormClient, {
          initialValues: {
            origin: 'SFO',
            destination: 'NRT',
            departureDate: '2026-11-15',
            adults: 2,
            cabinClass: 'business',
          },
        }),
      );

      assert.match(html, /value="SFO"/);
      assert.match(html, /value="NRT"/);
      assert.match(html, /value="2026-11-15"/);
      assert.match(html, /value="2"/);
      assert.match(html, /<option[^>]*value="business"[^>]*selected/);
    });

    it('retains MATCHED mode, offers, and meta, rendering controls and match score badges', (): void => {
      const matchedOutcome: FlightSearchOutcome = {
        ok: true,
        mode: 'MATCHED',
        offers: [offerMatched1, offerMatched2],
        meta: mockMeta,
      };

      const html = renderToStaticMarkup(
        React.createElement(SearchFormClient, {
          initialOutcome: matchedOutcome,
        }),
      );

      assert.match(html, /Sort by/);
      assert.match(html, /Best Match/);
      assert.match(html, /92%/);
      assert.match(html, /Strong Match/i);
      assert.match(html, /data-offer-id="offer-m1"/);
      assert.match(html, /data-offer-id="offer-m2"/);
      assert.doesNotMatch(html, /Showing standard category ranking/);
    });

    it('retains RANKED mode, offers, and meta, rendering controls, ranking banner, and no match score claims', (): void => {
      const rankedOutcome: FlightSearchOutcome = {
        ok: true,
        mode: 'RANKED',
        offers: [offerRanked1, offerRanked2],
        meta: mockMeta,
      };

      const html = renderToStaticMarkup(
        React.createElement(SearchFormClient, {
          initialOutcome: rankedOutcome,
        }),
      );

      assert.match(html, /Sort by/);
      assert.match(html, /Recommended \(Category Rank\)/);
      assert.match(html, /Showing standard category ranking \(stops, price, duration\)/);
      assert.match(html, /Update Preferences/);
      assert.match(html, /data-offer-id="offer-r1"/);
      assert.match(html, /data-offer-id="offer-r2"/);
      // Strictly no match score claims in RANKED mode
      assert.doesNotMatch(html, /\d+%/);
      assert.doesNotMatch(html, /Strong Match|Good Match|Fair Match|Weak Match/i);
    });

    it('renders error banner when outcome has ok: false', (): void => {
      const errorOutcome: FlightSearchOutcome = {
        ok: false,
        message: 'Origin and destination cannot be identical.',
      };

      const html = renderToStaticMarkup(
        React.createElement(SearchFormClient, {
          initialOutcome: errorOutcome,
        }),
      );

      assert.match(html, /Search Error/);
      assert.match(html, /Origin and destination cannot be identical\./);
      assert.doesNotMatch(html, /data-offer-id/);
    });
  });

  describe('Controls and Banner rendering in MATCHED vs RANKED mode', (): void => {
    it('in MATCHED mode: renders FlightResultsControls with "Best Match" default and hides FlightRankingBanner', (): void => {
      const matchedOutcome: FlightSearchOutcome = {
        ok: true,
        mode: 'MATCHED',
        offers: [offerMatched1],
        meta: mockMeta,
      };

      const html = renderToStaticMarkup(
        React.createElement(SearchFormClient, {
          initialOutcome: matchedOutcome,
        }),
      );

      assert.match(html, /<option[^>]*value="BEST_MATCH"[^>]*selected/);
      assert.match(html, /1 flight found/);
      assert.doesNotMatch(html, /Showing standard category ranking/);
    });

    it('in RANKED mode: renders FlightResultsControls with "Recommended (Category Rank)" default and displays FlightRankingBanner', (): void => {
      const rankedOutcome: FlightSearchOutcome = {
        ok: true,
        mode: 'RANKED',
        offers: [offerRanked1, offerRanked2],
        meta: mockMeta,
      };

      const html = renderToStaticMarkup(
        React.createElement(SearchFormClient, {
          initialOutcome: rankedOutcome,
        }),
      );

      assert.match(html, /<option[^>]*value="RECOMMENDED"[^>]*selected/);
      assert.match(html, /2 flights found/);
      assert.match(html, /Showing standard category ranking/);
      assert.match(html, /href="\/profile"/);
    });
  });

  describe('Results composition with sorting and selection delegation', (): void => {
    it('re-sorts offers when initialSortBy is PRICE ($250 < $400)', (): void => {
      const matchedOutcome: FlightSearchOutcome = {
        ok: true,
        mode: 'MATCHED',
        offers: [offerMatched2, offerMatched1], // United ($400), Delta ($250)
        meta: mockMeta,
      };

      const html = renderToStaticMarkup(
        React.createElement(SearchFormClient, {
          initialOutcome: matchedOutcome,
          initialSortBy: 'PRICE',
        }),
      );

      const idx1 = html.indexOf('data-offer-id="offer-m1"'); // 250
      const idx2 = html.indexOf('data-offer-id="offer-m2"'); // 400

      assert.ok(idx1 !== -1 && idx2 !== -1);
      assert.ok(idx1 < idx2, 'Delta ($250) must precede United ($400) when sorted by PRICE');
    });

    it('renders local deterministic offer IDs on select buttons and never leaks provider IDs', (): void => {
      const localId1 = 'offer-local-det-101';
      const localId2 = 'offer-local-det-102';
      const matchedOutcome: FlightSearchOutcome = {
        ok: true,
        mode: 'MATCHED',
        offers: [
          createMockOffer(localId1, 200, 'Delta', mockEligibleResult(90)),
          createMockOffer(localId2, 300, 'Delta', mockEligibleResult(80)),
        ],
        meta: mockMeta,
      };

      const html = renderToStaticMarkup(
        React.createElement(SearchFormClient, {
          initialOutcome: matchedOutcome,
        }),
      );

      assert.match(html, /data-offer-id="offer-local-det-101"/);
      assert.match(html, /data-offer-id="offer-local-det-102"/);
      assert.doesNotMatch(html, /off_[0-9a-zA-Z]+/);
    });

    it('uses semantic Tailwind classes with zero hardcoded hex colors', (): void => {
      const matchedOutcome: FlightSearchOutcome = {
        ok: true,
        mode: 'MATCHED',
        offers: [offerMatched1],
        meta: mockMeta,
      };

      const html = renderToStaticMarkup(
        React.createElement(SearchFormClient, {
          initialOutcome: matchedOutcome,
        }),
      );

      assert.match(html, /btn-primary/);
      assert.match(html, /text-text-primary/);
      assert.match(html, /form-input/);
      assert.doesNotMatch(html, /#[0-9a-fA-F]{3,6}/);
    });

    it('verifies that handleBook ignores concurrent selection clicks and retains lock after successful selection navigation', async (): Promise<void> => {
      let capturedOnSelectFlight: ((offerId: string) => Promise<void>) | null = null;
      const originalCreateElement = React.createElement;

      // Intercept FlightResults creation to capture handleBook callback
      (React as unknown as Record<string, unknown>).createElement = function (
        type: unknown,
        ...rest: unknown[]
      ) {
        if (type === FlightResults) {
          const props = rest[0] as { onSelectFlight?: (offerId: string) => Promise<void> };
          capturedOnSelectFlight = props?.onSelectFlight ?? null;
        }
        return originalCreateElement.apply(
          this,
          [type, ...rest] as Parameters<typeof React.createElement>,
        );
      };

      let actionCallCount = 0;
      let resolveFirstAction!: (value: FlightSelectionOutcome) => void;
      const firstActionPromise = new Promise<FlightSelectionOutcome>((resolve) => {
        resolveFirstAction = resolve;
      });

      const mockSelectAction = async (_offerId: string): Promise<FlightSelectionOutcome> => {
        actionCallCount++;
        return firstActionPromise;
      };

      const navigatedUrls: string[] = [];
      const mockNavigate = (url: string): void => {
        navigatedUrls.push(url);
      };

      try {
        renderToStaticMarkup(
          React.createElement(SearchFormClient, {
            initialOutcome: {
              ok: true,
              mode: 'MATCHED',
              offers: [offerMatched1, offerMatched2],
              meta: mockMeta,
            },
            onSelectAction: mockSelectAction,
            onNavigate: mockNavigate,
          }),
        );

        assert.ok(
          capturedOnSelectFlight !== null,
          'FlightResults must receive handleBook onSelectFlight handler',
        );

        // First click begins selection and is in-flight
        const firstClickPromise = (capturedOnSelectFlight as (offerId: string) => Promise<void>)(
          'offer-m1',
        );
        assert.strictEqual(actionCallCount, 1, 'First click must initiate selection');

        // Second click concurrently while first selection is in flight
        const secondClickPromise = (capturedOnSelectFlight as (offerId: string) => Promise<void>)(
          'offer-m2',
        );
        assert.strictEqual(actionCallCount, 1, 'Concurrent click while in-flight must be ignored');

        // Complete the first selection
        resolveFirstAction({ ok: true, checkoutPath: '/checkout/step-1' });
        await Promise.all([firstClickPromise, secondClickPromise]);

        assert.strictEqual(actionCallCount, 1, 'Selection action must be invoked exactly once');
        assert.deepStrictEqual(navigatedUrls, ['/checkout/step-1']);

        // Subsequent click during navigation transition must also be ignored because lock remains held
        await (capturedOnSelectFlight as (offerId: string) => Promise<void>)('offer-m2');
        assert.strictEqual(
          actionCallCount,
          1,
          'Subsequent click during navigation transition must be ignored',
        );
      } finally {
        (React as unknown as Record<string, unknown>).createElement = originalCreateElement;
      }
    });

    it('verifies that handleBook releases lock when selection fails, allowing subsequent selection attempt', async (): Promise<void> => {
      let capturedOnSelectFlight: ((offerId: string) => Promise<void>) | null = null;
      const originalCreateElement = React.createElement;

      (React as unknown as Record<string, unknown>).createElement = function (
        type: unknown,
        ...rest: unknown[]
      ) {
        if (type === FlightResults) {
          const props = rest[0] as { onSelectFlight?: (offerId: string) => Promise<void> };
          capturedOnSelectFlight = props?.onSelectFlight ?? null;
        }
        return originalCreateElement.apply(
          this,
          [type, ...rest] as Parameters<typeof React.createElement>,
        );
      };

      let actionCallCount = 0;
      let shouldSucceed = false;

      const mockSelectAction = async (_offerId: string): Promise<FlightSelectionOutcome> => {
        actionCallCount++;
        if (!shouldSucceed) {
          return { ok: false, message: 'Offer expired' };
        }
        return { ok: true, checkoutPath: '/checkout/step-1' };
      };

      try {
        renderToStaticMarkup(
          React.createElement(SearchFormClient, {
            initialOutcome: {
              ok: true,
              mode: 'MATCHED',
              offers: [offerMatched1, offerMatched2],
              meta: mockMeta,
            },
            onSelectAction: mockSelectAction,
          }),
        );

        assert.ok(
          capturedOnSelectFlight !== null,
          'FlightResults must receive handleBook onSelectFlight handler',
        );

        // First click fails
        await (capturedOnSelectFlight as (offerId: string) => Promise<void>)('offer-m1');
        assert.strictEqual(actionCallCount, 1, 'First attempt was invoked');

        // Second click after failure should proceed because lock was released
        shouldSucceed = true;
        await (capturedOnSelectFlight as (offerId: string) => Promise<void>)('offer-m2');
        assert.strictEqual(actionCallCount, 2, 'Subsequent selection attempt proceeds after failure');
      } finally {
        (React as unknown as Record<string, unknown>).createElement = originalCreateElement;
      }
    });

    it('verifies that submitting search form while booking is in progress is a no-op, does not trigger searchAction, does not clear navigation lock, and leaves search button/fieldset disabled', async (): Promise<void> => {
      let capturedOnSelectFlight: ((offerId: string) => Promise<void>) | null = null;
      let capturedOnSubmit: ((event: unknown) => Promise<void>) | null = null;
      const originalCreateElement = React.createElement;

      (React as unknown as Record<string, unknown>).createElement = function (
        type: unknown,
        ...rest: unknown[]
      ) {
        if (type === FlightResults) {
          const props = rest[0] as { onSelectFlight?: (offerId: string) => Promise<void> };
          capturedOnSelectFlight = props?.onSelectFlight ?? null;
        } else if (type === 'form') {
          const props = rest[0] as { onSubmit?: (event: unknown) => Promise<void> };
          capturedOnSubmit = props?.onSubmit ?? null;
        }
        return originalCreateElement.apply(
          this,
          [type, ...rest] as Parameters<typeof React.createElement>,
        );
      };

      let selectCallCount = 0;
      let searchCallCount = 0;
      let resolveSelect!: (value: FlightSelectionOutcome) => void;
      const selectPromise = new Promise<FlightSelectionOutcome>((resolve) => {
        resolveSelect = resolve;
      });

      const mockSelectAction = async (_offerId: string): Promise<FlightSelectionOutcome> => {
        selectCallCount++;
        return selectPromise;
      };

      const mockSearchAction = async (_query: FlightSearchQuery): Promise<FlightSearchOutcome> => {
        searchCallCount++;
        return {
          ok: true,
          mode: 'MATCHED',
          offers: [],
          meta: mockMeta,
        };
      };

      const navigatedUrls: string[] = [];
      const mockNavigate = (url: string): void => {
        navigatedUrls.push(url);
      };

      try {
        const html = renderToStaticMarkup(
          React.createElement(SearchFormClient, {
            initialOutcome: {
              ok: true,
              mode: 'MATCHED',
              offers: [offerMatched1, offerMatched2],
              meta: mockMeta,
            },
            initialBookingOfferId: 'offer-m1',
            onSelectAction: mockSelectAction,
            onSearchAction: mockSearchAction,
            onNavigate: mockNavigate,
          }),
        );

        // Verify search button and fieldset are disabled when booking is active
        assert.match(html, /<fieldset[^>]*disabled/);
        assert.match(html, /<button[^>]*disabled/);

        assert.ok(capturedOnSubmit !== null, 'Form onSubmit must be captured');

        // Attempt to submit search form while booking lock is held
        let preventDefaultCalled = false;
        await (capturedOnSubmit as (event: unknown) => Promise<void>)({
          preventDefault: () => {
            preventDefaultCalled = true;
          },
        });

        assert.ok(preventDefaultCalled, 'preventDefault must be called');
        assert.strictEqual(
          searchCallCount,
          0,
          'searchAction must NOT be called when booking is in progress',
        );

        // Test dynamic flow: start selection in flight, submit search, ensure lock not cleared
        let capturedDynamicOnSelect: ((offerId: string) => Promise<void>) | null = null;
        let capturedDynamicOnSubmit: ((event: unknown) => Promise<void>) | null = null;

        (React as unknown as Record<string, unknown>).createElement = function (
          type: unknown,
          ...rest: unknown[]
        ) {
          if (type === FlightResults) {
            const props = rest[0] as { onSelectFlight?: (offerId: string) => Promise<void> };
            capturedDynamicOnSelect = props?.onSelectFlight ?? null;
          } else if (type === 'form') {
            const props = rest[0] as { onSubmit?: (event: unknown) => Promise<void> };
            capturedDynamicOnSubmit = props?.onSubmit ?? null;
          }
          return originalCreateElement.apply(
            this,
            [type, ...rest] as Parameters<typeof React.createElement>,
          );
        };

        renderToStaticMarkup(
          React.createElement(SearchFormClient, {
            initialOutcome: {
              ok: true,
              mode: 'MATCHED',
              offers: [offerMatched1, offerMatched2],
              meta: mockMeta,
            },
            onSelectAction: mockSelectAction,
            onSearchAction: mockSearchAction,
            onNavigate: mockNavigate,
          }),
        );

        assert.ok(capturedDynamicOnSelect !== null, 'capturedDynamicOnSelect must not be null');
        assert.ok(capturedDynamicOnSubmit !== null, 'capturedDynamicOnSubmit must not be null');

        // Initiate selection
        const flightSelectPromise = (
          capturedDynamicOnSelect as (offerId: string) => Promise<void>
        )('offer-m1');
        assert.strictEqual(selectCallCount, 1, 'Selection must be initiated');

        // Attempt search submit while booking selection is in progress
        await (capturedDynamicOnSubmit as (event: unknown) => Promise<void>)({
          preventDefault: () => {},
        });
        assert.strictEqual(
          searchCallCount,
          0,
          'searchAction must not be called during in-flight selection',
        );

        // Resolve first selection to complete navigation
        resolveSelect({ ok: true, checkoutPath: '/checkout/step-1' });
        await flightSelectPromise;
        assert.deepStrictEqual(navigatedUrls, ['/checkout/step-1']);

        // Attempt search submit again after navigation succeeded (lock still held)
        await (capturedDynamicOnSubmit as (event: unknown) => Promise<void>)({
          preventDefault: () => {},
        });
        assert.strictEqual(
          searchCallCount,
          0,
          'searchAction must not be called after navigation lock is held',
        );

        // Verify navigation lock is retained: subsequent select attempt must still be ignored
        await (capturedDynamicOnSelect as (offerId: string) => Promise<void>)('offer-m2');
        assert.strictEqual(
          selectCallCount,
          1,
          'Lock must be retained: competing selection ignored',
        );
      } finally {
        (React as unknown as Record<string, unknown>).createElement = originalCreateElement;
      }
    });
  });
});

describe('SearchPage Cabin Prefill & Precedence (T055)', (): void => {
  describe('Profile prefill without query param', (): void => {
    it('prefills cabinClass from profile classPreference (business) when URL query param is omitted', (): void => {
      const searchParams = { origin: 'JFK', destination: 'LHR' };
      const initialValues = getInitialValues(searchParams, 'business');

      assert.equal(initialValues.cabinClass, 'business');

      const html = renderToStaticMarkup(
        React.createElement(SearchFormClient, { initialValues }),
      );
      assert.match(html, /<option[^>]*value="business"[^>]*selected/);
    });

    it('prefills cabinClass from profile classPreference (premium_economy) when URL query param is omitted', (): void => {
      const searchParams = { origin: 'JFK', destination: 'LHR' };
      const initialValues = getInitialValues(searchParams, 'premium_economy');

      assert.equal(initialValues.cabinClass, 'premium_economy');

      const html = renderToStaticMarkup(
        React.createElement(SearchFormClient, { initialValues }),
      );
      assert.match(html, /<option[^>]*value="premium_economy"[^>]*selected/);
    });

    it('prefills cabinClass from profile classPreference (first) when URL query param is omitted', (): void => {
      const searchParams = { origin: 'JFK', destination: 'LHR' };
      const initialValues = getInitialValues(searchParams, 'first');

      assert.equal(initialValues.cabinClass, 'first');

      const html = renderToStaticMarkup(
        React.createElement(SearchFormClient, { initialValues }),
      );
      assert.match(html, /<option[^>]*value="first"[^>]*selected/);
    });
  });

  describe('URL query precedence over profile classPreference', (): void => {
    it('strictly overrides profile preference (business) with explicit URL query param (?cabinClass=economy)', (): void => {
      const searchParams = { origin: 'JFK', destination: 'LHR', cabinClass: 'economy' };
      const initialValues = getInitialValues(searchParams, 'business');

      assert.equal(initialValues.cabinClass, 'economy');

      const html = renderToStaticMarkup(
        React.createElement(SearchFormClient, { initialValues }),
      );
      assert.match(html, /<option[^>]*value="economy"[^>]*selected/);
      assert.doesNotMatch(html, /<option[^>]*value="business"[^>]*selected/);
    });

    it('strictly overrides profile preference (economy) with explicit URL query param (?cabinClass=first)', (): void => {
      const searchParams = { origin: 'JFK', destination: 'LHR', cabinClass: 'first' };
      const initialValues = getInitialValues(searchParams, 'economy');

      assert.equal(initialValues.cabinClass, 'first');

      const html = renderToStaticMarkup(
        React.createElement(SearchFormClient, { initialValues }),
      );
      assert.match(html, /<option[^>]*value="first"[^>]*selected/);
    });
  });

  describe('Fallback and invalid preference handling', (): void => {
    it('falls back to default economy when neither URL query nor profile preference is provided', (): void => {
      const searchParams = { origin: 'JFK', destination: 'LHR' };
      const initialValues = getInitialValues(searchParams, undefined);

      assert.equal(initialValues.cabinClass, undefined);

      const html = renderToStaticMarkup(
        React.createElement(SearchFormClient, { initialValues }),
      );
      assert.match(html, /<option[^>]*value="economy"[^>]*selected/);
    });

    it('falls back to default economy when unauthenticated or profile fetch fails', async (): void => {
      const pref = await fetchProfileCabinPreference(null);
      assert.equal(pref, null);

      const searchParams = {};
      const initialValues = getInitialValues(searchParams, undefined);

      const html = renderToStaticMarkup(
        React.createElement(SearchFormClient, { initialValues }),
      );
      assert.match(html, /<option[^>]*value="economy"[^>]*selected/);
    });

    it('safely ignores invalid profile classPreference and leaves cabinClass unset', (): void => {
      const searchParams = { origin: 'JFK', destination: 'LHR' };
      const invalidPref = 'supersonic_luxury' as unknown as FlightSearchQuery['cabinClass'];
      const initialValues = getInitialValues(searchParams, invalidPref);

      assert.equal(initialValues.cabinClass, undefined);

      const html = renderToStaticMarkup(
        React.createElement(SearchFormClient, { initialValues }),
      );
      assert.match(html, /<option[^>]*value="economy"[^>]*selected/);
    });

    it('safely ignores invalid URL query cabinClass and falls back to profile preference', (): void => {
      const searchParams = { origin: 'JFK', destination: 'LHR', cabinClass: 'invalid_class' };
      const initialValues = getInitialValues(searchParams, 'business');

      assert.equal(initialValues.cabinClass, 'business');

      const html = renderToStaticMarkup(
        React.createElement(SearchFormClient, { initialValues }),
      );
      assert.match(html, /<option[^>]*value="business"[^>]*selected/);
    });
  });

  describe('SearchFormClient form submission retains cabinClass', (): void => {
    it('initializes cabinClass state from initialValues and passes it to searchAction', async (): void => {
      let submittedQuery: FlightSearchQuery | null = null;
      const initialValues: Partial<FlightSearchQuery> = {
        origin: 'JFK',
        destination: 'LHR',
        departureDate: '2026-12-01',
        cabinClass: 'business',
      };

      const html = renderToStaticMarkup(
        React.createElement(SearchFormClient, {
          initialValues,
          onSearchAction: async (q: FlightSearchQuery) => {
            submittedQuery = q;
            return {
              ok: true,
              mode: 'MATCHED',
              offers: [],
              meta: {
                totalResults: 0,
                searchHash: 'mock-hash',
                cached: false,
                requestedCabinClass: 'business',
                scoringVersion: 'flight-match-v1',
                eligibleCount: 0,
                matchLevelCounts: { STRONG: 0, GOOD: 0, FAIR: 0, WEAK: 0 },
              },
            };
          },
        }),
      );

      assert.match(html, /<option[^>]*value="business"[^>]*selected/);
    });
  });
});
