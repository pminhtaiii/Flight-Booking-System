import { BadRequestException, ForbiddenException, Injectable, NotFoundException, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
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

import { StripeService } from '@/common/stripe.service';
import { DuffelService } from '@/duffel/duffel.service';
import { PaymentRefundService } from '@/payment/payment-refund.service';

@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
    private readonly duffelService: DuffelService,
    private readonly paymentRefundService: PaymentRefundService,
  ) {}

  @Cron("*/15 * * * *")
  async handleStaleProcessingBookings() {
    this.logger.log('Running stale PROCESSING bookings sweeper');
    const staleThreshold = new Date(Date.now() - 15 * 60 * 1000);
    const staleBookings = await this.prisma.booking.findMany({
      where: {
        status: 'PROCESSING',
        createdAt: { lte: staleThreshold },
      },
      include: {
        payment: { select: { id: true, status: true, stripePaymentIntentId: true } },
        bookingIntent: { select: { id: true, duffelOfferId: true } },
      }
    });

    for (const booking of staleBookings) {
      try {
        await this.reconcileBookingIfStale(booking as any);
      } catch (e) {
        this.logger.error(`Failed to reconcile stale booking ${booking.id}`, e);
      }
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleCompletedBookings() {
    this.logger.log('Running CONFIRMED -> COMPLETED bookings sweeper');
    const pastBookings = await this.prisma.booking.findMany({
      where: {
        status: 'CONFIRMED',
        departureAt: { lte: new Date() },
      },
      include: {
        payment: { select: { id: true, status: true, stripePaymentIntentId: true } },
        bookingIntent: { select: { id: true, duffelOfferId: true } },
      }
    });

    for (const booking of pastBookings) {
      try {
        await this.checkAndCompleteBooking(booking as any);
      } catch (e) {
        this.logger.error(`Failed to complete booking ${booking.id}`, e);
      }
    }
  }

  async createBooking(userId: string, bookingId: string, bookingIntentId: string, paymentId?: string) {
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
          paymentId: paymentId || null,
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
          if (paymentId && !existing.paymentId) {
            return await this.prisma.booking.update({
              where: { id: existing.id },
              data: { paymentId },
            });
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

  async reconcileBookingIfStale(booking: BookingWithRelations): Promise<BookingWithRelations> {
    if (booking.status !== 'PROCESSING') return booking;

    const staleThreshold = new Date(Date.now() - 15 * 60 * 1000);
    if (booking.createdAt > staleThreshold) {
      return booking;
    }

    try {
      const withTimeout = <T>(promise: Promise<T>, ms = 3000): Promise<T> => {
        return Promise.race([
          promise,
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms))
        ]);
      };

      if (!booking.payment?.stripePaymentIntentId) {
        const res = await this.prisma.booking.updateMany({
          where: { id: booking.id, status: 'PROCESSING' },
          data: { status: 'FAILED', failureReason: 'BOOKING_TIMEOUT' }
        });
        if (res.count > 0) {
          booking.status = 'FAILED';
          booking.failureReason = 'BOOKING_TIMEOUT';
        }
        return booking;
      }

      const intent = await withTimeout(this.stripeService.retrievePaymentIntent(booking.payment.stripePaymentIntentId));
      if (intent.status !== 'succeeded') {
        const res = await this.prisma.booking.updateMany({
          where: { id: booking.id, status: 'PROCESSING' },
          data: { status: 'FAILED', failureReason: 'CAPTURE_FAILED' }
        });
        if (res.count > 0) {
          booking.status = 'FAILED';
          booking.failureReason = 'CAPTURE_FAILED';
        }
        return booking;
      }

      const duffelEvent = await this.prisma.paymentEvent.findFirst({
        where: { paymentId: booking.payment.id, eventType: 'duffel_order_created' },
        orderBy: { createdAt: 'desc' }
      });
      
      const order = duffelEvent?.metadata as any;
      if (order && order.id) {
         const res = await this.prisma.booking.updateMany({
           where: { id: booking.id, status: 'PROCESSING' },
           data: { status: 'CONFIRMED' }
         });
         if (res.count > 0) booking.status = 'CONFIRMED';
      } else {
         try {
           await withTimeout(this.paymentRefundService.triggerAutomatedRefund(booking.payment.id, 'Stale processing booking timeout without duffel order'));
         } catch(e) {}
         
         const res = await this.prisma.booking.updateMany({
           where: { id: booking.id, status: 'PROCESSING' },
           data: { status: 'FAILED', failureReason: 'SYSTEM_ERROR' }
         });
         if (res.count > 0) {
           booking.status = 'FAILED';
           booking.failureReason = 'SYSTEM_ERROR';
         }
      }

    } catch (e) {}
    return booking;
  }

  async checkAndCompleteBooking(booking: BookingWithRelations): Promise<BookingWithRelations> {
    if (booking.status === 'CONFIRMED' && booking.departureAt && booking.departureAt < new Date()) {
      this.prisma.booking.updateMany({
        where: { id: booking.id, status: 'CONFIRMED' },
        data: { status: 'COMPLETED' }
      }).catch(() => {});
      booking.status = 'COMPLETED';
    }
    return booking;
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
    
    const reconciledBookings = await Promise.all(
      bookings.map(async (b) => {
        let updated = await this.reconcileBookingIfStale(b as any);
        updated = await this.checkAndCompleteBooking(updated);
        return updated;
      })
    );

    const ordered = this.sortBookings(reconciledBookings, tab);
    const total = ordered.length;
    const items = ordered.slice((page - 1) * limit, page * limit).map((booking) => this.toListItem(booking));

    return { bookings: items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async getBookingDetail(bookingId: string, userId: string): Promise<BookingDetailResponseDto> {
    const initialBooking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { payment: { select: { id: true, status: true, stripePaymentIntentId: true } }, bookingIntent: { select: { id: true, duffelOfferId: true } } },
    });
    if (!initialBooking) {
      throw new NotFoundException('Booking not found');
    }
    if (initialBooking.userId !== userId) {
      throw new ForbiddenException('You do not have access to this booking');
    }
    
    let booking = await this.reconcileBookingIfStale(initialBooking as any) as any;
    booking = await this.checkAndCompleteBooking(booking as any) as any;

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
      payment: booking.payment ? { id: booking.payment.id, status: booking.payment.status as any, stripePaymentIntentId: booking.payment.stripePaymentIntentId } : null,
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
