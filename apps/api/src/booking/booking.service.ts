import { BadGatewayException, BadRequestException, ForbiddenException, Injectable, NotFoundException, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Booking, BookingFailureReason, BookingStatus, Prisma, DisruptionStatus, DisruptionActorType } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { CancellationQuoteResponseDto, CancellationResponseDto, FlightSnapshot, PassengerSnapshot } from '@shared/booking-types';
import { BookingDetailResponseDto, BookingListItemResponseDto, BookingListResponseDto, BookingTab } from './dto';
import { CurrentItineraryDto, BookingDisruptionDto, DisruptionResolvedReason, MaterialDisruptionReason, DisruptionStatus as SharedDisruptionStatus } from '@shared/disruption-types';

export type BookingWithRelations = Prisma.BookingGetPayload<{
  include: {
    payment: { select: { id: true; status: true; stripePaymentIntentId: true } };
    bookingIntent: { select: { id: true; duffelOfferId: true } };
    activeDisruptionRevision: {
      include: {
        segments: { orderBy: { globalOrder: 'asc' } };
        notificationOutbox: true;
      };
    };
    itineraryRevisions: {
      orderBy: { version: 'desc' };
      take: 1;
      include: { segments: { orderBy: { globalOrder: 'asc' } } };
    };
  };
}>;

import { StripeService } from '@/common/stripe.service';
import { DuffelService } from '@/duffel/duffel.service';
import { PaymentRefundService } from '@/payment/payment-refund.service';
import { User, Passenger } from '@prisma/client';

function enrichRedactedDuffelOrder(duffelOrder: any, dbPassengers: any[], userEmail: string): any {
  if (!duffelOrder) return duffelOrder;
  const copy = JSON.parse(JSON.stringify(duffelOrder));
  if (Array.isArray(copy.passengers)) {
    copy.passengers.forEach((p: any, i: number) => {
      const dbPass = dbPassengers.find((dbp: any) => dbp.duffelPassengerId === p.id) || dbPassengers[i];
      if (dbPass) {
        if (!p.given_name || p.given_name === 'REDACTED') {
          p.given_name = dbPass.givenName;
        }
        if (!p.family_name || p.family_name === 'REDACTED') {
          p.family_name = dbPass.familyName;
        }
        if (dbPass.dateOfBirth && (!p.born_on || p.born_on === 'REDACTED')) {
          const d = new Date(dbPass.dateOfBirth);
          if (!isNaN(d.getTime())) {
            p.born_on = d.toISOString().split('T')[0];
          }
        }
      }
      if (!p.email || p.email === 'REDACTED') {
        p.email = userEmail;
      }
      if (!p.phone_number || p.phone_number === 'REDACTED') {
        p.phone_number = null;
      }
    });
  }
  return copy;
}


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
          if (paymentId && existing.paymentId !== paymentId && existing.status === BookingStatus.PROCESSING) {
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
    tx?: Prisma.TransactionClient,
  ): Promise<Booking> {
    if (!flightSnapshot?.segments?.length) {
      throw new BadRequestException('Flight snapshot must contain at least one segment');
    }
    const client = tx || this.prisma;
    await client.booking.updateMany({
      // A captured Stripe intent plus a Duffel order is authoritative. A concurrent
      // stale-worker failure is therefore recoverable, but completed records remain immutable.
      where: { id: bookingId, status: { in: [BookingStatus.PROCESSING, BookingStatus.FAILED] } },
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
    const booking = await client.booking.findUnique({ where: { id: bookingId } });
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    return booking;
  }

  async updateToFailed(
    bookingId: string,
    failureReason: BookingFailureReason,
    flightSnapshot?: FlightSnapshot,
    passengerSnapshot?: PassengerSnapshot,
    departureAt?: Date,
    tx?: Prisma.TransactionClient,
  ): Promise<Booking> {
    const client = tx || this.prisma;
    await client.booking.updateMany({
      where: { id: bookingId, status: BookingStatus.PROCESSING },
      data: {
        status: BookingStatus.FAILED,
        failureReason,
        ...(flightSnapshot ? { flightSnapshot: flightSnapshot as unknown as Prisma.InputJsonValue } : {}),
        ...(passengerSnapshot ? { passengerSnapshot: passengerSnapshot as unknown as Prisma.InputJsonValue } : {}),
        ...(departureAt ? { departureAt } : {}),
      },
    });
    const booking = await client.booking.findUnique({ where: { id: bookingId } });
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    return booking;
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
        try {
          const duffelEvent = await this.prisma.paymentEvent.findFirst({
            where: { paymentId: booking.payment.id, eventType: 'duffel_order_created' },
            orderBy: { createdAt: 'desc' }
          });
          const duffelOrder = duffelEvent?.metadata as any;
          if (duffelOrder && duffelOrder.id) {
            await this.duffelService.cancelOrder(duffelOrder.id);
            this.logger.log(`Successfully cancelled orphaned Duffel order ${duffelOrder.id} during stale booking sweep.`);
          }
        } catch (cancelError: any) {
          this.logger.error(`Duffel order cancellation failed during stale booking sweep: ${cancelError.message}`, cancelError.stack);
        }

        // Release the Stripe authorization hold (cancel intent)
        try {
          await this.stripeService.cancelPaymentIntent(booking.payment.stripePaymentIntentId);
          this.logger.log(`Successfully cancelled Stripe PaymentIntent ${booking.payment.stripePaymentIntentId} during stale booking sweep.`);
        } catch (stripeCancelError: any) {
          this.logger.error(`Stripe cancelPaymentIntent failed during stale booking sweep: ${stripeCancelError.message}`, stripeCancelError.stack);
        }

        const res = await this.prisma.booking.updateMany({
          where: { id: booking.id, status: 'PROCESSING' },
          data: { status: 'FAILED', failureReason: 'CAPTURE_FAILED' }
        });
        if (res.count > 0) {
          booking.status = 'FAILED';
          booking.failureReason = 'CAPTURE_FAILED';
          // Advance Payment to CANCELLED so downstream guards don't attempt a second cancellation.
          await this.prisma.payment.updateMany({
            where: { id: booking.payment.id, status: { notIn: ['CANCELLED', 'REFUNDED'] } },
            data: { status: 'CANCELLED' },
          });
        }
        return booking;
      }

      const duffelEvent = await this.prisma.paymentEvent.findFirst({
        where: { paymentId: booking.payment.id, eventType: 'duffel_order_created' },
        orderBy: { createdAt: 'desc' }
      });
      
      const rawOrder = duffelEvent?.metadata as any;
      if (rawOrder && rawOrder.id) {
         const bookingIntent = await this.prisma.bookingIntent.findUnique({
           where: { id: booking.bookingIntentId },
           include: { passengers: true, user: true },
         });
         const order = bookingIntent && bookingIntent.user
           ? enrichRedactedDuffelOrder(rawOrder, bookingIntent.passengers, bookingIntent.user.email)
           : rawOrder;

         const { flightSnapshot, passengerSnapshot } = this.duffelService.mapDuffelOrderToSnapshots(order);
         const departureAt = flightSnapshot.segments?.[0]?.departureAt
           ? new Date(flightSnapshot.segments[0].departureAt)
           : null;

         const res = await this.prisma.booking.updateMany({
           where: { id: booking.id, status: 'PROCESSING' },
           data: {
             status: 'CONFIRMED',
             pnrReference: order.booking_reference || null,
             duffelOrderId: order.id,
             flightSnapshot: flightSnapshot as any,
             passengerSnapshot: passengerSnapshot as any,
             departureAt: departureAt,
           }
         });
         if (res.count > 0) {
           booking.status = 'CONFIRMED';
           booking.pnrReference = order.booking_reference || null;
           booking.duffelOrderId = order.id;
           booking.flightSnapshot = flightSnapshot as any;
           booking.passengerSnapshot = passengerSnapshot as any;
           booking.departureAt = departureAt;
           // Advance Payment to SUCCEEDED to match the captured Stripe intent.
           await this.prisma.payment.updateMany({
             where: { id: booking.payment.id, status: { notIn: ['SUCCEEDED', 'REFUNDED', 'CANCELLED'] } },
             data: { status: 'SUCCEEDED' },
           });
         }
      } else {
         const res = await this.prisma.booking.updateMany({
           where: { id: booking.id, status: 'PROCESSING' },
           data: { status: 'FAILED', failureReason: 'SYSTEM_ERROR' }
         });
         if (res.count > 0) {
           booking.status = 'FAILED';
           booking.failureReason = 'SYSTEM_ERROR';

           try {
             await withTimeout(this.paymentRefundService.triggerAutomatedRefund(booking.payment.id, 'Stale processing booking timeout without duffel order'));
           } catch (e: any) {
             this.logger.error(
               `CRITICAL: Automated refund failed during stale booking reconciliation for payment ${booking.payment.id}: ${e.message}`,
               e.stack
             );
           }
         }
      }

    } catch (e: any) {
      this.logger.error(`Error during stale booking reconciliation for ${booking.id}: ${e.message}`, e.stack);
      throw e;
    }
    return booking;
  }

  async checkAndCompleteBooking(booking: BookingWithRelations): Promise<BookingWithRelations> {
    const now = new Date();
    const targetTime = booking.currentFinalArrivalAt || booking.departureAt;
    if (booking.status === 'CONFIRMED' && targetTime && targetTime <= now) {
      try {
        const didUpdate = await this.prisma.$transaction(async (tx) => {
          // Re-fetch the booking inside transaction to make it safe and atomic
          const dbBooking = await tx.booking.findUnique({
            where: { id: booking.id },
            select: {
              status: true,
              disruptionStatus: true,
              activeDisruptionRevisionId: true,
              currentFinalArrivalAt: true,
              departureAt: true,
            },
          });

          if (!dbBooking || dbBooking.status !== 'CONFIRMED') {
            return false;
          }

          const dbTargetTime = dbBooking.currentFinalArrivalAt || dbBooking.departureAt;
          if (!dbTargetTime || dbTargetTime > now) {
            return false;
          }

          const hasActiveDisruption = dbBooking.disruptionStatus === 'DETECTED' || dbBooking.disruptionStatus === 'ACKNOWLEDGED';

          const updateData: Prisma.BookingUpdateInput = {
            status: 'COMPLETED',
          };

          if (hasActiveDisruption) {
            updateData.disruptionStatus = 'RESOLVED';
            updateData.disruptionResolvedReason = 'DEPARTURE_PASSED';
            updateData.disruptionResolvedAt = now;
            updateData.disruptionResolvedByType = 'SYSTEM';
          }

          // Guard against concurrent status or date changes by including status and date checks in the update filter
          const updated = await tx.booking.updateMany({
            where: {
              id: booking.id,
              status: 'CONFIRMED',
              currentFinalArrivalAt: dbBooking.currentFinalArrivalAt,
              departureAt: dbBooking.departureAt,
            },
            data: updateData,
          });

          if (updated.count === 0) {
            return false;
          }

          if (hasActiveDisruption) {
            await tx.disruptionAuditEvent.create({
              data: {
                bookingId: booking.id,
                revisionId: dbBooking.activeDisruptionRevisionId,
                action: 'DEPARTURE_RESOLVED',
                fromStatus: dbBooking.disruptionStatus,
                toStatus: 'RESOLVED',
                actorType: 'SYSTEM',
                actorId: null,
                correlationId: `passed-${booking.id}-${now.getTime()}`,
                traceId: `passed-${booking.id}-${now.getTime()}`,
                createdAt: now,
              },
            });
          }

          return true;
        });

        // Sync local object fields only if transaction successfully updated the record
        if (didUpdate) {
          booking.status = 'COMPLETED';
          if (booking.disruptionStatus === 'DETECTED' || booking.disruptionStatus === 'ACKNOWLEDGED') {
            booking.disruptionStatus = DisruptionStatus.RESOLVED;
            booking.disruptionResolvedReason = 'DEPARTURE_PASSED';
            booking.disruptionResolvedAt = now;
            booking.disruptionResolvedByType = DisruptionActorType.SYSTEM;
          }
        }
      } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger.error(`Failed to update booking ${booking.id} to COMPLETED: ${err.message}`, err.stack);
      }
    }
    return booking;
  }

  async listBookings(userId: string, tab: BookingTab, page: number, limit: number): Promise<BookingListResponseDto> {
    const now = new Date();
    const activeStatuses: BookingStatus[] = [
      BookingStatus.PROCESSING,
      BookingStatus.CONFIRMED,
      BookingStatus.CANCELLATION_PENDING,
      BookingStatus.CANCELLED_PENDING_REFUND,
      BookingStatus.FAILED,
    ];
    const pastTerminalStatuses: BookingStatus[] = [
      BookingStatus.COMPLETED,
      BookingStatus.CANCELLED_AND_REFUNDED,
      BookingStatus.CANCELLED_NO_REFUND,
    ];

    const where = tab === 'past'
      ? {
          userId,
          OR: [
            { status: { in: pastTerminalStatuses } },
            { status: { in: activeStatuses }, departureAt: { lte: now } },
          ],
        }
      : {
          userId,
          status: { in: activeStatuses },
          OR: [{ departureAt: null }, { departureAt: { gt: now } }],
        };

    const bookings = await this.prisma.booking.findMany({
      where,
      include: {
        payment: { select: { id: true, status: true, stripePaymentIntentId: true } },
        bookingIntent: { select: { id: true, duffelOfferId: true } },
        activeDisruptionRevision: {
          include: {
            segments: { orderBy: { globalOrder: 'asc' } },
            notificationOutbox: true,
          },
        },
        itineraryRevisions: {
          orderBy: { version: 'desc' },
          take: 1,
          include: { segments: { orderBy: { globalOrder: 'asc' } } },
        },
      },
    });
    
    const staleThreshold = new Date(Date.now() - 15 * 60 * 1000);
    const reconciledBookings = await Promise.all(
      bookings.map(async (b) => {
        let updated = b;
        // Only hit the Stripe/Duffel APIs for stale PROCESSING bookings; skip the
        // full reconciliation for everything else to avoid rate-limiting under burst.
        if (b.status === BookingStatus.PROCESSING && b.createdAt <= staleThreshold) {
          try {
            updated = await this.reconcileBookingIfStale(b as any);
          } catch (e: any) {
            this.logger.error(`Reactive stale booking reconciliation failed for ${b.id}: ${e.message}`, e.stack);
          }
        }
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
      include: {
        payment: { select: { id: true, status: true, stripePaymentIntentId: true } },
        bookingIntent: { select: { id: true, duffelOfferId: true } },
        activeDisruptionRevision: {
          include: {
            segments: { orderBy: { globalOrder: 'asc' } },
            notificationOutbox: true,
          },
        },
        itineraryRevisions: {
          orderBy: { version: 'desc' },
          take: 1,
          include: { segments: { orderBy: { globalOrder: 'asc' } } },
        },
      },
    });
    if (!initialBooking) {
      throw new NotFoundException('Booking not found');
    }
    if (initialBooking.userId !== userId) {
      throw new ForbiddenException('You do not have access to this booking');
    }
    
    let booking = initialBooking;
    try {
      booking = await this.reconcileBookingIfStale(initialBooking as any) as any;
    } catch (e: any) {
      this.logger.error(`Reactive stale booking reconciliation failed for ${initialBooking.id}: ${e.message}`, e.stack);
    }
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
      cancellationDeadline: booking.cancellationDeadline?.toISOString() ?? null,
      cancellationRefundable: booking.cancellationRefundable ?? null,
      airlineRefundAmount: booking.airlineRefundAmount ? booking.airlineRefundAmount.toString() : null,
      customerRefundAmount: booking.customerRefundAmount ? booking.customerRefundAmount.toString() : null,
      duffelCancellationQuoteId: booking.duffelCancellationQuoteId ?? null,
      createdAt: booking.createdAt.toISOString(),
      updatedAt: booking.updatedAt.toISOString(),
      ...this.mapDisruptionAndItinerary(booking),
    };
  }

  private mapDisruptionAndItinerary(booking: BookingWithRelations): { currentItinerary: CurrentItineraryDto; disruption: BookingDisruptionDto } {
    const isSurfacing = process.env.FEATURE_FLAG_DISRUPTION_SURFACING === 'true';

    // 1. Build original itinerary data from flightSnapshot as fallback
    const flightSnapshot = booking.flightSnapshot as unknown as FlightSnapshot;
    const originalSegments = flightSnapshot?.segments || [];
    
    // Default/fallback currentItinerary (which represents the original or when surfacing is disabled)
    let currentItinerary: CurrentItineraryDto = {
      source: 'ORIGINAL',
      revisionId: null,
      version: 0,
      segments: originalSegments,
      nextUnflownDepartureAt: booking.nextUnflownDepartureAt?.toISOString() ?? null,
      finalArrivalAt: booking.currentFinalArrivalAt?.toISOString() ?? null,
    };

    // Calculate timings from original segments if not present in DB
    if (!currentItinerary.nextUnflownDepartureAt || !currentItinerary.finalArrivalAt) {
      const sorted = [...originalSegments].sort((a, b) => (a.globalOrder ?? 0) - (b.globalOrder ?? 0));
      if (sorted.length > 0) {
        if (!currentItinerary.finalArrivalAt) {
          currentItinerary.finalArrivalAt = sorted[sorted.length - 1].arrivalAt;
        }
        if (!currentItinerary.nextUnflownDepartureAt) {
          const now = new Date();
          const next = sorted.find(s => new Date(s.departureAt) > now);
          currentItinerary.nextUnflownDepartureAt = next ? next.departureAt : null;
        }
      }
    }

    // Default disruption status
    let disruption: BookingDisruptionDto = {
      status: SharedDisruptionStatus.NONE,
      activeRevisionId: null,
      isMaterial: false,
      materialReasons: [],
      incrementalSummary: {},
      cumulativeSummary: {},
      stabilizationWarning: false,
      resolvedReason: null,
      resolvedAt: null,
    };

    if (isSurfacing) {
      // Latest revision is used for current itinerary
      const latestRevision = booking.itineraryRevisions?.[0];
      if (latestRevision) {
        currentItinerary = {
          source: 'REVISION',
          revisionId: latestRevision.id,
          version: latestRevision.version,
          segments: latestRevision.segments.map(seg => ({
            airline: {
              name: seg.airlineName,
              iataCode: seg.marketingCarrierIata,
            },
            flightNumber: seg.flightNumber,
            departureAirport: {
              iataCode: seg.departureAirportIata,
              name: seg.departureAirportName,
              city: seg.departureCity,
              terminal: seg.departureTerminal ?? undefined,
            },
            arrivalAirport: {
              iataCode: seg.arrivalAirportIata,
              name: seg.arrivalAirportName,
              city: seg.arrivalCity,
              terminal: seg.arrivalTerminal ?? undefined,
            },
            departureAt: seg.departureAt.toISOString(),
            arrivalAt: seg.arrivalAt.toISOString(),
            duration: `PT${seg.durationMinutes}M`,
            aircraftType: seg.aircraftType ?? undefined,
            duffelSegmentId: seg.duffelSegmentId ?? undefined,
            sliceOrder: seg.sliceOrder,
            segmentOrder: seg.segmentOrder,
            globalOrder: seg.globalOrder,
          })),
          nextUnflownDepartureAt: booking.nextUnflownDepartureAt?.toISOString() ?? null,
          finalArrivalAt: booking.currentFinalArrivalAt?.toISOString() ?? null,
        };

        // Re-calculate timings from revision segments if not present in DB
        if (!currentItinerary.nextUnflownDepartureAt || !currentItinerary.finalArrivalAt) {
          const sorted = [...latestRevision.segments].sort((a, b) => a.globalOrder - b.globalOrder);
          if (sorted.length > 0) {
            if (!currentItinerary.finalArrivalAt) {
              currentItinerary.finalArrivalAt = sorted[sorted.length - 1].arrivalAt.toISOString();
            }
            if (!currentItinerary.nextUnflownDepartureAt) {
              const now = new Date();
              const next = sorted.find(s => s.departureAt > now);
              currentItinerary.nextUnflownDepartureAt = next ? next.departureAt.toISOString() : null;
            }
          }
        }
      }

      // If booking disruption status is not NONE, fill in disruption details
      if (booking.disruptionStatus && booking.disruptionStatus !== 'NONE') {
        const activeRevision = booking.activeDisruptionRevision;
        const incDiff = activeRevision?.incrementalDiff as unknown as { presentationSummary?: Record<string, unknown> };
        const cumDiff = activeRevision?.cumulativeDiff as unknown as { presentationSummary?: Record<string, unknown> };
        disruption = {
          status: booking.disruptionStatus as unknown as SharedDisruptionStatus,
          activeRevisionId: booking.activeDisruptionRevisionId,
          isMaterial: activeRevision ? activeRevision.isMaterial : false,
          materialReasons: activeRevision ? (activeRevision.materialReasons as unknown as MaterialDisruptionReason[]) : [],
          incrementalSummary: incDiff?.presentationSummary || {},
          cumulativeSummary: cumDiff?.presentationSummary || {},
          stabilizationWarning: activeRevision?.notificationOutbox?.stabilizationWarning ?? false,
          resolvedReason: booking.disruptionResolvedReason as unknown as DisruptionResolvedReason | null,
          resolvedAt: booking.disruptionResolvedAt?.toISOString() ?? null,
        };
      }
    }

    return { currentItinerary, disruption };
  }

  private sortBookings(bookings: BookingWithRelations[], tab: BookingTab): BookingWithRelations[] {
    return [...bookings].sort((left, right) => {
      if (tab === 'past') {
        return (right.departureAt?.getTime() ?? 0) - (left.departureAt?.getTime() ?? 0);
      }
      const priority: Record<BookingStatus, number> = {
        PROCESSING: 0,
        FAILED: 1,
        CONFIRMED: 2,
        CANCELLATION_PENDING: 3,
        CANCELLED_PENDING_REFUND: 4,
        CANCELLED_AND_REFUNDED: 5,
        CANCELLED_NO_REFUND: 6,
        COMPLETED: 7,
        REFUND_FAILED_NEEDS_ATTENTION: 8,
      };
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
      ...this.mapDisruptionAndItinerary(booking),
      createdAt: booking.createdAt.toISOString(),
    };
  }

  async getCancellationQuote(bookingId: string, userId: string): Promise<CancellationQuoteResponseDto> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    if (booking.userId !== userId) {
      throw new ForbiddenException('You do not have access to this booking');
    }

    if (booking.status !== BookingStatus.CONFIRMED || (booking.departureAt && booking.departureAt <= new Date())) {
      throw new BadRequestException('Booking is not eligible for cancellation quote');
    }

    if (!booking.duffelOrderId) {
      throw new BadRequestException('No Duffel order associated with booking');
    }

    const now = new Date();

    if (
      booking.duffelCancellationQuoteId &&
      booking.duffelCancellationQuoteId !== 'PENDING_QUOTE' &&
      booking.cancellationDeadline &&
      booking.cancellationDeadline > now
    ) {
      return {
        quoteId: booking.duffelCancellationQuoteId,
        bookingId: booking.id,
        duffelOrderId: booking.duffelOrderId,
        refundAmount: booking.customerRefundAmount ? booking.customerRefundAmount.toString() : '0.00',
        currency: booking.currency,
        expiresAt: booking.cancellationDeadline.toISOString(),
        refundable: booking.cancellationRefundable ?? false,
        cancellationDeadline: booking.cancellationDeadline.toISOString(),
      };
    }

    let claimed = false;

    if (booking.duffelCancellationQuoteId !== 'PENDING_QUOTE') {
      const claimResult = await this.prisma.booking.updateMany({
        where: {
          id: booking.id,
          status: BookingStatus.CONFIRMED,
          OR: [
            { duffelCancellationQuoteId: null },
            {
              cancellationDeadline: { lte: now },
              duffelCancellationQuoteId: { not: 'PENDING_QUOTE' },
            },
          ],
        },
        data: {
          duffelCancellationQuoteId: 'PENDING_QUOTE',
        },
      });
      claimed = claimResult.count > 0;
    }

    if (!claimed) {
      for (let attempt = 0; attempt < 25; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const updatedBooking = await this.prisma.booking.findUnique({ where: { id: booking.id } });
        if (
          updatedBooking &&
          updatedBooking.duffelCancellationQuoteId &&
          updatedBooking.duffelCancellationQuoteId !== 'PENDING_QUOTE' &&
          updatedBooking.cancellationDeadline &&
          updatedBooking.cancellationDeadline > new Date()
        ) {
          return {
            quoteId: updatedBooking.duffelCancellationQuoteId,
            bookingId: updatedBooking.id,
            duffelOrderId: updatedBooking.duffelOrderId || booking.duffelOrderId,
            refundAmount: updatedBooking.customerRefundAmount ? updatedBooking.customerRefundAmount.toString() : '0.00',
            currency: updatedBooking.currency,
            expiresAt: updatedBooking.cancellationDeadline.toISOString(),
            refundable: updatedBooking.cancellationRefundable ?? false,
            cancellationDeadline: updatedBooking.cancellationDeadline.toISOString(),
          };
        }
      }
      throw new BadRequestException('Booking state changed or quote creation in progress');
    }

    try {
      const quote = await this.duffelService.createCancellationQuote(booking.duffelOrderId);

      const quoteId = quote.id;
      const duffelOrderId = quote.order_id || booking.duffelOrderId;
      const refundAmount = quote.refund_amount ?? quote.total_refund_amount ?? '0.00';
      const currency = quote.refund_currency ?? quote.currency ?? booking.currency ?? 'GBP';
      const expiresAt = quote.expires_at ?? quote.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const refundable = quote.refundable !== undefined ? Boolean(quote.refundable) : parseFloat(String(refundAmount)) > 0;
      const cancellationDeadline = expiresAt;

      const finalizeResult = await this.prisma.booking.updateMany({
        where: {
          id: booking.id,
          status: BookingStatus.CONFIRMED,
          duffelCancellationQuoteId: 'PENDING_QUOTE',
        },
        data: {
          duffelCancellationQuoteId: quoteId,
          customerRefundAmount: refundAmount,
          cancellationRefundable: refundable,
          cancellationDeadline: cancellationDeadline ? new Date(cancellationDeadline) : null,
        },
      });

      if (finalizeResult.count === 0) {
        throw new BadRequestException('Booking status changed while generating cancellation quote');
      }

      return {
        quoteId,
        bookingId: booking.id,
        duffelOrderId,
        refundAmount: String(refundAmount),
        currency,
        expiresAt,
        refundable,
        cancellationDeadline,
      };
    } catch (error) {
      await this.prisma.booking.updateMany({
        where: {
          id: booking.id,
          duffelCancellationQuoteId: 'PENDING_QUOTE',
        },
        data: {
          duffelCancellationQuoteId: null,
        },
      });
      throw error;
    }
  }

  async cancelBooking(bookingId: string, userId: string, quoteId: string): Promise<CancellationResponseDto> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { payment: { select: { id: true } } },
    });
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    if (booking.userId !== userId) {
      throw new ForbiddenException('You do not have access to this booking');
    }
    if (!booking.duffelOrderId || booking.duffelCancellationQuoteId !== quoteId) {
      throw new BadRequestException('Cancellation quote is invalid');
    }
    if (booking.cancellationDeadline && booking.cancellationDeadline <= new Date()) {
      throw new BadRequestException('Cancellation quote has expired');
    }

    const staleClaimThreshold = new Date(Date.now() - 2 * 60 * 1000);
    const claim = await this.prisma.booking.updateMany({
      where: {
        id: bookingId,
        userId,
        OR: [
          { status: { in: [BookingStatus.CONFIRMED, BookingStatus.COMPLETED] } },
          { status: BookingStatus.CANCELLATION_PENDING, updatedAt: { lte: staleClaimThreshold } },
        ],
      },
      data: { status: BookingStatus.CANCELLATION_PENDING },
    });
    if (claim.count === 0) {
      const canonical = await this.prisma.booking.findUnique({ where: { id: bookingId } });
      if (!canonical) {
        throw new NotFoundException('Booking not found');
      }
      return this.toCancellationResponse(canonical);
    }

    const recoveredOrder = await this.duffelService.retrieveOrder(booking.duffelOrderId);
    let refundAmount = booking.customerRefundAmount?.toString() ?? '0.00';
    let refundable = booking.cancellationRefundable;
    if (recoveredOrder.status !== 'CANCELLED') {
      const confirmation = await this.confirmCancellationWithRetries(quoteId);
      if (confirmation.status !== 'CONFIRMED') {
        throw new BadGatewayException('Supplier cancellation could not be confirmed');
      }
      refundAmount = confirmation.refund_amount ?? refundAmount;
      refundable = confirmation.refundable;
    }

    const amountInMinorUnits = Math.round(Number(refundAmount) * 100);
    const cancellationStatus = refundable && amountInMinorUnits > 0
      ? BookingStatus.CANCELLED_PENDING_REFUND
      : BookingStatus.CANCELLED_NO_REFUND;
    const persistedCount = await this.prisma.$transaction(async (tx) => {
      const dbBooking = await tx.booking.findUnique({
        where: { id: bookingId },
        select: { status: true, disruptionStatus: true, activeDisruptionRevisionId: true },
      });
      if (dbBooking?.status !== BookingStatus.CANCELLATION_PENDING) {
        return 0;
      }

      const updateData: Prisma.BookingUpdateInput = {
        status: cancellationStatus,
        airlineRefundAmount: refundAmount,
        customerRefundAmount: refundAmount,
      };

      const hasActiveDisruption = dbBooking.disruptionStatus === 'DETECTED' || dbBooking.disruptionStatus === 'ACKNOWLEDGED';
      
      if (hasActiveDisruption) {
        updateData.disruptionStatus = 'RESOLVED';
        updateData.disruptionResolvedReason = 'BOOKING_CANCELLED';
        updateData.disruptionResolvedAt = new Date();
        updateData.disruptionResolvedByType = 'TRAVELLER';
        updateData.disruptionResolvedById = userId;
      }

      const result = await tx.booking.updateMany({
        where: { id: bookingId, status: BookingStatus.CANCELLATION_PENDING },
        data: updateData,
      });

      if (result.count > 0 && hasActiveDisruption) {
        await tx.disruptionAuditEvent.create({
          data: {
            bookingId,
            revisionId: dbBooking.activeDisruptionRevisionId,
            action: 'BOOKING_CANCELLED',
            fromStatus: dbBooking.disruptionStatus,
            toStatus: 'RESOLVED',
            actorType: 'TRAVELLER',
            actorId: userId,
            correlationId: `cancel-${bookingId}-${Date.now()}`,
            traceId: `cancel-${bookingId}-${Date.now()}`,
            createdAt: new Date(),
          },
        });
      }
      return result.count;
    });

    if (persistedCount === 0) {
      const canonical = await this.prisma.booking.findUnique({ where: { id: bookingId } });
      if (!canonical) {
        throw new NotFoundException('Booking not found');
      }
      return this.toCancellationResponse(canonical);
    }
    if (cancellationStatus === BookingStatus.CANCELLED_NO_REFUND || !booking.payment) {
      return {
        bookingId,
        bookingStatus: cancellationStatus,
        cancellationStatus,
        refundStatus: 'NOT_REQUIRED',
        refundAmount,
      };
    }

    const refund = await this.paymentRefundService.processCancellationRefund({
      bookingId,
      paymentId: booking.payment.id,
      amount: amountInMinorUnits,
      currency: booking.currency,
    });
    return {
      bookingId,
      bookingStatus: refund.refundStatus === 'SUCCEEDED' ? BookingStatus.CANCELLED_AND_REFUNDED : cancellationStatus,
      cancellationStatus,
      refundStatus: refund.refundStatus,
      refundAmount: refund.refundAmount,
      nextRetryAt: refund.nextRetryAt,
    };
  }

  private async confirmCancellationWithRetries(quoteId: string): Promise<Awaited<ReturnType<DuffelService['confirmCancellationQuote']>>> {
    const retryDelays = [1_000, 3_000, 5_000, 10_000];
    for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
      try {
        return await this.duffelService.confirmCancellationQuote(quoteId);
      } catch (error) {
        if (!this.isRetryableSupplierError(error) || attempt === retryDelays.length) {
          throw new BadGatewayException('Supplier cancellation could not be confirmed');
        }
        await new Promise<void>((resolve) => setTimeout(resolve, retryDelays[attempt]));
      }
    }
    throw new BadGatewayException('Supplier cancellation could not be confirmed');
  }

  private isRetryableSupplierError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) {
      return false;
    }
    const candidate = error as { status?: unknown; statusCode?: unknown };
    const status = typeof candidate.status === 'number' ? candidate.status : candidate.statusCode;
    return typeof status === 'number' && (status === 429 || status >= 500);
  }

  private toCancellationResponse(booking: Booking): CancellationResponseDto {
    const refundStatus = booking.status === BookingStatus.CANCELLED_AND_REFUNDED
      ? 'SUCCEEDED'
      : booking.status === BookingStatus.FAILED && booking.failureReason === BookingFailureReason.SYSTEM_ERROR
        ? 'REFUND_FAILED_NEEDS_ATTENTION'
        : 'PENDING';
    return {
      bookingId: booking.id,
      bookingStatus: booking.status,
      cancellationStatus: booking.status,
      refundStatus,
      refundAmount: booking.customerRefundAmount?.toString() ?? '0.00',
    };
  }

  async getCancellationStatus(bookingId: string, userId: string): Promise<any> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { cancellationRefund: true },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    if (booking.userId !== userId) {
      throw new ForbiddenException('You do not have access to this booking');
    }

    let escalationMessage = null;
    if (booking.status === BookingStatus.REFUND_FAILED_NEEDS_ATTENTION) {
      const hoursElapsed = (Date.now() - booking.updatedAt.getTime()) / (1000 * 60 * 60);
      if (hoursElapsed < 48) {
        escalationMessage = "Refund is taking longer than expected. Our team is reviewing \u2014 no action needed.";
      } else {
        escalationMessage = "Refund requires attention. Please contact support.";
      }
    }

    const refund = booking.cancellationRefund;

    return {
      bookingId: booking.id,
      bookingStatus: booking.status,
      cancellationDeadline: booking.cancellationDeadline?.toISOString() ?? null,
      airlineRefundAmount: booking.airlineRefundAmount?.toString() ?? null,
      customerRefundAmount: booking.customerRefundAmount?.toString() ?? null,
      duffelCancellationQuoteId: booking.duffelCancellationQuoteId ?? null,
      refundStatus: refund?.status ?? null,
      retryCount: refund?.retryCount ?? null,
      nextRetryAt: refund?.nextRetryAt?.toISOString() ?? null,
      lastErrorCode: refund?.lastErrorCode ?? null,
      escalationMessage,
    };
  }
}
