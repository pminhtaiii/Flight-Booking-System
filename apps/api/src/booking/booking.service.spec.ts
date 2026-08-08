import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BookingService } from './booking.service';

describe('BookingService', () => {
  it('creates a processing booking from the booking intent price and currency', async () => {
    const prisma = {
      bookingIntent: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'intent-1',
          userId: 'user-1',
          confirmedPrice: { toString: () => '450.00' },
          currency: 'GBP',
        }),
      },
      booking: {
        create: jest.fn().mockResolvedValue({ id: 'booking-1', status: 'PROCESSING' }),
      },
    };
    const service = new BookingService(prisma as never, {} as never, {} as never, {} as never);

    await expect(service.createBooking('user-1', 'booking-1', 'intent-1')).resolves.toEqual({
      id: 'booking-1',
      status: 'PROCESSING',
    });
    expect(prisma.booking.create).toHaveBeenCalledWith({
      data: {
        id: 'booking-1',
        userId: 'user-1',
        bookingIntentId: 'intent-1',
        totalAmount: '450.00',
        currency: 'GBP',
        status: 'PROCESSING',
        paymentId: null,
      },
    });
  });

  it('returns paginated upcoming bookings with processing bookings first', async () => {
    const prisma = {
      booking: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'confirmed', status: 'CONFIRMED', failureReason: null, pnrReference: 'PNR1', totalAmount: { toString: () => '450.00' }, currency: 'GBP', departureAt: new Date('2026-09-01T10:00:00Z'), flightSnapshot: null, createdAt: new Date('2026-07-20T10:00:00Z'), payment: null, bookingIntent: { id: 'intent-1', duffelOfferId: 'offer-1' },
          },
          {
            id: 'processing', status: 'PROCESSING', failureReason: null, pnrReference: null, totalAmount: { toString: () => '250.00' }, currency: 'GBP', departureAt: null, flightSnapshot: null, createdAt: new Date('2026-07-20T11:00:00Z'), payment: null, bookingIntent: { id: 'intent-2', duffelOfferId: 'offer-2' },
          },
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const service = new BookingService(prisma as never, {} as never, {} as never, {} as never);

    await expect(service.listBookings('user-1', 'upcoming', 1, 20)).resolves.toEqual({
      bookings: [
        expect.objectContaining({ id: 'processing', status: 'PROCESSING', departureAt: null }),
        expect.objectContaining({ id: 'confirmed', status: 'CONFIRMED', departureAt: '2026-09-01T10:00:00.000Z' }),
      ],
      pagination: { page: 1, limit: 20, total: 2, totalPages: 1 },
    });
  });

  it('does not disclose another user\'s booking detail', async () => {
    const prisma = {
      booking: {
        findUnique: jest.fn().mockResolvedValue({ id: 'booking-1', userId: 'other-user' }),
      },
    };
    const service = new BookingService(prisma as never, {} as never, {} as never, {} as never);

    await expect(service.getBookingDetail('booking-1', 'user-1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('reports a missing booking detail as not found', async () => {
    const prisma = { booking: { findUnique: jest.fn().mockResolvedValue(null) } };
    const service = new BookingService(prisma as never, {} as never, {} as never, {} as never);

    await expect(service.getBookingDetail('missing', 'user-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reports a permanent cancellation refund failure without claiming it is pending', async () => {
    const failedBooking = {
      id: 'booking-1',
      userId: 'user-1',
      status: 'FAILED',
      failureReason: 'SYSTEM_ERROR',
      duffelOrderId: 'ord-1',
      duffelCancellationQuoteId: 'quote-1',
      cancellationDeadline: new Date(Date.now() + 60_000),
      customerRefundAmount: { toString: () => '125.00' },
    };
    const prisma = {
      booking: {
        findUnique: jest.fn().mockResolvedValue(failedBooking),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const service = new BookingService(prisma as never, {} as never, {} as never, {} as never);

    await expect(service.cancelBooking('booking-1', 'user-1', 'quote-1')).resolves.toEqual({
      bookingId: 'booking-1',
      bookingStatus: 'FAILED',
      cancellationStatus: 'FAILED',
      duffelCancellationQuoteId: 'quote-1',
      refundStatus: 'REFUND_FAILED_NEEDS_ATTENTION',
      refundAmount: '125.00',
    });
  });

  describe('concurrency and validation', () => {
    it('recovers a failed booking when the capture path has authoritative order data', async () => {
      const prisma = {
        booking: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUnique: jest.fn().mockResolvedValue({ id: 'booking-1', status: 'CONFIRMED' }),
        },
      };
      const service = new BookingService(prisma as never, {} as never, {} as never, {} as never);
      const flightSnapshot = {
        segments: [{ departureAt: '2026-09-01T10:00:00.000Z' }],
        totalDuration: 'PT2H',
        stops: 0,
        cabinClass: 'economy',
      };

      await expect(service.updateToConfirmed('booking-1', 'PNR1', 'order-1', flightSnapshot as any, {} as any)).resolves.toEqual({
        id: 'booking-1',
        status: 'CONFIRMED',
      });
      expect(prisma.booking.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'booking-1', status: { in: ['PROCESSING', 'FAILED'] } },
      }));
    });

    it('does not overwrite a terminal booking while recording a failure', async () => {
      const prisma = {
        booking: {
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
          findUnique: jest.fn().mockResolvedValue({ id: 'booking-1', status: 'CONFIRMED' }),
        },
      };
      const service = new BookingService(prisma as never, {} as never, {} as never, {} as never);

      await expect(service.updateToFailed('booking-1', 'BOOKING_TIMEOUT')).resolves.toEqual({
        id: 'booking-1',
        status: 'CONFIRMED',
      });
      expect(prisma.booking.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'booking-1', status: 'PROCESSING' },
      }));
    });

    it('throws when a booking is deleted after the conditional terminal update', async () => {
      const prisma = {
        booking: {
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
          findUnique: jest.fn().mockResolvedValue(null),
        },
      };
      const service = new BookingService(prisma as never, {} as never, {} as never, {} as never);

      await expect(service.updateToFailed('missing-booking', 'BOOKING_TIMEOUT')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws when a booking is deleted after the conditional confirmation update', async () => {
      const prisma = {
        booking: {
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
          findUnique: jest.fn().mockResolvedValue(null),
        },
      };
      const service = new BookingService(prisma as never, {} as never, {} as never, {} as never);
      const flightSnapshot = {
        segments: [{ departureAt: '2026-09-01T10:00:00.000Z' }],
        totalDuration: 'PT2H',
        stops: 0,
        cabinClass: 'economy',
      };

      await expect(
        service.updateToConfirmed('missing-booking', 'PNR1', 'order-1', flightSnapshot as any, {} as any),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('handles unique-constraint violation and returns existing booking if owned by caller', async () => {
      const error = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.14.0',
      });
      const prisma = {
        bookingIntent: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'intent-1',
            userId: 'user-1',
            confirmedPrice: { toString: () => '450.00' },
            currency: 'GBP',
          }),
        },
        booking: {
          create: jest.fn().mockRejectedValue(error),
          findFirst: jest.fn().mockResolvedValue({
            id: 'booking-1',
            userId: 'user-1',
            status: 'PROCESSING',
          }),
        },
      };
      const service = new BookingService(prisma as never, {} as never, {} as never, {} as never);

      await expect(service.createBooking('user-1', 'booking-1', 'intent-1')).resolves.toEqual({
        id: 'booking-1',
        userId: 'user-1',
        status: 'PROCESSING',
      });
    });

    it('handles unique-constraint violation and throws ForbiddenException if booking is owned by another user', async () => {
      const error = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.14.0',
      });
      const prisma = {
        bookingIntent: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'intent-1',
            userId: 'user-1',
            confirmedPrice: { toString: () => '450.00' },
            currency: 'GBP',
          }),
        },
        booking: {
          create: jest.fn().mockRejectedValue(error),
          findFirst: jest.fn().mockResolvedValue({
            id: 'booking-1',
            userId: 'other-user',
            status: 'PROCESSING',
          }),
        },
      };
      const service = new BookingService(prisma as never, {} as never, {} as never, {} as never);

      await expect(service.createBooking('user-1', 'booking-1', 'intent-1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('throws BadRequestException in updateToConfirmed if flightSnapshot has no segments', async () => {
      const prisma = {};
      const service = new BookingService(prisma as never, {} as never, {} as never, {} as never);

      const flightSnapshot = {
        segments: [],
        totalDuration: 'PT2H',
        stops: 0,
        cabinClass: 'Economy',
      };

      await expect(
        service.updateToConfirmed('booking-1', 'PNR1', 'order-1', flightSnapshot as any, {} as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    describe('getCancellationQuote', () => {
      beforeEach(() => {
        jest.spyOn(global, 'setTimeout').mockImplementation((fn: any) => {
          if (typeof fn === 'function') fn();
          return 0 as any;
        });
      });

      afterEach(() => {
        jest.restoreAllMocks();
      });

      it('returns existing cached quote if non-expired', async () => {
        const futureDate = new Date(Date.now() + 3600000);
        const booking = {
          id: 'b-1',
          userId: 'u-1',
          status: 'CONFIRMED',
          duffelOrderId: 'ord-1',
          duffelCancellationQuoteId: 'quote-cached',
          cancellationDeadline: futureDate,
          customerRefundAmount: '100.00',
          currency: 'GBP',
          cancellationRefundable: true,
        };
        const prisma = {
          booking: {
            findUnique: jest.fn().mockResolvedValue(booking),
          },
        };
        const service = new BookingService(prisma as never, {} as never, {} as never, {} as never);

        const result = await service.getCancellationQuote('b-1', 'u-1');
        expect(result.quoteId).toBe('quote-cached');
      });

      it('creates new quote and updates booking when no quote exists', async () => {
        const booking = {
          id: 'b-1',
          userId: 'u-1',
          status: 'CONFIRMED',
          duffelOrderId: 'ord-1',
          duffelCancellationQuoteId: null,
          cancellationDeadline: null,
          currency: 'GBP',
        };
        const prisma = {
          booking: {
            findUnique: jest.fn().mockResolvedValue(booking),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
        };
        const duffelService = {
          createCancellationQuote: jest.fn().mockResolvedValue({
            id: 'quote-new',
            refund_amount: '100.00',
            refund_currency: 'GBP',
            expires_at: new Date(Date.now() + 3600000).toISOString(),
            refundable: true,
          }),
        };
        const service = new BookingService(prisma as never, {} as never, duffelService as never, {} as never);

        const result = await service.getCancellationQuote('b-1', 'u-1');
        expect(result.quoteId).toBe('quote-new');
        expect(prisma.booking.updateMany).toHaveBeenNthCalledWith(1, {
          where: {
            id: 'b-1',
            status: 'CONFIRMED',
            OR: [
              { duffelCancellationQuoteId: null },
              {
                cancellationDeadline: { lte: expect.any(Date) },
                duffelCancellationQuoteId: { not: 'PENDING_QUOTE' },
              },
            ],
          },
          data: {
            duffelCancellationQuoteId: 'PENDING_QUOTE',
          },
        });
        expect(prisma.booking.updateMany).toHaveBeenNthCalledWith(2, {
          where: {
            id: 'b-1',
            status: 'CONFIRMED',
            duffelCancellationQuoteId: 'PENDING_QUOTE',
          },
          data: expect.objectContaining({
            duffelCancellationQuoteId: 'quote-new|||',
          }),
        });
      });

      it('preserves supplier refund destination and disclosed non-refundable ancillary value', async () => {
        const booking = {
          id: 'b-1', userId: 'u-1', status: 'CONFIRMED', duffelOrderId: 'ord-1',
          duffelCancellationQuoteId: null, cancellationDeadline: null, currency: 'GBP',
        };
        const prisma = {
          booking: {
            findUnique: jest.fn().mockResolvedValue(booking),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
        };
        const duffelService = {
          createCancellationQuote: jest.fn().mockResolvedValue({
            id: 'quote-new', refund_amount: '80.00', refund_currency: 'GBP', refund_to: 'airline_credits',
            non_refundable_ancillary_amount: '20.00', non_refundable_ancillary_currency: 'GBP',
            expires_at: new Date(Date.now() + 3600000).toISOString(), refundable: true,
          }),
        };
        const service = new BookingService(prisma as never, {} as never, duffelService as never, {} as never);

        await expect(service.getCancellationQuote('b-1', 'u-1')).resolves.toMatchObject({
          refundAmount: '80.00', currency: 'GBP', refundTo: 'airline_credits',
          nonRefundableAncillaryAmount: '20.00', nonRefundableAncillaryCurrency: 'GBP',
        });
      });

      it('reverts PENDING_QUOTE to null on Duffel API failure', async () => {
        const booking = {
          id: 'b-1',
          userId: 'u-1',
          status: 'CONFIRMED',
          duffelOrderId: 'ord-1',
          duffelCancellationQuoteId: null,
          cancellationDeadline: null,
          currency: 'GBP',
        };
        const prisma = {
          booking: {
            findUnique: jest.fn().mockResolvedValue(booking),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
        };
        const duffelService = {
          createCancellationQuote: jest.fn().mockRejectedValue(new Error('Duffel API error')),
        };
        const service = new BookingService(prisma as never, {} as never, duffelService as never, {} as never);

        await expect(service.getCancellationQuote('b-1', 'u-1')).rejects.toThrow('Duffel API error');
        expect(prisma.booking.updateMany).toHaveBeenNthCalledWith(2, {
          where: {
            id: 'b-1',
            duffelCancellationQuoteId: 'PENDING_QUOTE',
          },
          data: {
            duffelCancellationQuoteId: null,
          },
        });
      });

      it('returns updated booking quote if updateMany count is 0 but concurrent request populated valid quote', async () => {
        const booking = {
          id: 'b-1',
          userId: 'u-1',
          status: 'CONFIRMED',
          duffelOrderId: 'ord-1',
          duffelCancellationQuoteId: null,
          cancellationDeadline: null,
          currency: 'GBP',
        };
        const futureDate = new Date(Date.now() + 3600000);
        const concurrentBooking = {
          id: 'b-1',
          duffelOrderId: 'ord-1',
          duffelCancellationQuoteId: 'quote-concurrent',
          cancellationDeadline: futureDate,
          customerRefundAmount: '100.00',
          currency: 'GBP',
          cancellationRefundable: true,
        };
        const prisma = {
          booking: {
            findUnique: jest
              .fn()
              .mockResolvedValueOnce(booking)
              .mockResolvedValueOnce(concurrentBooking),
            updateMany: jest.fn().mockResolvedValue({ count: 0 }),
          },
        };
        const duffelService = {
          createCancellationQuote: jest.fn(),
        };
        const service = new BookingService(prisma as never, {} as never, duffelService as never, {} as never);

        const result = await service.getCancellationQuote('b-1', 'u-1');
        expect(result.quoteId).toBe('quote-concurrent');
      });

      it('throws BadRequestException if updateMany count is 0 and no valid quote in updated booking', async () => {
        const booking = {
          id: 'b-1',
          userId: 'u-1',
          status: 'CONFIRMED',
          duffelOrderId: 'ord-1',
          duffelCancellationQuoteId: null,
          cancellationDeadline: null,
          currency: 'GBP',
        };
        const cancelledBooking = {
          id: 'b-1',
          status: 'CANCELLED_AND_REFUNDED',
          duffelCancellationQuoteId: null,
        };
        const prisma = {
          booking: {
            findUnique: jest
              .fn()
              .mockResolvedValueOnce(booking)
              .mockResolvedValue(cancelledBooking),
            updateMany: jest.fn().mockResolvedValue({ count: 0 }),
          },
        };

        const duffelService = {
          createCancellationQuote: jest.fn(),
        };
        const service = new BookingService(prisma as never, {} as never, duffelService as never, {} as never);

        await expect(service.getCancellationQuote('b-1', 'u-1')).rejects.toThrow(
          'Booking state changed or quote creation in progress',
        );
      });
    });
  });
});
