import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { BookingStatus, Prisma, RefundStatus } from '@prisma/client';
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

  it('returns paginated upcoming bookings by delegating to bookingManagementService', async () => {
    const bookingManagementService = {
      listBookings: jest.fn().mockResolvedValue({
        bookings: [
          { id: 'processing', status: 'PROCESSING', departureAt: null },
          { id: 'confirmed', status: 'CONFIRMED', departureAt: '2026-09-01T10:00:00.000Z' },
        ],
        pagination: { page: 1, limit: 20, total: 2, totalPages: 1 },
      }),
    };
    const service = new BookingService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      bookingManagementService as never,
    );

    await expect(service.listBookings('user-1', 'upcoming', 1, 20)).resolves.toEqual({
      bookings: [
        expect.objectContaining({ id: 'processing', status: 'PROCESSING', departureAt: null }),
        expect.objectContaining({ id: 'confirmed', status: 'CONFIRMED', departureAt: '2026-09-01T10:00:00.000Z' }),
      ],
      pagination: { page: 1, limit: 20, total: 2, totalPages: 1 },
    });
    expect(bookingManagementService.listBookings).toHaveBeenCalledWith('user-1', 'upcoming', 1, 20);
  });

  it('delegates getBookingDetail to bookingManagementService', async () => {
    const bookingManagementService = {
      getBookingDetail: jest.fn().mockResolvedValue({ id: 'booking-1', status: 'CONFIRMED' }),
    };
    const service = new BookingService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      bookingManagementService as never,
    );

    await expect(service.getBookingDetail('booking-1', 'user-1')).resolves.toEqual({
      id: 'booking-1',
      status: 'CONFIRMED',
    });
    expect(bookingManagementService.getBookingDetail).toHaveBeenCalledWith('booking-1', 'user-1');
  });


  describe('getCancellationStatus refund projection', () => {
    const baseBooking = {
      id: 'booking-1',
      userId: 'user-1',
      status: BookingStatus.CANCELLED_PENDING_REFUND,
      updatedAt: new Date('2026-08-23T12:00:00.000Z'),
      cancellationDeadline: null,
      airlineRefundAmount: { toString: () => '100.00' },
      customerRefundAmount: { toString: () => '100.00' },
      duffelCancellationQuoteId: 'quote-1',
    };
    const refund = (overrides: Record<string, unknown>) => ({
      id: 'refund-1',
      status: RefundStatus.REFUND_PENDING,
      amount: 0,
      retryCount: 0,
      nextRetryAt: null,
      lastErrorCode: null,
      updatedAt: new Date('2026-08-23T11:00:00.000Z'),
      ...overrides,
    });

    it('reports SUCCEEDED for a fulfilled booking even when stale failed and retrying transactions remain linked', async () => {
      const prisma = {
        booking: {
          findUnique: jest.fn().mockResolvedValue({
            ...baseBooking,
            status: BookingStatus.CANCELLED_AND_REFUNDED,
            cancellationRefundObligation: {
              totalAmount: 10_000,
              refunds: [
                refund({ id: 'refund-succeeded', status: RefundStatus.SUCCEEDED, amount: 10_000 }),
                refund({ id: 'refund-retrying', status: RefundStatus.REFUND_RETRY_SCHEDULED, retryCount: 2, nextRetryAt: new Date('2026-08-24T11:00:00.000Z') }),
                refund({ id: 'refund-failed', status: RefundStatus.FAILED, lastErrorCode: 'STALE_FAILURE' }),
              ],
            },
          }),
        },
      };
      const service = new BookingService(prisma as never, {} as never, {} as never, {} as never);

      await expect(service.getCancellationStatus('booking-1', 'user-1')).resolves.toMatchObject({
        refundStatus: RefundStatus.SUCCEEDED,
        retryCount: null,
        nextRetryAt: null,
        lastErrorCode: null,
      });
      expect(prisma.booking.findUnique).toHaveBeenCalledWith(expect.objectContaining({
        include: {
          cancellationRefundObligation: {
            include: {
              refunds: {
                orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
              },
            },
          },
        },
      }));
    });

    it('prioritizes the active processing transaction over partial success and terminal failures', async () => {
      const prisma = {
        booking: {
          findUnique: jest.fn().mockResolvedValue({
            ...baseBooking,
            cancellationRefundObligation: {
              totalAmount: 10_000,
              refunds: [
                refund({ id: 'refund-succeeded', status: RefundStatus.SUCCEEDED, amount: 3_000 }),
                refund({ id: 'refund-scheduled', status: RefundStatus.REFUND_RETRY_SCHEDULED, retryCount: 2, nextRetryAt: new Date('2026-08-24T11:00:00.000Z'), lastErrorCode: 'RATE_LIMIT' }),
                refund({ id: 'refund-processing', status: RefundStatus.REFUND_PROCESSING, retryCount: 3, lastErrorCode: 'PROVIDER_DELAY' }),
                refund({ id: 'refund-attention', status: RefundStatus.REFUND_FAILED_NEEDS_ATTENTION, lastErrorCode: 'STALE_FAILURE' }),
              ],
            },
          }),
        },
      };
      const service = new BookingService(prisma as never, {} as never, {} as never, {} as never);

      await expect(service.getCancellationStatus('booking-1', 'user-1')).resolves.toMatchObject({
        refundStatus: RefundStatus.REFUND_PROCESSING,
        retryCount: 3,
        nextRetryAt: null,
        lastErrorCode: 'PROVIDER_DELAY',
        escalationMessage: null,
      });
    });

    it('does not treat a partial success as fulfilled and surfaces the terminal attention transaction', async () => {
      const prisma = {
        booking: {
          findUnique: jest.fn().mockResolvedValue({
            ...baseBooking,
            // The aggregate is authoritative while an obligation exists, even if
            // a stale booking projection still says the cancellation is complete.
            status: BookingStatus.CANCELLED_AND_REFUNDED,
            cancellationRefundObligation: {
              totalAmount: 10_000,
              refunds: [
                refund({ id: 'refund-partial', status: RefundStatus.SUCCEEDED, amount: 3_000 }),
                refund({ id: 'refund-attention', status: RefundStatus.REFUND_FAILED_NEEDS_ATTENTION, lastErrorCode: 'PROVIDER_DECLINED' }),
              ],
            },
          }),
        },
      };
      const service = new BookingService(prisma as never, {} as never, {} as never, {} as never);

      await expect(service.getCancellationStatus('booking-1', 'user-1')).resolves.toMatchObject({
        refundStatus: RefundStatus.REFUND_FAILED_NEEDS_ATTENTION,
        lastErrorCode: 'PROVIDER_DECLINED',
      });
    });

    it('reports NOT_REQUIRED with no provider metadata for a zero-value obligation', async () => {
      const prisma = {
        booking: {
          findUnique: jest.fn().mockResolvedValue({
            ...baseBooking,
            status: BookingStatus.CANCELLED_NO_REFUND,
            cancellationRefundObligation: {
              totalAmount: 0,
              refunds: [],
            },
          }),
        },
      };
      const service = new BookingService(prisma as never, {} as never, {} as never, {} as never);

      await expect(service.getCancellationStatus('booking-1', 'user-1')).resolves.toMatchObject({
        refundStatus: 'NOT_REQUIRED',
        retryCount: null,
        nextRetryAt: null,
        lastErrorCode: null,
      });
    });
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

  it('aborts cancellation persistence before a provider refund when obligation auditing fails in the transaction', async () => {
    const transactionClient = {
      booking: {
        findUnique: jest.fn().mockResolvedValue({
          status: BookingStatus.CANCELLATION_PENDING,
          disruptionStatus: null,
          activeDisruptionRevisionId: null,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      cancellationRefundObligation: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({ id: 'obligation-1' }),
      },
      auditLog: {
        create: jest.fn().mockRejectedValue(new Error('audit write failed')),
      },
    };
    let committed = false;
    const booking = {
      id: 'booking-1',
      userId: 'user-1',
      status: BookingStatus.CONFIRMED,
      duffelOrderId: 'order-1',
      duffelCancellationQuoteId: 'quote-1',
      cancellationDeadline: new Date(Date.now() + 60_000),
      customerRefundAmount: { toString: () => '100.00' },
      cancellationRefundable: true,
      currency: 'USD',
      payment: { id: 'payment-1' },
    };
    const prisma = {
      booking: {
        findUnique: jest.fn().mockResolvedValue(booking),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn().mockImplementation(async (callback: (tx: typeof transactionClient) => Promise<unknown>) => {
        const result = await callback(transactionClient);
        committed = true;
        return result;
      }),
    };
    const paymentRefundService = {
      processCancellationRefund: jest.fn(),
    };
    const duffelService = {
      retrieveOrder: jest.fn().mockResolvedValue({ status: 'CANCELLED' }),
    };
    const service = new BookingService(
      prisma as never,
      {} as never,
      duffelService as never,
      paymentRefundService as never,
    );

    await expect(service.cancelBooking('booking-1', 'user-1', 'quote-1')).rejects.toThrow('audit write failed');

    expect(transactionClient.cancellationRefundObligation.upsert).toHaveBeenCalledTimes(1);
    expect(transactionClient.auditLog.create).toHaveBeenCalledTimes(1);
    expect(paymentRefundService.processCancellationRefund).not.toHaveBeenCalled();
    expect(committed).toBe(false);
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
          findUnique: jest.fn().mockImplementation(async ({ where }) => {
            if (where?.bookingIntentId === 'intent-1') {
              return {
                id: 'booking-1',
                userId: 'user-1',
                bookingIntentId: 'intent-1',
                status: 'PROCESSING',
              };
            }
            return null;
          }),
        },
      };
      const service = new BookingService(prisma as never, {} as never, {} as never, {} as never);

      await expect(service.createBooking('user-1', 'booking-1', 'intent-1')).resolves.toEqual({
        id: 'booking-1',
        userId: 'user-1',
        bookingIntentId: 'intent-1',
        status: 'PROCESSING',
      });
      expect(prisma.booking.findUnique).toHaveBeenCalledWith({
        where: {
          bookingIntentId: 'intent-1',
        },
      });
    });

    it('recovers canonical booking by bookingIntentId when bookingId collides with a different booking', async () => {
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
          findUnique: jest.fn().mockImplementation(async ({ where }) => {
            if (where?.bookingIntentId === 'intent-1') {
              return {
                id: 'canonical-booking-id',
                userId: 'user-1',
                bookingIntentId: 'intent-1',
                status: 'PROCESSING',
              };
            }
            if (where?.id === 'colliding-booking-id') {
              return {
                id: 'colliding-booking-id',
                userId: 'user-2',
                bookingIntentId: 'intent-other',
                status: 'PROCESSING',
              };
            }
            return null;
          }),
        },
      };
      const service = new BookingService(prisma as never, {} as never, {} as never, {} as never);

      await expect(
        service.createBooking('user-1', 'colliding-booking-id', 'intent-1'),
      ).resolves.toEqual({
        id: 'canonical-booking-id',
        userId: 'user-1',
        bookingIntentId: 'intent-1',
        status: 'PROCESSING',
      });
      expect(prisma.booking.findUnique).toHaveBeenCalledWith({
        where: { bookingIntentId: 'intent-1' },
      });
      expect(prisma.booking.findUnique).not.toHaveBeenCalledWith({
        where: { id: 'colliding-booking-id' },
      });
    });

    it('handles unique-constraint violation and updates paymentId on existing.id when paymentId is provided', async () => {
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
          findUnique: jest.fn().mockImplementation(async ({ where }) => {
            if (where?.bookingIntentId === 'intent-1') {
              return {
                id: 'existing-booking-id',
                userId: 'user-1',
                bookingIntentId: 'intent-1',
                status: 'PROCESSING',
                paymentId: null,
              };
            }
            return null;
          }),
          update: jest.fn().mockResolvedValue({
            id: 'existing-booking-id',
            userId: 'user-1',
            bookingIntentId: 'intent-1',
            status: 'PROCESSING',
            paymentId: 'pay-123',
          }),
        },
      };
      const service = new BookingService(prisma as never, {} as never, {} as never, {} as never);

      const result = await service.createBooking('user-1', 'booking-1', 'intent-1', 'pay-123');
      expect(result).toEqual({
        id: 'existing-booking-id',
        userId: 'user-1',
        bookingIntentId: 'intent-1',
        status: 'PROCESSING',
        paymentId: 'pay-123',
      });
      expect(prisma.booking.update).toHaveBeenCalledWith({
        where: { id: 'existing-booking-id' },
        data: { paymentId: 'pay-123' },
      });
    });

    it('handles unique-constraint violation and updates paymentId when existingById is found', async () => {
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
          findUnique: jest.fn().mockImplementation(async ({ where }) => {
            if (where?.bookingIntentId === 'intent-1') {
              return null;
            }
            if (where?.id === 'booking-1') {
              return {
                id: 'booking-1',
                userId: 'user-1',
                bookingIntentId: 'intent-1',
                status: 'PROCESSING',
                paymentId: null,
              };
            }
            return null;
          }),
          update: jest.fn().mockResolvedValue({
            id: 'booking-1',
            userId: 'user-1',
            bookingIntentId: 'intent-1',
            status: 'PROCESSING',
            paymentId: 'pay-123',
          }),
        },
      };
      const service = new BookingService(prisma as never, {} as never, {} as never, {} as never);

      const result = await service.createBooking('user-1', 'booking-1', 'intent-1', 'pay-123');
      expect(result).toEqual({
        id: 'booking-1',
        userId: 'user-1',
        bookingIntentId: 'intent-1',
        status: 'PROCESSING',
        paymentId: 'pay-123',
      });
      expect(prisma.booking.update).toHaveBeenCalledWith({
        where: { id: 'booking-1' },
        data: { paymentId: 'pay-123' },
      });
    });

    it('handles unique-constraint violation and throws BadRequestException if booking intent IDs mismatch on bookingId collision', async () => {
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
          findUnique: jest.fn().mockImplementation(async ({ where }) => {
            if (where?.bookingIntentId === 'intent-1') {
              return null;
            }
            if (where?.id === 'booking-1') {
              return {
                id: 'booking-1',
                userId: 'user-1',
                bookingIntentId: 'other-intent',
                status: 'PROCESSING',
              };
            }
            return null;
          }),
        },
      };
      const service = new BookingService(prisma as never, {} as never, {} as never, {} as never);

      await expect(service.createBooking('user-1', 'booking-1', 'intent-1')).rejects.toBeInstanceOf(BadRequestException);
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
          findUnique: jest.fn().mockResolvedValue({
            id: 'booking-1',
            userId: 'other-user',
            bookingIntentId: 'intent-1',
            status: 'PROCESSING',
          }),
        },
      };
      const service = new BookingService(prisma as never, {} as never, {} as never, {} as never);

      await expect(service.createBooking('user-1', 'booking-1', 'intent-1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('handles unique-constraint violation and throws ForbiddenException if existingById is owned by another user', async () => {
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
          findUnique: jest.fn().mockImplementation(async ({ where }) => {
            if (where?.bookingIntentId === 'intent-1') {
              return null;
            }
            if (where?.id === 'booking-1') {
              return {
                id: 'booking-1',
                userId: 'other-user',
                bookingIntentId: 'intent-1',
                status: 'PROCESSING',
              };
            }
            return null;
          }),
        },
      };
      const service = new BookingService(prisma as never, {} as never, {} as never, {} as never);

      await expect(service.createBooking('user-1', 'booking-1', 'intent-1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('re-throws error if unique-constraint violation cannot find booking by intent or id', async () => {
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
          findUnique: jest.fn().mockResolvedValue(null),
        },
      };
      const service = new BookingService(prisma as never, {} as never, {} as never, {} as never);

      await expect(service.createBooking('user-1', 'booking-1', 'intent-1')).rejects.toThrow(error);
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
