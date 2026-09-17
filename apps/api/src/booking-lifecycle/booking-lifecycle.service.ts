import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
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
import {
  BookingCreatedEvent,
  BookingConfirmedEvent,
  BookingFailedEvent,
  BookingCompletedEvent,
  BookingEventPublisherService,
  DomainEventBase,
  TransactionEventContext,
} from '@/domain-events';
import { BookingPipelineOutcome, BookingWithRelations } from './booking-lifecycle.types';

function resolveTxAndContext(
  txOrContext?: Prisma.TransactionClient | TransactionEventContext,
  context?: TransactionEventContext,
): { tx?: Prisma.TransactionClient; context?: TransactionEventContext } {
  if (
    txOrContext &&
    typeof txOrContext === 'object' &&
    'events' in txOrContext &&
    'tx' in txOrContext &&
    Array.isArray((txOrContext as unknown as TransactionEventContext).events)
  ) {
    return {
      tx: (txOrContext as unknown as TransactionEventContext).tx,
      context: txOrContext as unknown as TransactionEventContext,
    };
  }
  if (context) {
    return {
      tx: context.tx,
      context,
    };
  }
  return {
    tx: txOrContext as Prisma.TransactionClient | undefined,
    context: undefined,
  };
}

@Injectable()
export class BookingLifecycleService {
  private readonly logger = new Logger(BookingLifecycleService.name);
  private readonly publisher: BookingEventPublisherService;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() publisher?: BookingEventPublisherService,
    @Optional() private readonly bookingAgentProjectionService?: BookingAgentProjectionService,
  ) {
    this.publisher = publisher ?? new BookingEventPublisherService();
  }

  private async executeMutation<T>(
    resolvedContext: TransactionEventContext | undefined,
    resolvedTx: Prisma.TransactionClient | undefined,
    operation: (client: Prisma.TransactionClient, events: DomainEventBase[]) => Promise<T>,
  ): Promise<T> {
    if (resolvedContext) {
      return operation(resolvedContext.tx, resolvedContext.events as DomainEventBase[]);
    }

    if (resolvedTx) {
      const localEvents: DomainEventBase[] = [];
      return operation(resolvedTx, localEvents);
    }

    const localEvents: DomainEventBase[] = [];
    const result = await this.prisma.$transaction(async (tx) => {
      return operation(tx, localEvents);
    });

    if (localEvents.length > 0) {
      await this.publisher.publish(localEvents);
    }

    return result;
  }

  async createBooking(
    userId: string,
    bookingId: string,
    bookingIntentId: string,
    paymentId?: string,
    context?: TransactionEventContext,
  ): Promise<Booking> {
    const client = context ? context.tx : this.prisma;

    const intent = await client.bookingIntent.findUnique({
      where: { id: bookingIntentId },
    });
    if (!intent) {
      throw new NotFoundException('Booking intent not found');
    }
    if (intent.userId !== userId) {
      throw new ForbiddenException('You do not own this booking intent');
    }

    // Check existing before attempting create to prevent 25P02 aborted transaction in Postgres
    const existingByIntent = await client.booking.findUnique({
      where: { bookingIntentId },
    });
    if (existingByIntent) {
      if (existingByIntent.userId !== userId) {
        throw new ForbiddenException('You do not own this booking');
      }
      if (!existingByIntent.paymentId && paymentId) {
        // Bookkeeping Exclusion: Attaching paymentId must NOT increment version and emits ZERO events.
        return await client.booking.update({
          where: { id: existingByIntent.id },
          data: { paymentId },
        });
      }
      // Idempotency Replay Invariant: existing booking returned, do NOT increment version, emit ZERO events.
      return existingByIntent;
    }

    const existingById = await client.booking.findUnique({
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
        return await client.booking.update({
          where: { id: existingById.id },
          data: { paymentId },
        });
      }
      return existingById;
    }

    let created: Booking;
    try {
      created = await client.booking.create({
        data: {
          id: bookingId,
          userId,
          bookingIntentId,
          totalAmount: intent.confirmedPrice.toString(),
          currency: intent.currency,
          status: BookingStatus.PROCESSING,
          paymentId: paymentId || null,
          version: 1,
        },
      });
    } catch (e: unknown) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        // Fallback for concurrent race condition
        const fallback = await this.prisma.booking.findFirst({
          where: { OR: [{ bookingIntentId }, { id: bookingId }] },
        });
        if (fallback) {
          if (fallback.userId !== userId) {
            throw new ForbiddenException('You do not own this booking');
          }
          if (fallback.id === bookingId && fallback.bookingIntentId !== bookingIntentId) {
            throw new BadRequestException(
              'Booking ID is already associated with a different booking intent',
            );
          }
          if (!fallback.paymentId && paymentId) {
            return await this.prisma.booking.update({
              where: { id: fallback.id },
              data: { paymentId },
            });
          }
          return fallback;
        }
      }
      throw e;
    }

    const createdEvent = new BookingCreatedEvent({
      bookingId: created.id,
      eventId: randomUUID(),
      sourceVersion: created.version ?? 1,
      status: created.status,
      timestamp: new Date(),
    });

    if (context) {
      context.events.push(createdEvent);
    } else {
      await this.publisher.publish([createdEvent]);
    }

    return created;
  }

  async updateToConfirmed(
    bookingId: string,
    pnrReference: string,
    duffelOrderId: string,
    flightSnapshot: FlightSnapshot,
    passengerSnapshot: PassengerSnapshot,
    tx?: Prisma.TransactionClient,
    context?: TransactionEventContext,
  ): Promise<Booking> {
    if (!flightSnapshot?.segments?.length) {
      throw new BadRequestException('Flight snapshot must contain at least one segment');
    }

    const { tx: resolvedTx, context: resolvedContext } = resolveTxAndContext(tx, context);

    return this.executeMutation(resolvedContext, resolvedTx, async (client, events) => {
      const updateResult = await client.booking.updateMany({
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
          version: { increment: 1 },
        },
      });

      const booking = await client.booking.findUnique({ where: { id: bookingId } });
      if (!booking) {
        throw new NotFoundException('Booking not found');
      }

      if (updateResult.count > 0) {
        events.push(
          new BookingConfirmedEvent({
            bookingId: booking.id,
            eventId: randomUUID(),
            sourceVersion: booking.version,
            status: booking.status,
            timestamp: new Date(),
          }),
        );
      }

      await this.bookingAgentProjectionService?.createOrUpdateProjection(bookingId, client);
      return booking;
    });
  }

  async confirmBooking(
    bookingId: string,
    pnrReference: string,
    duffelOrderId: string,
    flightSnapshot: FlightSnapshot,
    passengerSnapshot: PassengerSnapshot,
    tx?: Prisma.TransactionClient,
    context?: TransactionEventContext,
  ): Promise<Booking> {
    return this.updateToConfirmed(
      bookingId,
      pnrReference,
      duffelOrderId,
      flightSnapshot,
      passengerSnapshot,
      tx,
      context,
    );
  }

  async updateToFailed(
    bookingId: string,
    failureReason: BookingFailureReason,
    flightSnapshot?: FlightSnapshot,
    passengerSnapshot?: PassengerSnapshot,
    departureAt?: Date,
    tx?: Prisma.TransactionClient,
    context?: TransactionEventContext,
  ): Promise<Booking> {
    const { tx: resolvedTx, context: resolvedContext } = resolveTxAndContext(tx, context);

    return this.executeMutation(resolvedContext, resolvedTx, async (client, events) => {
      const updateResult = await client.booking.updateMany({
        where: { id: bookingId, status: BookingStatus.PROCESSING },
        data: {
          status: BookingStatus.FAILED,
          failureReason,
          version: { increment: 1 },
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

      if (updateResult.count > 0) {
        events.push(
          new BookingFailedEvent({
            bookingId: booking.id,
            eventId: randomUUID(),
            sourceVersion: booking.version,
            status: booking.status,
            failureReason: booking.failureReason ?? failureReason,
            timestamp: new Date(),
          }),
        );
      }

      await this.bookingAgentProjectionService?.updateProjectionStatus(
        bookingId,
        BookingStatus.FAILED,
        client,
      );
      return booking;
    });
  }

  async failBooking(
    bookingId: string,
    failureReason: BookingFailureReason,
    flightSnapshot?: FlightSnapshot,
    passengerSnapshot?: PassengerSnapshot,
    departureAt?: Date,
    tx?: Prisma.TransactionClient,
    context?: TransactionEventContext,
  ): Promise<Booking> {
    return this.updateToFailed(
      bookingId,
      failureReason,
      flightSnapshot,
      passengerSnapshot,
      departureAt,
      tx,
      context,
    );
  }

  async applyPipelineOutcome(
    outcome: BookingPipelineOutcome,
    tx?: Prisma.TransactionClient,
    context?: TransactionEventContext,
  ): Promise<Booking> {
    if (outcome.status === 'CONFIRMED') {
      return context !== undefined
        ? this.updateToConfirmed(
            outcome.bookingId,
            outcome.pnrReference,
            outcome.duffelOrderId,
            outcome.flightSnapshot,
            outcome.passengerSnapshot,
            tx,
            context,
          )
        : this.updateToConfirmed(
            outcome.bookingId,
            outcome.pnrReference,
            outcome.duffelOrderId,
            outcome.flightSnapshot,
            outcome.passengerSnapshot,
            tx,
          );
    } else {
      return context !== undefined
        ? this.updateToFailed(
            outcome.bookingId,
            outcome.category,
            outcome.partialState?.flightSnapshot,
            outcome.partialState?.passengerSnapshot,
            outcome.partialState?.departureAt,
            tx,
            context,
          )
        : this.updateToFailed(
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
    context?: TransactionEventContext,
  ): Promise<BookingWithRelations> {
    let booking: BookingWithRelations;
    if (typeof bookingOrId === 'string') {
      const client = context?.tx ?? this.prisma;
      const found = await client.booking.findUnique({
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
        const localEvents: DomainEventBase[] = [];
        const eventSink = context ? (context.events as DomainEventBase[]) : localEvents;

        const executeUpdate = async (tx: Prisma.TransactionClient): Promise<boolean> => {
          // Re-fetch the booking inside transaction to make it safe and atomic
          const dbBooking = await tx.booking.findUnique({
            where: { id: booking.id },
            select: {
              status: true,
              disruptionStatus: true,
              activeDisruptionRevisionId: true,
              currentFinalArrivalAt: true,
              departureAt: true,
              version: true,
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
            version: { increment: 1 },
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

          const committedVersion = (dbBooking.version ?? 1) + 1;
          eventSink.push(
            new BookingCompletedEvent({
              bookingId: booking.id,
              eventId: randomUUID(),
              sourceVersion: committedVersion,
              status: BookingStatus.COMPLETED,
              timestamp: now,
            }),
          );

          return true;
        };

        let didUpdate = false;
        if (context) {
          didUpdate = await executeUpdate(context.tx);
        } else {
          didUpdate = await this.prisma.$transaction(async (tx) => {
            return executeUpdate(tx);
          });
          if (didUpdate && localEvents.length > 0) {
            await this.publisher.publish(localEvents);
          }
        }

        // Sync local object fields only if transaction successfully updated the record
        if (didUpdate) {
          booking.status = BookingStatus.COMPLETED;
          booking.version = (booking.version ?? 1) + 1;
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

  async completeBooking(
    bookingOrId: BookingWithRelations | string,
    context?: TransactionEventContext,
  ): Promise<BookingWithRelations> {
    return this.checkAndCompleteBooking(bookingOrId, context);
  }
}
