import {
  BookingDetailViewSchema,
  BookingListViewSchema,
  BookingManagementOutcomeSchema,
  CancellationQuoteViewSchema,
  CancellationResultViewSchema,
  CancellationStatusViewSchema,
  ItineraryRevisionViewSchema,
  type BookingDetailView,
  type BookingListView,
  type BookingManagementOutcome,
} from './booking-management.types';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

type Assert<T extends true> = T;
type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2 ? true : false;

const timestamp = '2026-08-25T10:00:00Z';
const segment = {
  airline: { name: 'Example Air', iataCode: 'EX' },
  flightNumber: 'EX123',
  departureAirport: { iataCode: 'SGN', name: 'Tan Son Nhat', city: 'Ho Chi Minh City' },
  arrivalAirport: { iataCode: 'HAN', name: 'Noi Bai', city: 'Hanoi' },
  departureAt: timestamp,
  arrivalAt: '2026-08-25T12:00:00Z',
  duration: 'PT2H',
};

const list = {
  bookings: [
    {
      id: 'booking-local-1',
      status: 'CONFIRMED',
      pnrReference: 'ABC123',
      totalAmount: '125.00',
      currency: 'USD',
      departureAt: timestamp,
      arrivalAt: '2026-08-25T12:00:00Z',
      airline: segment.airline,
      origin: { iataCode: 'SGN', city: 'Ho Chi Minh City' },
      destination: { iataCode: 'HAN', city: 'Hanoi' },
    },
  ],
  tab: 'upcoming' as const,
  pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
};

const detail = {
  ...list.bookings[0],
  createdAt: timestamp,
  updatedAt: timestamp,
  itinerary: { source: 'ORIGINAL' as const, version: 1, segments: [segment] },
  passengers: [{ type: 'ADULT', firstName: 'Ada', lastName: 'Lovelace' }],
};

describe('Booking Management shared contracts', () => {
  it('parses prepared list, detail, cancellation, and itinerary outcomes', () => {
    const listOutcome = BookingManagementOutcomeSchema(BookingListViewSchema).parse({
      ok: true,
      data: list,
    });
    const detailOutcome = BookingManagementOutcomeSchema(BookingDetailViewSchema).parse({
      ok: true,
      data: detail,
    });
    assert.ok(listOutcome.ok, 'list outcome should parse as a success');
    assert.ok(detailOutcome.ok, 'detail outcome should parse as a success');

    const cancellationStatus = CancellationStatusViewSchema.parse({
      bookingId: 'booking-local-1',
      bookingStatus: 'CANCELLING',
      cancellationDeadline: null,
      airlineRefundAmount: null,
      customerRefundAmount: null,
      refundStatus: null,
      nextRetryAt: null,
      escalationMessage: null,
    });
    const quote = CancellationQuoteViewSchema.parse({
      bookingId: 'booking-local-1',
      quoteId: 'quote-local-1',
      refundAmount: '100.00',
      currency: 'USD',
      expiresAt: timestamp,
      refundable: true,
    });
    const result = CancellationResultViewSchema.parse({
      bookingId: 'booking-local-1',
      bookingStatus: 'CANCELLED',
      cancellationStatus: 'COMPLETE',
      refundStatus: 'PENDING',
      refundAmount: '100.00',
    });
    const revision = ItineraryRevisionViewSchema.parse({
      revisionId: 'revision-local-1',
      version: 2,
      observedAt: timestamp,
      isMaterial: true,
      materialReasons: ['SCHEDULE_CHANGE'],
      segments: [segment],
    });
    assert.ok(
      cancellationStatus.bookingId === 'booking-local-1',
      'cancellation status should parse',
    );
    assert.ok(quote.refundable, 'cancellation quote should parse');
    assert.ok(result.refundAmount === '100.00', 'cancellation result should parse');
    assert.ok(revision.version === 2, 'itinerary revision should parse');
  });

  it('parses documented failures and rejects unknown reasons or private fields', () => {
    const outcomeSchema = BookingManagementOutcomeSchema(BookingListViewSchema);
    const failure = outcomeSchema.parse({
      ok: false,
      reason: 'STALE_REVISION',
      message: 'Refresh the booking.',
      retryable: true,
    });
    assert.ok(
      !failure.ok && failure.reason === 'STALE_REVISION',
      'documented failure should parse',
    );
    assert.throws(
      () =>
        outcomeSchema.parse({
          ok: false,
          reason: 'OFFER_EXPIRED',
          message: 'Unexpected reason',
          retryable: false,
        }),
      /invalid_enum_value/i,
    );
    assert.throws(() => BookingListViewSchema.parse({ ...list, duffelOrderId: 'ord_123' }));
    assert.throws(() =>
      BookingDetailViewSchema.parse({ ...detail, stripePaymentIntentId: 'pi_123' }),
    );
    assert.throws(() => BookingDetailViewSchema.parse({ ...detail, rawSnapshot: {} }));
    assert.throws(() =>
      BookingListViewSchema.parse({
        ...list,
        bookings: [{ ...list.bookings[0], providerOfferId: 'off_123' }],
      }),
    );
  });
});

type ListInferenceParity = Assert<typeof list extends BookingListView ? true : false>;
type DetailInferenceParity = Assert<typeof detail extends BookingDetailView ? true : false>;
type OutcomeInferenceParity = Assert<
  Equal<
    BookingManagementOutcome<BookingListView>,
    | { ok: true; data: BookingListView }
    | {
        ok: false;
        reason:
          | 'UNAUTHENTICATED'
          | 'FORBIDDEN'
          | 'NOT_FOUND'
          | 'STALE_REVISION'
          | 'INVALID_COMMAND'
          | 'UPSTREAM_UNAVAILABLE';
        message: string;
        retryable: boolean;
      }
  >
>;

void (0 as unknown as ListInferenceParity);
void (0 as unknown as DetailInferenceParity);
void (0 as unknown as OutcomeInferenceParity);
