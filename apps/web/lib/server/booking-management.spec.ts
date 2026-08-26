import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';

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
testRequire.cache[nextAuthPath] = { exports: { getServerSession, default: { getServerSession } } } as NodeModule;
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

let listBookings: typeof import('./booking-management').listBookings;
let getBookingDetail: typeof import('./booking-management').getBookingDetail;
let getCancellationStatus: typeof import('./booking-management').getCancellationStatus;
let getCancellationQuote: typeof import('./booking-management').getCancellationQuote;
let cancelBooking: typeof import('./booking-management').cancelBooking;
let acknowledgeDisruption: typeof import('./booking-management').acknowledgeDisruption;
let acceptDisruption: typeof import('./booking-management').acceptDisruption;
let getItineraryRevisions: typeof import('./booking-management').getItineraryRevisions;

before(async () => {
  ({
    listBookings,
    getBookingDetail,
    getCancellationStatus,
    getCancellationQuote,
    cancelBooking,
    acknowledgeDisruption,
    acceptDisruption,
    getItineraryRevisions,
  } = await import('./booking-management.ts'));
});

const timestamp = '2027-11-15T08:00:00.000Z';
const arrivalTimestamp = '2027-11-15T16:30:00.000Z';

const mockUpstreamSegment = {
  airlineName: 'Mock Horizon Air',
  marketingCarrierIata: 'HZ',
  carrierCode: 'HZ',
  operatingCarrier: 'Mock Horizon Air',
  flightNumber: 'HZ789',
  departureAirportIata: 'SFO',
  departureAirportName: 'San Francisco International',
  departureCity: 'San Francisco',
  departureTerminal: '2',
  arrivalAirportIata: 'JFK',
  arrivalAirportName: 'John F Kennedy International',
  arrivalCity: 'New York',
  arrivalTerminal: '4',
  departureAt: timestamp,
  arrivalAt: arrivalTimestamp,
  durationMinutes: 510,
  duration: 'PT8H30M',
  aircraftType: 'B738',
  duffelSegmentId: 'seg_secret_provider_id',
  sliceOrder: 0,
  segmentOrder: 0,
  globalOrder: 0,
};

const mockUpstreamBookingListItem = {
  id: 'booking-uuid-001',
  status: 'CONFIRMED',
  failureReason: null,
  pnrReference: 'PNR123',
  totalAmount: '499.00',
  currency: 'USD',
  departureAt: timestamp,
  flightSnapshot: {
    segments: [mockUpstreamSegment],
    totalDuration: 'PT8H30M',
    stops: 0,
    cabinClass: 'economy',
    baggageAllowance: '1 piece',
    fareClass: 'Y',
  },
  currentItinerary: {
    source: 'ORIGINAL',
    revisionId: null,
    version: 1,
    segments: [mockUpstreamSegment],
    nextUnflownDepartureAt: timestamp,
    finalArrivalAt: arrivalTimestamp,
  },
  disruption: {
    status: 'NONE',
    activeRevisionId: null,
    isMaterial: false,
    materialReasons: [],
    stabilizationWarning: false,
    resolvedReason: null,
    resolvedAt: null,
  },
  createdAt: '2027-11-01T10:00:00.000Z',
};

const mockUpstreamBookingDetail = {
  ...mockUpstreamBookingListItem,
  duffelOrderId: 'ord_secret_provider_123',
  passengerSnapshot: [
    {
      type: 'ADULT',
      title: 'Ms',
      givenName: 'Ada',
      familyName: 'Lovelace',
      passportNumber: 'ENC:masked_1234',
    },
  ],
  payment: {
    id: 'pay-uuid-001',
    status: 'SUCCEEDED',
    stripePaymentIntentId: 'pi_secret_stripe_456',
  },
  bookingIntent: {
    id: 'intent-uuid-001',
    offerId: 'off_secret_duffel_789',
    passengers: [
      {
        id: 'pax-uuid-001',
        type: 'ADULT',
        title: 'Ms',
        givenName: 'Ada',
        familyName: 'Lovelace',
      },
    ],
  },
  cancellationDeadline: '2027-11-14T08:00:00.000Z',
  cancellationRefundable: true,
  airlineRefundAmount: '450.00',
  customerRefundAmount: '450.00',
  duffelCancellationQuoteId: 'cquo_secret_provider_999',
  createdAt: '2027-11-01T10:00:00.000Z',
  updatedAt: '2027-11-02T10:00:00.000Z',
  ancillarySummary: {
    seats: [
      {
        intentPassengerId: 'pax-uuid-001',
        passengerName: 'Ada Lovelace',
        segmentId: 'seg_secret_provider_id',
        seatDesignator: '12A',
        amount: '25.00',
        currency: 'USD',
      },
    ],
    baggage: [
      {
        intentPassengerId: 'pax-uuid-001',
        passengerName: 'Ada Lovelace',
        type: 'CHECKED',
        quantity: 1,
        amount: '35.00',
        currency: 'USD',
      },
    ],
  },
};

describe('booking-management server domain module', () => {
  const originalEnvironment = process.env;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env = { ...originalEnvironment, API_URL: 'http://private-api.example/' };
    session = { accessToken: 'session-token-abc' };
    getServerSession.mock.resetCalls();
  });

  afterEach(() => {
    process.env = originalEnvironment;
    globalThis.fetch = originalFetch;
    session = null;
  });

  describe('listBookings', () => {
    it('maps an authenticated upstream booking list to a shared view stripping provider IDs', async () => {
      let requestedUrl = '';
      let requestedInit: RequestInit | undefined;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        requestedUrl = String(input);
        requestedInit = init;
        return new Response(
          JSON.stringify({
            bookings: [mockUpstreamBookingListItem],
            pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      };

      const outcome = await listBookings('upcoming', 1, 10);

      assert.strictEqual(outcome.ok, true);
      if (outcome.ok) {
        assert.strictEqual(outcome.data.tab, 'upcoming');
        assert.strictEqual(outcome.data.bookings.length, 1);
        assert.strictEqual(outcome.data.bookings[0].id, 'booking-uuid-001');
        assert.strictEqual(outcome.data.bookings[0].status, 'CONFIRMED');
        assert.strictEqual(outcome.data.bookings[0].pnrReference, 'PNR123');
        assert.strictEqual(outcome.data.bookings[0].totalAmount, '499.00');
        assert.strictEqual(outcome.data.bookings[0].currency, 'USD');
        assert.deepEqual(outcome.data.bookings[0].airline, { name: 'Mock Horizon Air', iataCode: 'HZ' });
        assert.deepEqual(outcome.data.bookings[0].origin, { iataCode: 'SFO', city: 'San Francisco' });
        assert.deepEqual(outcome.data.bookings[0].destination, { iataCode: 'JFK', city: 'New York' });
        assert.strictEqual(outcome.data.bookings[0].departureAt, timestamp);
        assert.strictEqual(outcome.data.bookings[0].arrivalAt, arrivalTimestamp);
      }
      assert.match(requestedUrl, /^http:\/\/private-api\.example\/api\/bookings\?tab=upcoming&page=1&limit=10$/);
      assert.strictEqual(requestedInit?.method, 'GET');
      assert.strictEqual((requestedInit?.headers as HeadersInit & { Authorization?: string }).Authorization, 'Bearer session-token-abc');

      // Verify no provider secrets leaked
      const serialized = JSON.stringify(outcome);
      assert.strictEqual(serialized.includes('duffelSegmentId'), false);
      assert.strictEqual(serialized.includes('seg_secret'), false);
    });

    it('returns an unauthenticated outcome if session is missing without calling upstream', async () => {
      session = null;
      let requested = false;
      globalThis.fetch = async (): Promise<Response> => {
        requested = true;
        return new Response();
      };

      const outcome = await listBookings('upcoming', 1, 10);

      assert.deepEqual(outcome, {
        ok: false,
        reason: 'UNAUTHENTICATED',
        message: 'Please sign in to view bookings.',
        retryable: false,
      });
      assert.strictEqual(requested, false);
    });

    it('returns INVALID_COMMAND if tab is invalid', async () => {
      let requested = false;
      globalThis.fetch = async (): Promise<Response> => {
        requested = true;
        return new Response();
      };

      // @ts-expect-error test invalid runtime input
      const outcome = await listBookings('invalid_tab', 1, 10);

      assert.strictEqual(outcome.ok, false);
      if (!outcome.ok) {
        assert.strictEqual(outcome.reason, 'INVALID_COMMAND');
      }
      assert.strictEqual(requested, false);
    });

    it('retries bounded on 503 upstream failures for GET', async () => {
      let attempts = 0;
      globalThis.fetch = async (): Promise<Response> => {
        attempts += 1;
        return new Response('Service Unavailable', { status: 503 });
      };

      const outcome = await listBookings('upcoming', 1, 10);

      assert.strictEqual(outcome.ok, false);
      if (!outcome.ok) {
        assert.strictEqual(outcome.reason, 'UPSTREAM_UNAVAILABLE');
        assert.strictEqual(outcome.retryable, true);
      }
      assert.strictEqual(attempts, 3);
    });

    it('handles 401 and 403 upstream errors properly', async () => {
      for (const [status, expectedReason] of [[401, 'UNAUTHENTICATED'], [403, 'FORBIDDEN']] as const) {
        globalThis.fetch = async (): Promise<Response> => {
          return new Response(JSON.stringify({ message: 'Forbidden' }), { status });
        };

        const outcome = await listBookings('upcoming', 1, 10);

        assert.strictEqual(outcome.ok, false);
        if (!outcome.ok) {
          assert.strictEqual(outcome.reason, expectedReason);
          assert.strictEqual(outcome.retryable, false);
        }
      }
    });

    it('rejects malformed upstream payload', async () => {
      globalThis.fetch = async (): Promise<Response> => {
        return new Response(JSON.stringify({ bookings: [{ id: '' }] }), { status: 200 });
      };

      const outcome = await listBookings('upcoming', 1, 10);

      assert.strictEqual(outcome.ok, false);
      if (!outcome.ok) {
        assert.strictEqual(outcome.reason, 'UPSTREAM_UNAVAILABLE');
      }
    });
  });

  describe('getBookingDetail', () => {
    it('maps an authenticated upstream detail response stripping internal Stripe and Duffel IDs', async () => {
      let requestedUrl = '';
      globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
        requestedUrl = String(input);
        return new Response(JSON.stringify(mockUpstreamBookingDetail), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const outcome = await getBookingDetail('booking-uuid-001');

      assert.strictEqual(outcome.ok, true);
      if (outcome.ok) {
        assert.strictEqual(outcome.data.id, 'booking-uuid-001');
        assert.strictEqual(outcome.data.status, 'CONFIRMED');
        assert.strictEqual(outcome.data.paymentStatus, 'SUCCEEDED');
        assert.strictEqual(outcome.data.offerId, 'off_secret_duffel_789');
        assert.strictEqual(outcome.data.pnrReference, 'PNR123');
        assert.strictEqual(outcome.data.totalAmount, '499.00');
        assert.strictEqual(outcome.data.currency, 'USD');
        assert.strictEqual(outcome.data.passengers.length, 1);
        assert.strictEqual(outcome.data.passengers[0].firstName, 'Ada');
        assert.strictEqual(outcome.data.passengers[0].lastName, 'Lovelace');
        assert.strictEqual(outcome.data.passengers[0].title, 'Ms');
        assert.strictEqual(outcome.data.ancillarySummary?.seats.length, 1);
        assert.strictEqual(outcome.data.ancillarySummary?.seats[0].seatDesignator, '12A');
        assert.strictEqual(outcome.data.ancillarySummary?.baggage.length, 1);
        assert.strictEqual(outcome.data.cancellation?.airlineRefundAmount, '450.00');
      }
      assert.match(requestedUrl, /\/api\/bookings\/booking-uuid-001$/);

      // Verify no provider secrets leaked
      const serialized = JSON.stringify(outcome);
      assert.strictEqual(serialized.includes('ord_secret'), false);
      assert.strictEqual(serialized.includes('duffelOrderId'), false);
      assert.strictEqual(serialized.includes('pi_secret'), false);
      assert.strictEqual(serialized.includes('cquo_secret'), false);
      assert.strictEqual(serialized.includes('passportNumber'), false);
      assert.strictEqual(serialized.includes('stripePaymentIntentId'), false);
    });

    it('preserves disruption activeRevisionId and diff summaries for browser review', async () => {
      globalThis.fetch = async (): Promise<Response> => {
        return new Response(
          JSON.stringify({
            ...mockUpstreamBookingDetail,
            disruption: {
              status: 'DETECTED',
              activeRevisionId: 'rev-uuid-789',
              isMaterial: true,
              materialReasons: ['DEPARTURE_MOVED_LATER'],
              incrementalSummary: { isRoutingChanged: false, sliceSummaries: [] },
              cumulativeSummary: { isRoutingChanged: false, sliceSummaries: [] },
              stabilizationWarning: true,
              resolvedReason: null,
              resolvedAt: null,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      };

      const outcome = await getBookingDetail('booking-uuid-001');

      assert.strictEqual(outcome.ok, true);
      if (outcome.ok) {
        assert.strictEqual(outcome.data.disruption?.status, 'DETECTED');
        assert.strictEqual(outcome.data.disruption?.activeRevisionId, 'rev-uuid-789');
        assert.strictEqual(outcome.data.disruption?.isMaterial, true);
        assert.strictEqual(outcome.data.disruption?.stabilizationWarning, true);
        assert.deepEqual(outcome.data.disruption?.incrementalSummary, { isRoutingChanged: false, sliceSummaries: [] });
        assert.deepEqual(outcome.data.disruption?.cumulativeSummary, { isRoutingChanged: false, sliceSummaries: [] });
      }
    });

    it('normalizes empty offerId, paymentStatus, and pnrReference to null instead of rejecting schema', async () => {
      globalThis.fetch = async (): Promise<Response> => {
        return new Response(
          JSON.stringify({
            ...mockUpstreamBookingDetail,
            bookingIntent: {
              id: 'intent-uuid-001',
              offerId: '', // Empty string from API when booking intent has no duffelOfferId
            },
            payment: {
              id: 'pay-uuid-001',
              status: '',
            },
            pnrReference: '',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      };

      const outcome = await getBookingDetail('booking-uuid-001');

      assert.strictEqual(outcome.ok, true);
      if (outcome.ok) {
        assert.strictEqual(outcome.data.offerId, null);
        assert.strictEqual(outcome.data.paymentStatus, null);
        assert.strictEqual(outcome.data.pnrReference, null);
      }
    });

    it('returns NOT_FOUND on 404 upstream', async () => {
      globalThis.fetch = async (): Promise<Response> => {
        return new Response(JSON.stringify({ message: 'Booking not found' }), { status: 404 });
      };

      const outcome = await getBookingDetail('nonexistent-uuid');

      assert.strictEqual(outcome.ok, false);
      if (!outcome.ok) {
        assert.strictEqual(outcome.reason, 'NOT_FOUND');
        assert.strictEqual(outcome.retryable, false);
      }
    });

    it('returns INVALID_COMMAND if bookingId is empty', async () => {
      const outcome = await getBookingDetail('');
      assert.strictEqual(outcome.ok, false);
      if (!outcome.ok) {
        assert.strictEqual(outcome.reason, 'INVALID_COMMAND');
      }
    });

    it('retries on network timeout/abort error', async () => {
      let attempts = 0;
      globalThis.fetch = async (): Promise<Response> => {
        attempts += 1;
        throw new DOMException('Aborted', 'AbortError');
      };

      const outcome = await getBookingDetail('booking-uuid-001');

      assert.strictEqual(outcome.ok, false);
      if (!outcome.ok) {
        assert.strictEqual(outcome.reason, 'UPSTREAM_UNAVAILABLE');
        assert.strictEqual(outcome.retryable, true);
      }
      assert.strictEqual(attempts, 3);
    });
  });

  describe('getCancellationStatus', () => {
    it('maps cancellation status stripping duffel quote and retry count internals', async () => {
      globalThis.fetch = async (): Promise<Response> => {
        return new Response(
          JSON.stringify({
            bookingId: 'booking-uuid-001',
            bookingStatus: 'CANCELLATION_PENDING',
            cancellationDeadline: '2027-11-14T08:00:00.000Z',
            airlineRefundAmount: '450.00',
            customerRefundAmount: '450.00',
            duffelCancellationQuoteId: 'cquo_provider_secret',
            refundStatus: 'PENDING',
            retryCount: 2,
            nextRetryAt: '2027-11-14T10:00:00.000Z',
            lastErrorCode: 'SUPPLIER_RATE_LIMITED',
            escalationMessage: null,
          }),
          { status: 200 },
        );
      };

      const outcome = await getCancellationStatus('booking-uuid-001');

      assert.strictEqual(outcome.ok, true);
      if (outcome.ok) {
        assert.strictEqual(outcome.data.bookingId, 'booking-uuid-001');
        assert.strictEqual(outcome.data.bookingStatus, 'CANCELLATION_PENDING');
        assert.strictEqual(outcome.data.refundStatus, 'PENDING');
        assert.strictEqual(outcome.data.airlineRefundAmount, '450.00');
      }

      const serialized = JSON.stringify(outcome);
      assert.strictEqual(serialized.includes('cquo_provider_secret'), false);
      assert.strictEqual(serialized.includes('SUPPLIER_RATE_LIMITED'), false);
      assert.strictEqual(serialized.includes('retryCount'), false);
    });
  });

  describe('getCancellationQuote', () => {
    it('requests cancellation quote and strips provider duffelOrderId with fast-fail mutation', async () => {
      let attempts = 0;
      globalThis.fetch = async (): Promise<Response> => {
        attempts += 1;
        return new Response(
          JSON.stringify({
            bookingId: 'booking-uuid-001',
            quoteId: 'quote-local-123',
            duffelOrderId: 'ord_secret_123',
            refundAmount: '450.00',
            currency: 'USD',
            expiresAt: '2027-11-14T12:00:00.000Z',
            refundable: true,
            refundTo: 'original_payment_card',
            nonRefundableAncillaryAmount: '49.00',
            nonRefundableAncillaryCurrency: 'USD',
          }),
          { status: 200 },
        );
      };

      const outcome = await getCancellationQuote('booking-uuid-001');

      assert.strictEqual(outcome.ok, true);
      if (outcome.ok) {
        assert.strictEqual(outcome.data.quoteId, 'quote-local-123');
        assert.strictEqual(outcome.data.refundAmount, '450.00');
        assert.strictEqual(outcome.data.currency, 'USD');
        assert.strictEqual(outcome.data.refundable, true);
      }
      assert.strictEqual(attempts, 1);

      const serialized = JSON.stringify(outcome);
      assert.strictEqual(serialized.includes('ord_secret_123'), false);
      assert.strictEqual(serialized.includes('duffelOrderId'), false);
    });

    it('fails fast on 500 error for quote creation (1 attempt)', async () => {
      let attempts = 0;
      globalThis.fetch = async (): Promise<Response> => {
        attempts += 1;
        return new Response('Internal Server Error', { status: 500 });
      };

      const outcome = await getCancellationQuote('booking-uuid-001');

      assert.strictEqual(outcome.ok, false);
      if (!outcome.ok) {
        assert.strictEqual(outcome.reason, 'UPSTREAM_UNAVAILABLE');
      }
      assert.strictEqual(attempts, 1);
    });
  });

  describe('cancelBooking', () => {
    it('executes cancellation mutation fast-fail and maps result', async () => {
      let attempts = 0;
      let requestedBody = '';
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        attempts += 1;
        requestedBody = String(init?.body);
        return new Response(
          JSON.stringify({
            bookingId: 'booking-uuid-001',
            bookingStatus: 'CANCELLED_PENDING_REFUND',
            cancellationStatus: 'CONFIRMED',
            refundStatus: 'PENDING',
            refundAmount: '450.00',
            duffelCancellationQuoteId: 'cquo_secret_123',
          }),
          { status: 200 },
        );
      };

      const outcome = await cancelBooking('booking-uuid-001', 'quote-local-123');

      assert.strictEqual(outcome.ok, true);
      if (outcome.ok) {
        assert.strictEqual(outcome.data.bookingId, 'booking-uuid-001');
        assert.strictEqual(outcome.data.bookingStatus, 'CANCELLED_PENDING_REFUND');
        assert.strictEqual(outcome.data.refundAmount, '450.00');
      }
      assert.strictEqual(attempts, 1);
      assert.deepEqual(JSON.parse(requestedBody), { quoteId: 'quote-local-123' });

      const serialized = JSON.stringify(outcome);
      assert.strictEqual(serialized.includes('cquo_secret_123'), false);
    });

    it('returns INVALID_COMMAND if quoteId is missing', async () => {
      const outcome = await cancelBooking('booking-uuid-001', '');
      assert.strictEqual(outcome.ok, false);
      if (!outcome.ok) {
        assert.strictEqual(outcome.reason, 'INVALID_COMMAND');
      }
    });
  });

  describe('acknowledgeDisruption', () => {
    it('sends acknowledge disruption mutation and returns ok: true', async () => {
      let requestedUrl = '';
      let attempts = 0;
      globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
        attempts += 1;
        requestedUrl = String(input);
        return new Response(
          JSON.stringify({
            bookingId: 'booking-uuid-001',
            activeRevisionId: 'rev-uuid-001',
            disruptionStatus: 'ACKNOWLEDGED',
          }),
          { status: 200 },
        );
      };

      const outcome = await acknowledgeDisruption('booking-uuid-001', 'rev-uuid-001');

      assert.strictEqual(outcome.ok, true);
      if (outcome.ok) {
        assert.strictEqual(outcome.data.ok, true);
      }
      assert.strictEqual(attempts, 1);
      assert.match(requestedUrl, /\/api\/bookings\/booking-uuid-001\/disruptions\/rev-uuid-001\/acknowledge$/);
    });

    it('maps 409 conflict upstream to STALE_REVISION reason', async () => {
      globalThis.fetch = async (): Promise<Response> => {
        return new Response(
          JSON.stringify({ code: 'STALE_DISRUPTION_REVISION', message: 'A newer change exists and must be reviewed.' }),
          { status: 409 },
        );
      };

      const outcome = await acknowledgeDisruption('booking-uuid-001', 'rev-uuid-001');

      assert.strictEqual(outcome.ok, false);
      if (!outcome.ok) {
        assert.strictEqual(outcome.reason, 'STALE_REVISION');
        assert.strictEqual(outcome.retryable, false);
      }
    });
  });

  describe('acceptDisruption', () => {
    it('sends accept disruption mutation and returns ok: true', async () => {
      let requestedUrl = '';
      let attempts = 0;
      globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
        attempts += 1;
        requestedUrl = String(input);
        return new Response(
          JSON.stringify({
            bookingId: 'booking-uuid-001',
            activeRevisionId: 'rev-uuid-001',
            disruptionStatus: 'RESOLVED',
          }),
          { status: 200 },
        );
      };

      const outcome = await acceptDisruption('booking-uuid-001', 'rev-uuid-001');

      assert.strictEqual(outcome.ok, true);
      if (outcome.ok) {
        assert.strictEqual(outcome.data.ok, true);
      }
      assert.strictEqual(attempts, 1);
      assert.match(requestedUrl, /\/api\/bookings\/booking-uuid-001\/disruptions\/rev-uuid-001\/accept$/);
    });

    it('maps 409 conflict upstream to STALE_REVISION reason on accept', async () => {
      globalThis.fetch = async (): Promise<Response> => {
        return new Response(
          JSON.stringify({ code: 'STALE_DISRUPTION_REVISION', message: 'A newer change exists and must be reviewed.' }),
          { status: 409 },
        );
      };

      const outcome = await acceptDisruption('booking-uuid-001', 'rev-uuid-001');

      assert.strictEqual(outcome.ok, false);
      if (!outcome.ok) {
        assert.strictEqual(outcome.reason, 'STALE_REVISION');
        assert.strictEqual(outcome.retryable, false);
      }
    });
  });

  describe('getItineraryRevisions', () => {
    it('maps paginated revisions stripping baseline and diff internals', async () => {
      let requestedUrl = '';
      globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
        requestedUrl = String(input);
        return new Response(
          JSON.stringify({
            items: [
              {
                revisionId: 'rev-uuid-001',
                version: 2,
                observedAt: timestamp,
                isMaterial: true,
                materialReasons: ['SCHEDULE_CHANGE'],
                materialBaselines: [{ baseline: 'internal' }],
                incrementalSummary: { diff: 'internal' },
                cumulativeSummary: { diff: 'internal' },
                segments: [mockUpstreamSegment],
              },
            ],
            page: 1,
            limit: 5,
            total: 1,
            totalPages: 1,
          }),
          { status: 200 },
        );
      };

      const outcome = await getItineraryRevisions('booking-uuid-001', 1, 5);

      assert.strictEqual(outcome.ok, true);
      if (outcome.ok) {
        assert.strictEqual(outcome.data.revisions.length, 1);
        assert.strictEqual(outcome.data.revisions[0].revisionId, 'rev-uuid-001');
        assert.strictEqual(outcome.data.revisions[0].version, 2);
        assert.strictEqual(outcome.data.revisions[0].isMaterial, true);
        assert.deepEqual(outcome.data.revisions[0].materialReasons, ['SCHEDULE_CHANGE']);
        assert.strictEqual(outcome.data.revisions[0].segments.length, 1);
        assert.strictEqual(outcome.data.total, 1);
        assert.strictEqual(outcome.data.totalPages, 1);
      }
      assert.match(requestedUrl, /\/api\/bookings\/booking-uuid-001\/disruptions\?page=1&limit=5$/);

      const serialized = JSON.stringify(outcome);
      assert.strictEqual(serialized.includes('materialBaselines'), false);
      assert.strictEqual(serialized.includes('incrementalSummary'), false);
      assert.strictEqual(serialized.includes('cumulativeSummary'), false);
    });

    it('retries bounded on 503 for getItineraryRevisions (idempotent read)', async () => {
      let attempts = 0;
      globalThis.fetch = async (): Promise<Response> => {
        attempts += 1;
        return new Response('Unavailable', { status: 503 });
      };

      const outcome = await getItineraryRevisions('booking-uuid-001', 1, 5);

      assert.strictEqual(outcome.ok, false);
      if (!outcome.ok) {
        assert.strictEqual(outcome.reason, 'UPSTREAM_UNAVAILABLE');
      }
      assert.strictEqual(attempts, 3);
    });
  });
});
