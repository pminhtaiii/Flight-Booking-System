import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  Booking,
  BookingFailureReason,
  BookingStatus,
  DisruptionActorType,
  DisruptionStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { FlightSnapshot, PassengerSnapshot } from '@shared/booking-types';
import { BookingAgentProjectionService } from '@/agent-gateway/booking-agent-projection.service';
import { BookingPipelineOutcome, BookingWithRelations } from './booking-lifecycle.types';

@Injectable()
export class BookingLifecycleService {
  private readonly logger = new Logger(BookingLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly bookingAgentProjectionService?: BookingAgentProjectionService,
  ) {}

  async createBooking(
    userId: string,
    bookingId: string,
    bookingIntentId: string,
    paymentId?: string,
  ): Promise<Booking> {
    const intent = await this.prisma.bookingIntent.findUnique({
      where: { id: bookingIntentId },
    });
    if (!intent) {
      throw new NotFoundException('Booking intent not found');
    }
    if (intent.userId !== userId) {
      throw new ForbiddenException('You do not own this booking intent');
    }
    try {
      return await this.prisma.booking.create({
        data: {
          id: bookingId,
          userId,
          bookingIntentId,
          totalAmount: intent.confirmedPrice.toString(),
          currency: intent.currency,
          status: BookingStatus.PROCESSING,
          paymentId: paymentId || null,
        },
      });
    } catch (e: unknown) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const existingByIntent = await this.prisma.booking.findUnique({
          where: { bookingIntentId },
        });
        if (existingByIntent) {
          if (existingByIntent.userId !== userId) {
            throw new ForbiddenException('You do not own this booking');
          }
          if (!existingByIntent.paymentId && paymentId) {
            return await this.prisma.booking.update({
              where: { id: existingByIntent.id },
              data: { paymentId },
            });
          }
          return existingByIntent;
        }

        const existingById = await this.prisma.booking.findUnique({
          where: { id: bookingId },
        });
        if (existingById) {
          if (existingById.userId !== userId) {
            throw new ForbiddenException('You do not own this booking');
          }
          if (existingById.bookingIntentId !== bookingIntentId) {
            throw new BadRequestException(
              'Booking ID is already associated with a different booking intent',
            );
          }
          if (!existingById.paymentId && paymentId) {
            return await this.prisma.booking.update({
              where: { id: existingById.id },
              data: { paymentId },
            });
          }
          return existingById;
        }
      }
      throw e;
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
    await this.bookingAgentProjectionService?.createOrUpdateProjection(bookingId, client);
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
        ...(flightSnapshot
          ? { flightSnapshot: flightSnapshot as unknown as Prisma.InputJsonValue }
          : {}),
        ...(passengerSnapshot
          ? { passengerSnapshot: passengerSnapshot as unknown as Prisma.InputJsonValue }
          : {}),
        ...(departureAt ? { departureAt } : {}),
      },
    });
    const booking = await client.booking.findUnique({ where: { id: bookingId } });
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    await this.bookingAgentProjectionService?.updateProjectionStatus(
      bookingId,
      BookingStatus.FAILED,
      client,
    );
    return booking;
  }

  async applyPipelineOutcome(
    outcome: BookingPipelineOutcome,
    tx?: Prisma.TransactionClient,
  ): Promise<Booking> {
    if (outcome.status === 'CONFIRMED') {
      return this.updateToConfirmed(
        outcome.bookingId,
        outcome.pnrReference,
        outcome.duffelOrderId,
        outcome.flightSnapshot,
        outcome.passengerSnapshot,
        tx,
      );
    } else {
      return this.updateToFailed(
        outcome.bookingId,
        outcome.category,
        outcome.partialState?.flightSnapshot,
        outcome.partialState?.passengerSnapshot,
        outcome.partialState?.departureAt,
        tx,
      );
    }
  }

  async checkAndCompleteBooking(
    bookingOrId: BookingWithRelations | string,
  ): Promise<BookingWithRelations> {
    let booking: BookingWithRelations;
    if (typeof bookingOrId === 'string') {
      const found = await this.prisma.booking.findUnique({
        where: { id: bookingOrId },
        include: {
          payment: {
            include: {
              ancillarySelection: {
                include: {
                  seatSelections: true,
                  baggageSelections: true,
                },
              },
            },
          },
          bookingIntent: {
            include: {
              passengers: true,
            },
          },
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
      if (!found) {
        throw new NotFoundException(`Booking ${bookingOrId} not found`);
      }
      booking = found;
    } else {
      booking = bookingOrId;
    }

    const now = new Date();
    const targetTime = booking.currentFinalArrivalAt || booking.departureAt;
    if (booking.status === BookingStatus.CONFIRMED && targetTime && targetTime <= now) {
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

          if (!dbBooking || dbBooking.status !== BookingStatus.CONFIRMED) {
            return false;
          }

          const dbTargetTime = dbBooking.currentFinalArrivalAt || dbBooking.departureAt;
          if (!dbTargetTime || dbTargetTime > now) {
            return false;
          }

          const hasActiveDisruption =
            dbBooking.disruptionStatus === DisruptionStatus.DETECTED ||
            dbBooking.disruptionStatus === DisruptionStatus.ACKNOWLEDGED;

          const updateData: Prisma.BookingUpdateInput = {
            status: BookingStatus.COMPLETED,
          };

          if (hasActiveDisruption) {
            updateData.disruptionStatus = DisruptionStatus.RESOLVED;
            updateData.disruptionResolvedReason = 'DEPARTURE_PASSED';
            updateData.disruptionResolvedAt = now;
            updateData.disruptionResolvedByType = DisruptionActorType.SYSTEM;
          }

          // Guard against concurrent status or date changes by including status and date checks in the update filter
          const updated = await tx.booking.updateMany({
            where: {
              id: booking.id,
              status: BookingStatus.CONFIRMED,
              currentFinalArrivalAt: dbBooking.currentFinalArrivalAt,
              departureAt: dbBooking.departureAt,
            },
            data: updateData,
          });

          if (updated.count === 0) {
            return false;
          }

          await this.bookingAgentProjectionService?.updateProjectionStatus(
            booking.id,
            BookingStatus.COMPLETED,
            tx,
          );

          if (hasActiveDisruption) {
            await tx.disruptionAuditEvent.create({
              data: {
                bookingId: booking.id,
                revisionId: dbBooking.activeDisruptionRevisionId,
                action: 'DEPARTURE_RESOLVED',
                fromStatus: dbBooking.disruptionStatus,
                toStatus: DisruptionStatus.RESOLVED,
                actorType: DisruptionActorType.SYSTEM,
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
          booking.status = BookingStatus.COMPLETED;
          if (
            booking.disruptionStatus === DisruptionStatus.DETECTED ||
            booking.disruptionStatus === DisruptionStatus.ACKNOWLEDGED
          ) {
            booking.disruptionStatus = DisruptionStatus.RESOLVED;
            booking.disruptionResolvedReason = 'DEPARTURE_PASSED';
            booking.disruptionResolvedAt = now;
            booking.disruptionResolvedByType = DisruptionActorType.SYSTEM;
          }
        }
      } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger.error(
          `Failed to update booking ${booking.id} to COMPLETED: ${err.message}`,
          err.stack,
        );
      }
    }
    return booking;
  }
}
