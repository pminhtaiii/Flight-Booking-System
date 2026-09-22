import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, beforeEach, describe, it, mock } from 'node:test';
import type {
  BookingManagementOutcome,
  CancellationStatusView,
  CancellationResultView,
} from '@shared/types/booking-management.types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const testRequire = createRequire(import.meta.url);

const resolvePath = (specifier: string): string => {
  try {
    return testRequire.resolve(specifier);
  } catch {
    return require.resolve(specifier, {
      paths: [
        path.resolve(__dirname, '../../../../../../../node_modules'),
        path.resolve(process.cwd(), 'apps/web/node_modules'),
        path.resolve(process.cwd(), 'node_modules'),
      ],
    });
  }
};

const serverOnlyPath = resolvePath('server-only');
testRequire.cache[serverOnlyPath] = { exports: {} } as NodeModule;

const mockGetCancellationStatus = mock.fn<
  (bookingId: string) => Promise<BookingManagementOutcome<CancellationStatusView>>
>();
const mockCancelBooking = mock.fn<
  (bookingId: string, quoteId: string) => Promise<BookingManagementOutcome<CancellationResultView>>
>();

const bmResolved = path.resolve(process.cwd(), 'apps/web/lib/server/booking-management.ts');
testRequire.cache[bmResolved] = {
  id: bmResolved,
  filename: bmResolved,
  loaded: true,
  exports: {
    getCancellationStatus: (bookingId: string) => mockGetCancellationStatus(bookingId),
    cancelBooking: (bookingId: string, quoteId: string) => mockCancelBooking(bookingId, quoteId),
  },
} as NodeModule;

const mockStatusData: CancellationStatusView = {
  bookingId: 'booking-test-123',
  bookingStatus: 'CONFIRMED',
  cancellationDeadline: '2026-10-01T12:00:00.000Z',
  airlineRefundAmount: '450.00',
  customerRefundAmount: '400.00',
  refundStatus: 'PENDING',
  nextRetryAt: null,
  escalationMessage: null,
};

const mockCancelData: CancellationResultView = {
  bookingId: 'booking-test-123',
  bookingStatus: 'CANCELLED',
  cancellationStatus: 'CONFIRMED',
  refundStatus: 'PROCESSED',
  refundAmount: '400.00',
  nextRetryAt: null,
};

let GET: (
  request: Request,
  context: { params: { bookingId: string } },
) => Promise<Response>;
let POST: (
  request: Request,
  context: { params: { bookingId: string } },
) => Promise<Response>;

describe('apps/web/app/api/booking-management/bookings/[bookingId]/cancellation/route', () => {
  before(async () => {
    const routeModule = await import('./route');
    GET = routeModule.GET;
    POST = routeModule.POST;
  });

  beforeEach(() => {
    mockGetCancellationStatus.mock.resetCalls();
    mockCancelBooking.mock.resetCalls();
  });

  describe('GET', () => {
    it('calls getCancellationStatus(bookingId) and returns 200 with data on success', async () => {
      mockGetCancellationStatus.mock.mockImplementationOnce(async () => ({
        ok: true,
        data: mockStatusData,
      }));

      const req = new Request('http://localhost:3000/api/booking-management/bookings/booking-test-123/cancellation');
      const res = await GET(req, { params: { bookingId: 'booking-test-123' } });

      assert.equal(res.status, 200);
      const json = await res.json();
      assert.deepEqual(json, mockStatusData);
      assert.equal(mockGetCancellationStatus.mock.calls.length, 1);
      assert.equal(mockGetCancellationStatus.mock.calls[0].arguments[0], 'booking-test-123');
    });

    it('asserts header Cache-Control: private, no-store', async () => {
      mockGetCancellationStatus.mock.mockImplementationOnce(async () => ({
        ok: true,
        data: mockStatusData,
      }));

      const req = new Request('http://localhost:3000/api/booking-management/bookings/booking-test-123/cancellation');
      const res = await GET(req, { params: { bookingId: 'booking-test-123' } });

      assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
    });

    it('maps outcome failures correctly: UNAUTHENTICATED -> 401, FORBIDDEN -> 403, NOT_FOUND -> 404, UPSTREAM_UNAVAILABLE -> 503', async () => {
      const cases = [
        { reason: 'UNAUTHENTICATED' as const, status: 401, message: 'Must be logged in' },
        { reason: 'FORBIDDEN' as const, status: 403, message: 'Access denied' },
        { reason: 'NOT_FOUND' as const, status: 404, message: 'Booking not found' },
        { reason: 'UPSTREAM_UNAVAILABLE' as const, status: 503, message: 'Service unavailable' },
      ];

      for (const c of cases) {
        mockGetCancellationStatus.mock.mockImplementationOnce(async () => ({
          ok: false,
          reason: c.reason,
          message: c.message,
          retryable: false,
        }));

        const req = new Request('http://localhost:3000/api/booking-management/bookings/booking-test-123/cancellation');
        const res = await GET(req, { params: { bookingId: 'booking-test-123' } });

        assert.equal(res.status, c.status);
        assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
        const json = await res.json();
        assert.deepEqual(json, { error: c.reason, message: c.message });
      }
    });
  });

  describe('POST', () => {
    it('extracts quoteId from request JSON body, calls cancelBooking(bookingId, quoteId), returns 200 on success', async () => {
      mockCancelBooking.mock.mockImplementationOnce(async () => ({
        ok: true,
        data: mockCancelData,
      }));

      const req = new Request('http://localhost:3000/api/booking-management/bookings/booking-test-123/cancellation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quoteId: 'quote-test-456' }),
      });
      const res = await POST(req, { params: { bookingId: 'booking-test-123' } });

      assert.equal(res.status, 200);
      assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
      const json = await res.json();
      assert.deepEqual(json, mockCancelData);
      assert.equal(mockCancelBooking.mock.calls.length, 1);
      assert.equal(mockCancelBooking.mock.calls[0].arguments[0], 'booking-test-123');
      assert.equal(mockCancelBooking.mock.calls[0].arguments[1], 'quote-test-456');
    });

    it('asserts header Cache-Control: private, no-store', async () => {
      mockCancelBooking.mock.mockImplementationOnce(async () => ({
        ok: true,
        data: mockCancelData,
      }));

      const req = new Request('http://localhost:3000/api/booking-management/bookings/booking-test-123/cancellation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quoteId: 'quote-test-456' }),
      });
      const res = await POST(req, { params: { bookingId: 'booking-test-123' } });

      assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
    });

    it('handles missing or malformed JSON body gracefully (passes empty string or fallback)', async () => {
      mockCancelBooking.mock.mockImplementation(async () => ({
        ok: true,
        data: mockCancelData,
      }));

      // Case 1: Malformed JSON
      const reqMalformed = new Request(
        'http://localhost:3000/api/booking-management/bookings/booking-test-123/cancellation',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'not-valid-json',
        },
      );
      await POST(reqMalformed, { params: { bookingId: 'booking-test-123' } });
      assert.equal(mockCancelBooking.mock.calls[0].arguments[0], 'booking-test-123');
      assert.equal(mockCancelBooking.mock.calls[0].arguments[1], '');

      // Case 2: Empty body
      const reqEmpty = new Request(
        'http://localhost:3000/api/booking-management/bookings/booking-test-123/cancellation',
        {
          method: 'POST',
        },
      );
      await POST(reqEmpty, { params: { bookingId: 'booking-test-123' } });
      assert.equal(mockCancelBooking.mock.calls[1].arguments[0], 'booking-test-123');
      assert.equal(mockCancelBooking.mock.calls[1].arguments[1], '');

      // Case 3: JSON without quoteId
      const reqNoQuoteId = new Request(
        'http://localhost:3000/api/booking-management/bookings/booking-test-123/cancellation',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      );
      await POST(reqNoQuoteId, { params: { bookingId: 'booking-test-123' } });
      assert.equal(mockCancelBooking.mock.calls[2].arguments[0], 'booking-test-123');
      assert.equal(mockCancelBooking.mock.calls[2].arguments[1], '');
    });

    it('maps outcome failures: STALE_REVISION -> 409, INVALID_COMMAND -> 400, UNAUTHENTICATED -> 401, FORBIDDEN -> 403, NOT_FOUND -> 404, UPSTREAM_UNAVAILABLE -> 503', async () => {
      const cases = [
        { reason: 'STALE_REVISION' as const, status: 409, message: 'Revision conflict' },
        { reason: 'INVALID_COMMAND' as const, status: 400, message: 'Quote ID missing' },
        { reason: 'UNAUTHENTICATED' as const, status: 401, message: 'Must be logged in' },
        { reason: 'FORBIDDEN' as const, status: 403, message: 'Access denied' },
        { reason: 'NOT_FOUND' as const, status: 404, message: 'Booking not found' },
        { reason: 'UPSTREAM_UNAVAILABLE' as const, status: 503, message: 'Upstream unavailable' },
      ];

      for (const c of cases) {
        mockCancelBooking.mock.mockImplementationOnce(async () => ({
          ok: false,
          reason: c.reason,
          message: c.message,
          retryable: false,
        }));

        const req = new Request('http://localhost:3000/api/booking-management/bookings/booking-test-123/cancellation', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ quoteId: 'quote-test-456' }),
        });
        const res = await POST(req, { params: { bookingId: 'booking-test-123' } });

        assert.equal(res.status, c.status);
        assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
        const json = await res.json();
        assert.deepEqual(json, { error: c.reason, message: c.message });
      }
    });
  });
});
