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
    const service = new BookingService(prisma as never);

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
      },
    };
    const service = new BookingService(prisma as never);

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
    const service = new BookingService(prisma as never);

    await expect(service.getBookingDetail('booking-1', 'user-1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('reports a missing booking detail as not found', async () => {
    const prisma = { booking: { findUnique: jest.fn().mockResolvedValue(null) } };
    const service = new BookingService(prisma as never);

    await expect(service.getBookingDetail('missing', 'user-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('concurrency and validation', () => {
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
      const service = new BookingService(prisma as never);

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
      const service = new BookingService(prisma as never);

      await expect(service.createBooking('user-1', 'booking-1', 'intent-1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('throws BadRequestException in updateToConfirmed if flightSnapshot has no segments', async () => {
      const prisma = {};
      const service = new BookingService(prisma as never);

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
  });
});
