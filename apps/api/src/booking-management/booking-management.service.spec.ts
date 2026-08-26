import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { BookingStatus, DisruptionStatus } from '@prisma/client';
import { BookingManagementService, parseDuffelCancellationQuoteId } from './booking-management.service';

describe('BookingManagementService', () => {
  let service: BookingManagementService;
  let prisma: {
    booking: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
    };
  };
  let bookingLifecycleService: {
    checkAndCompleteBooking: jest.Mock;
  };
  let bookingRecoveryService: {
    reconcileBookingIfStale: jest.Mock;
  };

  const originalEnv = process.env.FEATURE_FLAG_DISRUPTION_SURFACING;

  beforeEach(() => {
    prisma = {
      booking: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
      },
    };
    bookingLifecycleService = {
      checkAndCompleteBooking: jest.fn().mockImplementation((booking) => Promise.resolve(booking)),
    };
    bookingRecoveryService = {
      reconcileBookingIfStale: jest.fn().mockImplementation((booking) => Promise.resolve(booking)),
    };

    service = new BookingManagementService(
      prisma as never,
      bookingLifecycleService as never,
      bookingRecoveryService as never,
    );
  });

  afterEach(() => {
    process.env.FEATURE_FLAG_DISRUPTION_SURFACING = originalEnv;
    jest.clearAllMocks();
  });

  describe('parseDuffelCancellationQuoteId', () => {
    it('returns nulls for null/undefined/empty string', () => {
      expect(parseDuffelCancellationQuoteId(null)).toEqual({
        quoteId: null,
        refundTo: null,
        nonRefundableAncillaryAmount: null,
        nonRefundableAncillaryCurrency: null,
      });
      expect(parseDuffelCancellationQuoteId(undefined)).toEqual({
        quoteId: null,
        refundTo: null,
        nonRefundableAncillaryAmount: null,
        nonRefundableAncillaryCurrency: null,
      });
      expect(parseDuffelCancellationQuoteId('')).toEqual({
        quoteId: null,
        refundTo: null,
        nonRefundableAncillaryAmount: null,
        nonRefundableAncillaryCurrency: null,
      });
    });

    it('handles PENDING_QUOTE', () => {
      expect(parseDuffelCancellationQuoteId('PENDING_QUOTE')).toEqual({
        quoteId: 'PENDING_QUOTE',
        refundTo: null,
        nonRefundableAncillaryAmount: null,
        nonRefundableAncillaryCurrency: null,
      });
    });

    it('parses single part quote id', () => {
      expect(parseDuffelCancellationQuoteId('can_quo_123')).toEqual({
        quoteId: 'can_quo_123',
        refundTo: null,
        nonRefundableAncillaryAmount: null,
        nonRefundableAncillaryCurrency: null,
      });
    });

    it('parses pipe-separated full quote metadata', () => {
      expect(parseDuffelCancellationQuoteId('can_quo_123|balance|15.00|USD')).toEqual({
        quoteId: 'can_quo_123',
        refundTo: 'balance',
        nonRefundableAncillaryAmount: '15.00',
        nonRefundableAncillaryCurrency: 'USD',
      });
    });
  });

  describe('listBookings', () => {
    const mockBaseBooking = (overrides: Record<string, unknown> = {}) => ({
      id: 'b-1',
      userId: 'user-1',
      status: BookingStatus.CONFIRMED,
      failureReason: null,
      pnrReference: 'PNR123',
      totalAmount: { toString: () => '350.00' },
      currency: 'USD',
      departureAt: new Date(Date.now() + 86400000),
      createdAt: new Date(),
      flightSnapshot: {
        segments: [
          {
            departureAt: '2026-09-01T10:00:00Z',
            arrivalAt: '2026-09-01T14:00:00Z',
            globalOrder: 1,
          },
        ],
      },
      payment: { id: 'p-1', status: 'SUCCEEDED', stripePaymentIntentId: 'pi-1' },
      bookingIntent: { id: 'bi-1', duffelOfferId: 'off-1' },
      activeDisruptionRevision: null,
      itineraryRevisions: [],
      ...overrides,
    });

    it('queries upcoming bookings with active statuses and departure in the future or null', async () => {
      const b1 = mockBaseBooking({ id: 'b-1', status: BookingStatus.CONFIRMED });
      const b2 = mockBaseBooking({
        id: 'b-2',
        status: BookingStatus.PROCESSING,
        departureAt: null,
      });

      prisma.booking.findMany.mockResolvedValue([b1, b2]);

      const result = await service.listBookings('user-1', 'upcoming', 1, 20);

      expect(prisma.booking.findMany).toHaveBeenCalledWith({
        where: {
          userId: 'user-1',
          status: {
            in: [
              BookingStatus.PROCESSING,
              BookingStatus.CONFIRMED,
              BookingStatus.CANCELLATION_PENDING,
              BookingStatus.CANCELLED_PENDING_REFUND,
              BookingStatus.FAILED,
            ],
          },
          OR: [{ departureAt: null }, { departureAt: { gt: expect.any(Date) } }],
        },
        include: expect.any(Object),
      });

      expect(result.bookings).toHaveLength(2);
      // PROCESSING has priority 0 over CONFIRMED (priority 2)
      expect(result.bookings[0].id).toBe('b-2');
      expect(result.bookings[1].id).toBe('b-1');
      expect(result.pagination).toEqual({
        page: 1,
        limit: 20,
        total: 2,
        totalPages: 1,
      });
    });

    it('queries past bookings and sorts by departureAt descending', async () => {
      const date1 = new Date('2026-06-01T10:00:00Z');
      const date2 = new Date('2026-07-01T10:00:00Z');
      const b1 = mockBaseBooking({
        id: 'b-older',
        status: BookingStatus.COMPLETED,
        departureAt: date1,
      });
      const b2 = mockBaseBooking({
        id: 'b-newer',
        status: BookingStatus.COMPLETED,
        departureAt: date2,
      });

      prisma.booking.findMany.mockResolvedValue([b1, b2]);

      const result = await service.listBookings('user-1', 'past', 1, 20);

      expect(prisma.booking.findMany).toHaveBeenCalledWith({
        where: {
          userId: 'user-1',
          OR: [
            {
              status: {
                in: [
                  BookingStatus.COMPLETED,
                  BookingStatus.CANCELLED_AND_REFUNDED,
                  BookingStatus.CANCELLED_NO_REFUND,
                ],
              },
            },
            {
              status: {
                in: [
                  BookingStatus.PROCESSING,
                  BookingStatus.CONFIRMED,
                  BookingStatus.CANCELLATION_PENDING,
                  BookingStatus.CANCELLED_PENDING_REFUND,
                  BookingStatus.FAILED,
                ],
              },
              departureAt: { lte: expect.any(Date) },
            },
          ],
        },
        include: expect.any(Object),
      });

      expect(result.bookings).toHaveLength(2);
      expect(result.bookings[0].id).toBe('b-newer');
      expect(result.bookings[1].id).toBe('b-older');
    });

    it('paginates bookings correctly (page, limit, total, totalPages, slicing)', async () => {
      const bookings = [
        mockBaseBooking({ id: 'b-1', status: BookingStatus.PROCESSING }),
        mockBaseBooking({ id: 'b-2', status: BookingStatus.FAILED }),
        mockBaseBooking({ id: 'b-3', status: BookingStatus.CONFIRMED, departureAt: new Date('2026-09-01T10:00:00Z') }),
        mockBaseBooking({ id: 'b-4', status: BookingStatus.CONFIRMED, departureAt: new Date('2026-09-02T10:00:00Z') }),
        mockBaseBooking({ id: 'b-5', status: BookingStatus.CONFIRMED, departureAt: new Date('2026-09-03T10:00:00Z') }),
      ];

      prisma.booking.findMany.mockResolvedValue(bookings);

      const result = await service.listBookings('user-1', 'upcoming', 2, 2);

      expect(result.pagination).toEqual({
        page: 2,
        limit: 2,
        total: 5,
        totalPages: 3,
      });
      expect(result.bookings).toHaveLength(2);
      expect(result.bookings[0].id).toBe('b-3');
      expect(result.bookings[1].id).toBe('b-4');
    });

    it('delegates stale check for stale PROCESSING bookings to BookingRecoveryService.reconcileBookingIfStale', async () => {
      const staleDate = new Date(Date.now() - 20 * 60 * 1000); // 20 mins ago
      const recentDate = new Date(Date.now() - 5 * 60 * 1000); // 5 mins ago

      const staleProcessing = mockBaseBooking({
        id: 'stale-proc',
        status: BookingStatus.PROCESSING,
        createdAt: staleDate,
      });
      const recentProcessing = mockBaseBooking({
        id: 'recent-proc',
        status: BookingStatus.PROCESSING,
        createdAt: recentDate,
      });
      const staleConfirmed = mockBaseBooking({
        id: 'stale-conf',
        status: BookingStatus.CONFIRMED,
        createdAt: staleDate,
      });

      prisma.booking.findMany.mockResolvedValue([staleProcessing, recentProcessing, staleConfirmed]);

      await service.listBookings('user-1', 'upcoming', 1, 20);

      expect(bookingRecoveryService.reconcileBookingIfStale).toHaveBeenCalledTimes(1);
      expect(bookingRecoveryService.reconcileBookingIfStale).toHaveBeenCalledWith(staleProcessing);
    });

    it('delegates completion check to BookingLifecycleService.checkAndCompleteBooking for all bookings', async () => {
      const b1 = mockBaseBooking({ id: 'b-1' });
      const b2 = mockBaseBooking({ id: 'b-2' });

      prisma.booking.findMany.mockResolvedValue([b1, b2]);

      await service.listBookings('user-1', 'upcoming', 1, 20);

      expect(bookingLifecycleService.checkAndCompleteBooking).toHaveBeenCalledTimes(2);
      expect(bookingLifecycleService.checkAndCompleteBooking).toHaveBeenCalledWith(b1);
      expect(bookingLifecycleService.checkAndCompleteBooking).toHaveBeenCalledWith(b2);
    });

    it('handles reconciliation error without throwing in listBookings', async () => {
      const staleDate = new Date(Date.now() - 20 * 60 * 1000);
      const staleProcessing = mockBaseBooking({
        id: 'stale-proc',
        status: BookingStatus.PROCESSING,
        createdAt: staleDate,
      });

      prisma.booking.findMany.mockResolvedValue([staleProcessing]);
      bookingRecoveryService.reconcileBookingIfStale.mockRejectedValueOnce(new Error('Stripe timeout'));

      const result = await service.listBookings('user-1', 'upcoming', 1, 20);

      expect(result.bookings).toHaveLength(1);
      expect(result.bookings[0].id).toBe('stale-proc');
    });
  });

  describe('getBookingDetail', () => {
    const mockDetailBooking = (overrides: Record<string, unknown> = {}) => ({
      id: 'booking-1',
      userId: 'user-1',
      status: BookingStatus.CONFIRMED,
      failureReason: null,
      pnrReference: 'PNRXYZ',
      duffelOrderId: 'ord_123',
      totalAmount: { toString: () => '500.00' },
      currency: 'GBP',
      departureAt: new Date('2026-09-15T08:00:00Z'),
      flightSnapshot: {
        segments: [
          {
            departureAt: '2026-09-15T08:00:00Z',
            arrivalAt: '2026-09-15T11:00:00Z',
            globalOrder: 1,
          },
        ],
      },
      passengerSnapshot: [{ given_name: 'Jane', family_name: 'Doe' }],
      payment: {
        id: 'pay-1',
        status: 'SUCCEEDED',
        stripePaymentIntentId: 'pi_test_123',
        ancillarySelection: null,
      },
      bookingIntent: {
        id: 'intent-1',
        duffelOfferId: 'off_test_123',
        passengers: [
          { id: 'pass-1', givenName: 'Jane', familyName: 'Doe' },
        ],
      },
      cancellationDeadline: new Date('2026-09-10T00:00:00Z'),
      cancellationRefundable: true,
      airlineRefundAmount: { toString: () => '400.00' },
      customerRefundAmount: { toString: () => '400.00' },
      duffelCancellationQuoteId: 'can_quo_789|balance|25.00|GBP',
      createdAt: new Date('2026-08-01T10:00:00Z'),
      updatedAt: new Date('2026-08-02T10:00:00Z'),
      disruptionStatus: null,
      activeDisruptionRevision: null,
      itineraryRevisions: [],
      ...overrides,
    });

    it('throws NotFoundException if booking not found', async () => {
      prisma.booking.findUnique.mockResolvedValue(null);

      await expect(service.getBookingDetail('non-existent', 'user-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('throws ForbiddenException if userId does not match', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        mockDetailBooking({ userId: 'another-user' }),
      );

      await expect(service.getBookingDetail('booking-1', 'user-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('correctly maps ancillary summaries (seats, baggage) with passenger names', async () => {
      const bookingWithAncillaries = mockDetailBooking({
        payment: {
          id: 'pay-1',
          status: 'SUCCEEDED',
          stripePaymentIntentId: 'pi_1',
          ancillarySelection: {
            seatSelections: [
              {
                intentPassengerId: 'pass-1',
                segmentId: 'seg-1',
                seatDesignator: '12A',
                amount: { toString: () => '30.00' },
                currency: 'GBP',
              },
            ],
            baggageSelections: [
              {
                intentPassengerId: 'pass-1',
                type: 'CHECKED',
                quantity: 1,
                amount: { toString: () => '45.00' },
                currency: 'GBP',
              },
              {
                intentPassengerId: 'pass-unknown',
                type: 'CARRY_ON',
                quantity: 1,
                amount: { toString: () => '20.00' },
                currency: 'GBP',
              },
            ],
          },
        },
      });

      prisma.booking.findUnique.mockResolvedValue(bookingWithAncillaries);

      const result = await service.getBookingDetail('booking-1', 'user-1');

      expect(result.ancillarySummary).toBeDefined();
      expect(result.ancillarySummary?.seats).toEqual([
        {
          intentPassengerId: 'pass-1',
          passengerName: 'Jane Doe',
          segmentId: 'seg-1',
          seatDesignator: '12A',
          amount: '30.00',
          currency: 'GBP',
        },
      ]);
      expect(result.ancillarySummary?.baggage).toEqual([
        {
          intentPassengerId: 'pass-1',
          passengerName: 'Jane Doe',
          type: 'CHECKED',
          quantity: 1,
          amount: '45.00',
          currency: 'GBP',
        },
        {
          intentPassengerId: 'pass-unknown',
          passengerName: '',
          type: 'CARRY_ON',
          quantity: 1,
          amount: '20.00',
          currency: 'GBP',
        },
      ]);
    });

    it('builds disruption and itinerary with FEATURE_FLAG_DISRUPTION_SURFACING=true', async () => {
      process.env.FEATURE_FLAG_DISRUPTION_SURFACING = 'true';

      const bookingWithDisruption = mockDetailBooking({
        disruptionStatus: DisruptionStatus.DETECTED,
        activeDisruptionRevisionId: 'rev-1',
        disruptionResolvedReason: null,
        disruptionResolvedAt: null,
        activeDisruptionRevision: {
          id: 'rev-1',
          isMaterial: true,
          materialReasons: ['DELAY_EXCEEDS_THRESHOLD'],
          incrementalDiff: { presentationSummary: { delayMinutes: 90 } },
          cumulativeDiff: { presentationSummary: { delayMinutes: 90 } },
          notificationOutbox: { stabilizationWarning: true },
        },
        itineraryRevisions: [
          {
            id: 'rev-1',
            version: 1,
            segments: [
              {
                airlineName: 'British Airways',
                marketingCarrierIata: 'BA',
                flightNumber: 'BA123',
                departureAirportIata: 'LHR',
                departureAirportName: 'Heathrow',
                departureCity: 'London',
                departureTerminal: '5',
                arrivalAirportIata: 'JFK',
                arrivalAirportName: 'John F Kennedy',
                arrivalCity: 'New York',
                arrivalTerminal: '7',
                departureAt: new Date('2026-09-15T09:30:00Z'),
                arrivalAt: new Date('2026-09-15T12:30:00Z'),
                durationMinutes: 480,
                aircraftType: '777',
                duffelSegmentId: 'seg_rev_1',
                sliceOrder: 0,
                segmentOrder: 0,
                globalOrder: 1,
              },
            ],
          },
        ],
      });

      prisma.booking.findUnique.mockResolvedValue(bookingWithDisruption);

      const result = await service.getBookingDetail('booking-1', 'user-1');

      expect(result.currentItinerary.source).toBe('REVISION');
      expect(result.currentItinerary.revisionId).toBe('rev-1');
      expect(result.currentItinerary.version).toBe(1);
      expect(result.currentItinerary.segments[0].flightNumber).toBe('BA123');
      expect(result.disruption).toEqual({
        status: 'DETECTED',
        activeRevisionId: 'rev-1',
        isMaterial: true,
        materialReasons: ['DELAY_EXCEEDS_THRESHOLD'],
        incrementalSummary: { delayMinutes: 90 },
        cumulativeSummary: { delayMinutes: 90 },
        stabilizationWarning: true,
        resolvedReason: null,
        resolvedAt: null,
      });
    });

    it('builds fallback original itinerary and disruption with FEATURE_FLAG_DISRUPTION_SURFACING=false', async () => {
      process.env.FEATURE_FLAG_DISRUPTION_SURFACING = 'false';

      const bookingWithDisruption = mockDetailBooking({
        disruptionStatus: DisruptionStatus.DETECTED,
        activeDisruptionRevisionId: 'rev-1',
        itineraryRevisions: [{ id: 'rev-1', version: 1, segments: [] }],
      });

      prisma.booking.findUnique.mockResolvedValue(bookingWithDisruption);

      const result = await service.getBookingDetail('booking-1', 'user-1');

      expect(result.currentItinerary.source).toBe('ORIGINAL');
      expect(result.currentItinerary.revisionId).toBeNull();
      expect(result.disruption.status).toBe('NONE');
    });

    it('parses Duffel cancellation quote ID correctly in booking detail', async () => {
      const booking = mockDetailBooking({
        duffelCancellationQuoteId: 'can_quo_999|card|0.00|USD',
      });
      prisma.booking.findUnique.mockResolvedValue(booking);

      const result = await service.getBookingDetail('booking-1', 'user-1');

      expect(result.duffelCancellationQuoteId).toBe('can_quo_999');
    });

    it('delegates stale check and completion check in getBookingDetail', async () => {
      const booking = mockDetailBooking();
      prisma.booking.findUnique.mockResolvedValue(booking);

      await service.getBookingDetail('booking-1', 'user-1');

      expect(bookingRecoveryService.reconcileBookingIfStale).toHaveBeenCalledWith(booking);
      expect(bookingLifecycleService.checkAndCompleteBooking).toHaveBeenCalledWith(booking);
    });
  });
});
