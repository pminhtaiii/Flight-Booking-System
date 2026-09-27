import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { before, describe, it, mock } from 'node:test';
import type { BookingManagementOutcome } from '@shared/types/booking-management.types';

const testRequire = createRequire(import.meta.url);
const serverOnlyPath = testRequire.resolve('server-only');
testRequire.cache[serverOnlyPath] = { exports: {} } as NodeModule;

type Payload = { bookingId: string; nested: { revision: number } };
const payload: Payload = { bookingId: 'booking-test-123', nested: { revision: 2 } };
let nextOutcome: BookingManagementOutcome<Payload> = { ok: true, data: payload };
// User approved removing the unused mock parameter on 2026-09-26 to satisfy lint; assertions remain unchanged.
const mockBookingOperation = mock.fn(async (): Promise<BookingManagementOutcome<Payload>> => nextOutcome);

const bookingManagementPath = path.resolve(process.cwd(), 'apps/web/lib/server/booking-management.ts');
testRequire.cache[bookingManagementPath] = {
  id: bookingManagementPath,
  filename: bookingManagementPath,
  loaded: true,
  exports: {
    getBookingDetail: mockBookingOperation,
    getCancellationStatus: mockBookingOperation,
    cancelBooking: mockBookingOperation,
    getCancellationQuote: mockBookingOperation,
    getItineraryRevisions: mockBookingOperation,
    acknowledgeDisruption: mockBookingOperation,
    acceptDisruption: mockBookingOperation,
  },
} as NodeModule;

type RouteHandler = (request: Request, context: { params: { bookingId: string } }) => Promise<Response>;
type RouteCase = { name: string; method: 'GET' | 'POST'; suffix: string; load: () => Promise<RouteHandler>; body?: object };

const cases: RouteCase[] = [
  {
    name: 'booking detail GET', method: 'GET', suffix: '',
    load: async () => (await import('./bookings/[bookingId]/route')).GET,
  },
  {
    name: 'cancellation status GET', method: 'GET', suffix: '/cancellation',
    load: async () => (await import('./bookings/[bookingId]/cancellation/route')).GET,
  },
  {
    name: 'cancel booking POST', method: 'POST', suffix: '/cancellation', body: { quoteId: 'quote-test-456' },
    load: async () => (await import('./bookings/[bookingId]/cancellation/route')).POST,
  },
  {
    name: 'cancellation quote POST', method: 'POST', suffix: '/cancellation/quote',
    load: async () => (await import('./bookings/[bookingId]/cancellation/quote/route')).POST,
  },
  {
    name: 'revisions GET', method: 'GET', suffix: '/revisions?page=2&limit=3',
    load: async () => (await import('./bookings/[bookingId]/revisions/route')).GET,
  },
  {
    name: 'acknowledge disruption POST', method: 'POST', suffix: '/disruptions/acknowledge', body: { revisionId: 'revision-test-789' },
    load: async () => (await import('./bookings/[bookingId]/disruptions/acknowledge/route')).POST,
  },
  {
    name: 'accept disruption POST', method: 'POST', suffix: '/disruptions/accept', body: { revisionId: 'revision-test-789' },
    load: async () => (await import('./bookings/[bookingId]/disruptions/accept/route')).POST,
  },
];

const failures = [
  ['UNAUTHENTICATED', 401],
  ['FORBIDDEN', 403],
  ['NOT_FOUND', 404],
  ['STALE_REVISION', 409],
  ['INVALID_COMMAND', 400],
  ['UPSTREAM_UNAVAILABLE', 503],
  ['UNMAPPED_REASON', 500],
] as const;

async function requestRoute(route: RouteCase, handler: RouteHandler): Promise<Response> {
  const request = new Request(
    `http://localhost:3000/api/booking-management/bookings/booking-test-123${route.suffix}`,
    {
      method: route.method,
      ...(route.body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(route.body) } : {}),
    },
  );
  return handler(request, { params: { bookingId: 'booking-test-123' } });
}

describe('booking-management route response parity', () => {
  const handlers = new Map<string, RouteHandler>();

  before(async () => {
    for (const route of cases) handlers.set(route.name, await route.load());
  });

  for (const route of cases) {
    it(`${route.name} preserves success status, body, and cache header`, async () => {
      nextOutcome = { ok: true, data: payload };
      const handler = handlers.get(route.name);
      assert.ok(handler);
      const response = await requestRoute(route, handler);

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), payload);
      assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    });

    for (const [reason, status] of failures) {
      it(`${route.name} maps ${reason} to ${status} with the unchanged error body and cache header`, async () => {
        nextOutcome = {
          ok: false,
          reason,
          message: `Message for ${reason}`,
          retryable: false,
        } as unknown as BookingManagementOutcome<Payload>;
        const handler = handlers.get(route.name);
        assert.ok(handler);
        const response = await requestRoute(route, handler);

        assert.equal(response.status, status);
        assert.deepEqual(await response.json(), { error: reason, message: `Message for ${reason}` });
        assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
      });
    }
  }
});
