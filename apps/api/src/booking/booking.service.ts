import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { BookingFailureReason, BookingStatus, Prisma } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { FlightSnapshot, PassengerSnapshot } from '@shared/booking-types';
import { BookingDetailResponseDto, BookingListItemResponseDto, BookingListResponseDto, BookingTab } from './dto';

type BookingWithRelations = Prisma.BookingGetPayload<{
  include: {
    payment: { select: { id: true; status: true; stripePaymentIntentId: true } };
    bookingIntent: { select: { id: true; duffelOfferId: true } };
  };
}>;

@Injectable()
export class BookingService {
  constructor(private readonly prisma: PrismaService) {}

  async createBooking(userId: string, bookingId: string, bookingIntentId: string) {
    const bookingIntent = await this.prisma.bookingIntent.findUnique({
      where: { id: bookingIntentId },
      select: { id: true, userId: true, confirmedPrice: true, currency: true },
    });

    if (!bookingIntent) {
      throw new NotFoundException('Booking intent not found');
    }
    if (bookingIntent.userId !== userId) {
      throw new ForbiddenException('You do not have access to this booking intent');
    }

    try {
      return await this.prisma.booking.create({
        data: {
          id: bookingId,
          userId,
          bookingIntentId,
          totalAmount: bookingIntent.confirmedPrice.toString(),
          currency: bookingIntent.currency,
          status: BookingStatus.PROCESSING,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await this.prisma.booking.findFirst({
          where: {
            OR: [
              { id: bookingId },
              { bookingIntentId },
            ],
          },
        });
        if (existing) {
          if (existing.userId !== userId) {
            throw new ForbiddenException('You do not have access to this booking intent');
          }
          return existing;
        }
      }
      throw error;
    }
  }

  async updateToConfirmed(
    bookingId: string,
    pnrReference: string,
    duffelOrderId: string,
    flightSnapshot: FlightSnapshot,
    passengerSnapshot: PassengerSnapshot,
  ) {
    if (!flightSnapshot?.segments?.length) {
      throw new BadRequestException('Flight snapshot must contain at least one segment');
    }
    return this.prisma.booking.update({
      where: { id: bookingId },
      data: {
        status: BookingStatus.CONFIRMED,
        failureReason: null,
        pnrReference,
        duffelOrderId,
        flightSnapshot: flightSnapshot as unknown as Prisma.InputJsonValue,
        passengerSnapshot: passengerSnapshot as unknown as Prisma.InputJsonValue,
        departureAt: new Date(flightSnapshot.segments[0].departureAt),
      },
    });
  }

  async updateToFailed(
    bookingId: string,
    failureReason: BookingFailureReason,
    flightSnapshot?: FlightSnapshot,
    passengerSnapshot?: PassengerSnapshot,
    departureAt?: Date,
  ) {
    return this.prisma.booking.update({
      where: { id: bookingId },
      data: {
        status: BookingStatus.FAILED,
        failureReason,
        ...(flightSnapshot ? { flightSnapshot: flightSnapshot as unknown as Prisma.InputJsonValue } : {}),
        ...(passengerSnapshot ? { passengerSnapshot: passengerSnapshot as unknown as Prisma.InputJsonValue } : {}),
        ...(departureAt ? { departureAt } : {}),
      },
    });
  }

  async listBookings(userId: string, tab: BookingTab, page: number, limit: number): Promise<BookingListResponseDto> {
    const now = new Date();
    const where = tab === 'past'
      ? {
          userId,
          OR: [
            { status: BookingStatus.COMPLETED },
            { status: { in: [BookingStatus.CONFIRMED, BookingStatus.FAILED] }, departureAt: { lte: now } },
          ],
        }
      : {
          userId,
          status: { in: [BookingStatus.PROCESSING, BookingStatus.CONFIRMED, BookingStatus.FAILED] },
          OR: [{ departureAt: null }, { departureAt: { gt: now } }],
        };

    const bookings = await this.prisma.booking.findMany({
      where,
      include: { payment: { select: { id: true, status: true, stripePaymentIntentId: true } }, bookingIntent: { select: { id: true, duffelOfferId: true } } },
    });
    const ordered = this.sortBookings(bookings, tab);
    const total = ordered.length;
    const items = ordered.slice((page - 1) * limit, page * limit).map((booking) => this.toListItem(booking));

    return { bookings: items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async getBookingDetail(bookingId: string, userId: string): Promise<BookingDetailResponseDto> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { payment: { select: { id: true, status: true, stripePaymentIntentId: true } }, bookingIntent: { select: { id: true, duffelOfferId: true } } },
    });
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    if (booking.userId !== userId) {
      throw new ForbiddenException('You do not have access to this booking');
    }

    return {
      id: booking.id,
      status: booking.status,
      failureReason: booking.failureReason,
      pnrReference: booking.pnrReference,
      duffelOrderId: booking.duffelOrderId,
      totalAmount: booking.totalAmount.toString(),
      currency: booking.currency,
      departureAt: booking.departureAt?.toISOString() ?? null,
      flightSnapshot: booking.flightSnapshot,
      passengerSnapshot: booking.passengerSnapshot,
      payment: booking.payment ? { id: booking.payment.id, status: booking.payment.status, stripePaymentIntentId: booking.payment.stripePaymentIntentId } : null,
      bookingIntent: { id: booking.bookingIntent.id, offerId: booking.bookingIntent.duffelOfferId },
      createdAt: booking.createdAt.toISOString(),
      updatedAt: booking.updatedAt.toISOString(),
    };
  }

  private sortBookings(bookings: BookingWithRelations[], tab: BookingTab): BookingWithRelations[] {
    return [...bookings].sort((left, right) => {
      if (tab === 'past') {
        return (right.departureAt?.getTime() ?? 0) - (left.departureAt?.getTime() ?? 0);
      }
      const priority: Record<BookingStatus, number> = { PROCESSING: 0, FAILED: 1, CONFIRMED: 2, COMPLETED: 3 };
      const priorityDifference = priority[left.status] - priority[right.status];
      if (priorityDifference !== 0) return priorityDifference;
      return (left.departureAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (right.departureAt?.getTime() ?? Number.MAX_SAFE_INTEGER);
    });
  }

  private toListItem(booking: BookingWithRelations): BookingListItemResponseDto {
    return {
      id: booking.id,
      status: booking.status,
      failureReason: booking.failureReason,
      pnrReference: booking.pnrReference,
      totalAmount: booking.totalAmount.toString(),
      currency: booking.currency,
      departureAt: booking.departureAt?.toISOString() ?? null,
      flightSnapshot: booking.flightSnapshot,
      createdAt: booking.createdAt.toISOString(),
    };
  }
}
