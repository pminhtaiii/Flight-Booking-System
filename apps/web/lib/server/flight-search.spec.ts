import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import type { FlightSearchQuery } from '@shared/types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const testRequire = createRequire(import.meta.url);
type TestSession = { accessToken?: string } | null;

let session: TestSession = null;
const getServerSession = mock.fn(async () => session);
const resolvePath = (specifier: string): string => {
  try {
    return testRequire.resolve(specifier);
  } catch {
    return require.resolve(specifier, {
      paths: [
        path.resolve(__dirname, '../../node_modules'),
        path.resolve(process.cwd(), 'apps/web/node_modules'),
        path.resolve(process.cwd(), 'node_modules'),
      ],
    });
  }
};

const nextAuthPath = resolvePath('next-auth');
const originalNextAuthModule = testRequire.cache[nextAuthPath];
testRequire.cache[nextAuthPath] = {
  exports: { getServerSession, default: { getServerSession } },
} as NodeModule;
const serverOnlyPath = resolvePath('server-only');
const originalServerOnlyModule = testRequire.cache[serverOnlyPath];
testRequire.cache[serverOnlyPath] = { exports: {} } as NodeModule;

after(() => {
  if (originalNextAuthModule) {
    testRequire.cache[nextAuthPath] = originalNextAuthModule;
  } else {
    delete testRequire.cache[nextAuthPath];
  }

  if (originalServerOnlyModule) {
    testRequire.cache[serverOnlyPath] = originalServerOnlyModule;
    return;
  }

  delete testRequire.cache[serverOnlyPath];
});

let searchFlights: typeof import('./flight-search').searchFlights;
let selectFlightOffer: typeof import('./flight-search').selectFlightOffer;

before(async () => {
  ({ searchFlights, selectFlightOffer } = await import('./flight-search.ts'));
});

const validQuery: FlightSearchQuery = {
  origin: 'SFO',
  destination: 'JFK',
  departureDate: '2027-11-15',
  returnDate: null,
  adults: 2,
  children: 1,
  infants: 0,
  cabinClass: 'economy',
};

const upstreamOffer = {
  id: 'local-offer-001',
  duffelOfferId: 'off_provider_secret',
  airline: 'Mock Horizon Air',
  flightNumber: 'HZ789',
  departureAirport: 'SFO',
  arrivalAirport: 'JFK',
  departureTime: '2027-11-15T08:00:00.000Z',
  arrivalTime: '2027-11-15T16:30:00.000Z',
  duration: 510,
  stops: 0,
  price: 285,
  currency: 'USD',
  fareClass: 'Y',
  requestedCabinClass: 'economy',
  cabinClassMatch: 'full',
  cabinMismatchDetails: null,
  baggageAllowance: null,
  segments: [
    {
      carrierCode: 'HZ',
      flightNumber: '789',
      operatingCarrier: 'Mock Horizon Air',
      departureAirport: 'SFO',
      departureTerminal: null,
      departureTime: '2027-11-15T08:00:00.000Z',
      arrivalAirport: 'JFK',
      arrivalTerminal: null,
      arrivalTime: '2027-11-15T16:30:00.000Z',
      duration: 510,
      aircraft: null,
      cabinClass: 'economy',
    },
  ],
  returnSegments: null,
};

describe('flight-search server seam', () => {
  const originalEnvironment = process.env;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env = { ...originalEnvironment, API_URL: 'http://private-api.example/' };
    session = { accessToken: 'session-token' };
    getServerSession.mock.resetCalls();
  });

  afterEach(() => {
    process.env = originalEnvironment;
    globalThis.fetch = originalFetch;
    session = null;
  });

  it('maps an authenticated upstream response to an opaque shared view', async () => {
    let requestedUrl = '';
    let requestedInit: RequestInit | undefined;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      requestedUrl = String(input);
      requestedInit = init;
      return new Response(JSON.stringify({ results: [upstreamOffer], meta: { totalResults: 1 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const outcome = await searchFlights(validQuery);

    assert.deepEqual(outcome, {
      ok: true,
      mode: 'RANKED',
      offers: [
        {
          id: 'local-offer-001',
          price: 285,
          currency: 'USD',
          airline: 'Mock Horizon Air',
          flightNumber: 'HZ789',
          origin: 'SFO',
          destination: 'JFK',
          departureAt: '2027-11-15T08:00:00.000Z',
          arrivalAt: '2027-11-15T16:30:00.000Z',
          duration: 'PT8H30M',
          stops: 0,
          slices: [
            {
              origin: 'SFO',
              destination: 'JFK',
              departureAt: '2027-11-15T08:00:00.000Z',
              arrivalAt: '2027-11-15T16:30:00.000Z',
              duration: 'PT8H30M',
              stops: 0,
              segments: [
                {
                  airline: 'Mock Horizon Air',
                  flightNumber: 'HZ789',
                  origin: 'SFO',
                  destination: 'JFK',
                  departureAt: '2027-11-15T08:00:00.000Z',
                  arrivalAt: '2027-11-15T16:30:00.000Z',
                  duration: 'PT8H30M',
                  cabinClass: 'economy',
                },
              ],
            },
          ],
          matchResult: null,
        },
      ],
      meta: {
        totalCount: 1,
        currency: 'USD',
        minPrice: 285,
        maxPrice: 285,
        airlines: ['Mock Horizon Air'],
      },
    });
    assert.match(requestedUrl, /^http:\/\/private-api\.example\/api\/flights\/search$/);
    assert.strictEqual(requestedInit?.method, 'POST');
    assert.strictEqual(
      (requestedInit?.headers as HeadersInit & { Authorization?: string }).Authorization,
      'Bearer session-token',
    );
    assert.strictEqual(JSON.stringify(outcome).includes('duffelOfferId'), false);
  });

  it('parses legacy untagged responses as mode RANKED with matchResult null', async () => {
    globalThis.fetch = async (): Promise<Response> => {
      return new Response(JSON.stringify({ results: [upstreamOffer], meta: { totalResults: 1 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const outcome = await searchFlights(validQuery);

    assert.strictEqual(outcome.ok, true);
    if (outcome.ok) {
      assert.strictEqual(outcome.mode, 'RANKED');
      assert.strictEqual(outcome.offers.length, 1);
      assert.strictEqual(outcome.offers[0].matchResult, null);
      assert.strictEqual(outcome.meta.scoringVersion, undefined);
      assert.strictEqual(outcome.meta.eligibleCount, undefined);
      assert.strictEqual(outcome.meta.matchLevelCounts, undefined);
      assert.strictEqual(JSON.stringify(outcome).includes('duffelOfferId'), false);
    }
  });

  it('parses MATCHED responses with eligible and ineligible offers and preserves scoring metadata', async () => {
    const matchedOffer = {
      ...upstreamOffer,
      id: 'local-offer-matched-001',
      matchResult: {
        eligibility: {
          eligible: true,
          violations: [],
        },
        score: 88,
        matchLevel: 'STRONG',
        breakdown: [
          {
            dimension: 'PRICE',
            score: 0.9,
            weight: 0.35,
            contribution: 0.315,
            signal: 'POSITIVE',
            explanation: {
              key: 'match.price.below_median',
              params: { difference: '10%' },
            },
          },
        ],
        metadata: {
          scoringVersion: 'flight-match-v1',
          activeWeights: {
            PRICE: 0.35,
            AIRLINE: 0.15,
            ARRIVAL_SCHEDULE: 0.1,
            STOPS: 0.1,
            CABIN: 0.1,
            DEPARTURE_SCHEDULE: 0.1,
            BAGGAGE: 0.05,
            DURATION: 0.05,
          },
        },
      },
    };

    const ineligibleOffer = {
      ...upstreamOffer,
      id: 'local-offer-ineligible-002',
      matchResult: {
        eligibility: {
          eligible: false,
          violations: [
            {
              constraint: 'BLACKLISTED_AIRLINE',
              explanation: {
                key: 'constraint.airline.blacklisted',
                params: { airline: 'Mock Horizon Air' },
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
            PRICE: 0.35,
            AIRLINE: 0.15,
            ARRIVAL_SCHEDULE: 0.1,
            STOPS: 0.1,
            CABIN: 0.1,
            DEPARTURE_SCHEDULE: 0.1,
            BAGGAGE: 0.05,
            DURATION: 0.05,
          },
        },
      },
    };

    globalThis.fetch = async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          mode: 'MATCHED',
          results: [matchedOffer, ineligibleOffer],
          meta: {
            totalResults: 2,
            scoringVersion: 'flight-match-v1',
            eligibleCount: 1,
            matchLevelCounts: {
              STRONG: 1,
              GOOD: 0,
              FAIR: 0,
              WEAK: 0,
            },
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    };

    const outcome = await searchFlights(validQuery);

    assert.strictEqual(outcome.ok, true);
    if (outcome.ok) {
      assert.strictEqual(outcome.mode, 'MATCHED');
      assert.strictEqual(outcome.offers.length, 2);
      assert.deepEqual(outcome.offers[0].matchResult, matchedOffer.matchResult);
      assert.deepEqual(outcome.offers[1].matchResult, ineligibleOffer.matchResult);
      assert.strictEqual(outcome.meta.scoringVersion, 'flight-match-v1');
      assert.strictEqual(outcome.meta.eligibleCount, 1);
      assert.deepEqual(outcome.meta.matchLevelCounts, {
        STRONG: 1,
        GOOD: 0,
        FAIR: 0,
        WEAK: 0,
      });
      assert.strictEqual(JSON.stringify(outcome).includes('duffelOfferId'), false);
    }
  });

  it('parses explicit RANKED responses with matchResult null', async () => {
    const rankedOffer = {
      ...upstreamOffer,
      id: 'local-offer-ranked-001',
      matchResult: null,
    };

    globalThis.fetch = async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          mode: 'RANKED',
          results: [rankedOffer],
          meta: { totalResults: 1 },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    };

    const outcome = await searchFlights(validQuery);

    assert.strictEqual(outcome.ok, true);
    if (outcome.ok) {
      assert.strictEqual(outcome.mode, 'RANKED');
      assert.strictEqual(outcome.offers.length, 1);
      assert.strictEqual(outcome.offers[0].matchResult, null);
      assert.strictEqual(JSON.stringify(outcome).includes('duffelOfferId'), false);
    }
  });

  it('fails gracefully with UPSTREAM_UNAVAILABLE when matchResult is malformed', async () => {
    const malformedOffer = {
      ...upstreamOffer,
      id: 'local-offer-malformed-001',
      matchResult: {
        eligibility: {
          eligible: 'not-a-boolean',
        },
      },
    };

    globalThis.fetch = async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          mode: 'MATCHED',
          results: [malformedOffer],
          meta: { totalResults: 1 },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    };

    const outcome = await searchFlights(validQuery);

    assert.deepEqual(outcome, {
      ok: false,
      reason: 'UPSTREAM_UNAVAILABLE',
      message: 'Flight search returned an invalid response. Please try again.',
      retryable: true,
    });
  });

  it('maps upstream responses containing empty string or zero fallbacks', async () => {
    const fallbackOffer = {
      id: 'local-offer-fallback',
      duffelOfferId: 'off_fallback_123',
      airline: '',
      flightNumber: '',
      departureAirport: '',
      arrivalAirport: '',
      departureTime: '',
      arrivalTime: '',
      duration: 0,
      stops: 0,
      price: 150,
      currency: 'USD',
      fareClass: null,
      baggageAllowance: null,
      requestedCabinClass: 'economy',
      cabinClassMatch: 'full',
      cabinMismatchDetails: null,
      segments: [
        {
          carrierCode: '',
          flightNumber: '',
          operatingCarrier: '',
          departureAirport: '',
          departureTerminal: null,
          departureTime: '',
          arrivalAirport: '',
          arrivalTerminal: null,
          arrivalTime: '',
          duration: 0,
          aircraft: null,
          cabinClass: 'economy',
        },
      ],
      returnSegments: null,
    };

    globalThis.fetch = async (): Promise<Response> => {
      return new Response(JSON.stringify({ results: [fallbackOffer], meta: { totalResults: 1 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const outcome = await searchFlights(validQuery);

    assert.strictEqual(outcome.ok, true);
    if (outcome.ok) {
      assert.strictEqual(outcome.offers.length, 1);
      assert.strictEqual(outcome.offers[0].id, 'local-offer-fallback');
      assert.strictEqual(outcome.offers[0].duration, 'PT0M');
      assert.strictEqual(outcome.offers[0].slices[0].duration, 'PT0M');
      assert.strictEqual(outcome.offers[0].slices[0].segments[0].duration, 'PT0M');
    }
  });

  it('returns an unauthenticated outcome before making an upstream call', async () => {
    session = null;
    let requested = false;
    globalThis.fetch = async (): Promise<Response> => {
      requested = true;
      return new Response();
    };

    const outcome = await searchFlights(validQuery);

    assert.deepEqual(outcome, {
      ok: false,
      reason: 'UNAUTHENTICATED',
      message: 'Please sign in to search for flights.',
      retryable: false,
    });
    assert.strictEqual(requested, false);
  });

  it('fails fast on 503 search response without repeating supplier-backed searches', async () => {
    let attempts = 0;
    globalThis.fetch = async (): Promise<Response> => {
      attempts += 1;
      return new Response('Unavailable', { status: 503 });
    };

    const outcome = await searchFlights(validQuery);

    assert.deepEqual(outcome, {
      ok: false,
      reason: 'UPSTREAM_UNAVAILABLE',
      message: 'Flight search is temporarily unavailable. Please try again.',
      retryable: true,
    });
    assert.strictEqual(attempts, 1);
  });

  it('retries a 503 read failure on offer selection before returning the validated response', async () => {
    let attempts = 0;
    globalThis.fetch = async (): Promise<Response> => {
      attempts += 1;
      if (attempts === 1) return new Response('Unavailable', { status: 503 });
      return new Response(JSON.stringify({ id: 'opaque-offer' }), { status: 200 });
    };

    const outcome = await selectFlightOffer('opaque-offer');

    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(attempts, 2);
  });

  it('normalizes upstream validation responses without retrying them', async () => {
    for (const status of [400, 422]) {
      let attempts = 0;
      globalThis.fetch = async (): Promise<Response> => {
        attempts += 1;
        return new Response(JSON.stringify({ message: 'Provider implementation detail' }), {
          status,
        });
      };

      const outcome = await searchFlights(validQuery);

      assert.deepEqual(outcome, {
        ok: false,
        reason: 'INVALID_SEARCH',
        message: 'Please check your search details and try again.',
        retryable: false,
      });
      assert.strictEqual(attempts, 1);
    }
  });

  it('normalizes a timed-out search request without repeating supplier-backed searches', async () => {
    let attempts = 0;
    globalThis.fetch = async (): Promise<Response> => {
      attempts += 1;
      throw new DOMException('Aborted', 'AbortError');
    };

    const outcome = await searchFlights(validQuery);

    assert.deepEqual(outcome, {
      ok: false,
      reason: 'UPSTREAM_UNAVAILABLE',
      message: 'Flight search is temporarily unavailable. Please try again.',
      retryable: true,
    });
    assert.strictEqual(attempts, 1);
  });

  it('normalizes a timed-out read request after the bounded retry budget', async () => {
    let attempts = 0;
    globalThis.fetch = async (): Promise<Response> => {
      attempts += 1;
      throw new DOMException('Aborted', 'AbortError');
    };

    const outcome = await selectFlightOffer('opaque-offer');

    assert.deepEqual(outcome, {
      ok: false,
      reason: 'OFFER_UNAVAILABLE',
      message: 'This flight offer is unavailable. Please search again.',
      retryable: true,
    });
    assert.strictEqual(attempts, 3);
  });

  it('rejects malformed upstream results instead of forwarding them', async () => {
    globalThis.fetch = async (): Promise<Response> =>
      new Response(JSON.stringify({ results: [{ id: 'local-offer-001' }] }), { status: 200 });

    const outcome = await searchFlights(validQuery);

    assert.deepEqual(outcome, {
      ok: false,
      reason: 'UPSTREAM_UNAVAILABLE',
      message: 'Flight search returned an invalid response. Please try again.',
      retryable: true,
    });
  });

  it('verifies a selected offer and preserves the Slice 5B checkout path contract', async () => {
    let requestedUrl = '';
    globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ id: 'opaque-offer' }), { status: 200 });
    };

    const outcome = await selectFlightOffer('opaque-offer');

    assert.deepEqual(outcome, { ok: true, checkoutPath: '/checkout?offerId=opaque-offer' });
    assert.match(requestedUrl, /\/api\/flights\/opaque-offer$/);
  });
});
