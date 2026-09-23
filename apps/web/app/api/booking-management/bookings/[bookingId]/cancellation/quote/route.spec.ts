import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, beforeEach, describe, it, mock } from 'node:test';
import type {
  BookingManagementOutcome,
  CancellationQuoteView,
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
        path.resolve(__dirname, '../../../../../../../../node_modules'),
        path.resolve(process.cwd(), 'apps/web/node_modules'),
        path.resolve(process.cwd(), 'node_modules'),
      ],
    });
  }
};

const serverOnlyPath = resolvePath('server-only');
testRequire.cache[serverOnlyPath] = { exports: {} } as NodeModule;

const mockGetCancellationQuote = mock.fn<
  (bookingId: string) => Promise<BookingManagementOutcome<CancellationQuoteView>>
>();

const bmResolved = path.resolve(process.cwd(), 'apps/web/lib/server/booking-management.ts');
testRequire.cache[bmResolved] = {
  id: bmResolved,
  filename: bmResolved,
  loaded: true,
  exports: {
    getCancellationQuote: (bookingId: string) => mockGetCancellationQuote(bookingId),
  },
} as NodeModule;

const mockQuoteData: CancellationQuoteView = {
  bookingId: 'booking-test-123',
  quoteId: 'quote-test-456',
  refundAmount: '400.00',
  currency: 'USD',
  expiresAt: '2026-10-01T12:30:00.000Z',
  refundable: true,
  cancellationDeadline: '2026-10-01T12:00:00.000Z',
  refundTo: 'ORIGINAL_PAYMENT_METHOD',
  nonRefundableAncillaryAmount: '50.00',
  nonRefundableAncillaryCurrency: 'USD',
};

let POST: (
  request: Request,
  context: { params: { bookingId: string } },
) => Promise<Response>;

describe('apps/web/app/api/booking-management/bookings/[bookingId]/cancellation/quote/route', () => {
  before(async () => {
    const routeModule = await import('./route');
    POST = routeModule.POST;
  });

  beforeEach(() => {
    mockGetCancellationQuote.mock.resetCalls();
  });

  describe('POST', () => {
    it('calls getCancellationQuote(bookingId) and returns 200 with data on success', async () => {
      mockGetCancellationQuote.mock.mockImplementationOnce(async () => ({
        ok: true,
        data: mockQuoteData,
      }));

      const req = new Request('http://localhost:3000/api/booking-management/bookings/booking-test-123/cancellation/quote', {
        method: 'POST',
      });
      const res = await POST(req, { params: { bookingId: 'booking-test-123' } });

      assert.equal(res.status, 200);
      assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
      const json = await res.json();
      assert.deepEqual(json, mockQuoteData);
      assert.equal(mockGetCancellationQuote.mock.calls.length, 1);
      assert.equal(mockGetCancellationQuote.mock.calls[0].arguments[0], 'booking-test-123');
    });

    it('asserts header Cache-Control: private, no-store', async () => {
      mockGetCancellationQuote.mock.mockImplementationOnce(async () => ({
        ok: true,
        data: mockQuoteData,
      }));

      const req = new Request('http://localhost:3000/api/booking-management/bookings/booking-test-123/cancellation/quote', {
        method: 'POST',
      });
      const res = await POST(req, { params: { bookingId: 'booking-test-123' } });

      assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
    });

    it('maps outcome failures: UNAUTHENTICATED -> 401, FORBIDDEN -> 403, NOT_FOUND -> 404, INVALID_COMMAND -> 400, UPSTREAM_UNAVAILABLE -> 503', async () => {
      const cases = [
        { reason: 'UNAUTHENTICATED' as const, status: 401, message: 'Must be logged in' },
        { reason: 'FORBIDDEN' as const, status: 403, message: 'Access denied' },
        { reason: 'NOT_FOUND' as const, status: 404, message: 'Booking not found' },
        { reason: 'INVALID_COMMAND' as const, status: 400, message: 'Invalid command' },
        { reason: 'UPSTREAM_UNAVAILABLE' as const, status: 503, message: 'Upstream unavailable' },
      ];

      for (const c of cases) {
        mockGetCancellationQuote.mock.mockImplementationOnce(async () => ({
          ok: false,
          reason: c.reason,
          message: c.message,
          retryable: false,
        }));

        const req = new Request('http://localhost:3000/api/booking-management/bookings/booking-test-123/cancellation/quote', {
          method: 'POST',
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
