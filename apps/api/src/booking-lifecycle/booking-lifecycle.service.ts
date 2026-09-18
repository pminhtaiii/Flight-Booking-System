import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
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
import { FlightSnapshot, FlightSegmentSnapshot, PassengerSnapshot } from '@shared/booking-types';
import {
  BookingCreatedEvent,
  BookingConfirmedEvent,
  BookingFailedEvent,
  BookingCompletedEvent,
  BookingRecoveryResolvedEvent,
  BookingCancellationPendingEvent,
  BookingCancelledEvent,
  BookingRefundUpdatedEvent,
  BookingEventPublisherService,
  PublishableEvent,
  TransactionEventContext,
} from '@/domain-events';
import { BookingPipelineOutcome, BookingWithRelations } from './booking-lifecycle.types';

function isTransactionEventContext(
  value: Prisma.TransactionClient | TransactionEventContext | undefined,
): value is TransactionEventContext {
  return (
    typeof value === 'object' &&
    value !== null &&
    'tx' in value &&
    'events' in value &&
    Array.isArray(value.events)
  );
}

function resolveTxAndContext(
  txOrContext?: Prisma.TransactionClient | TransactionEventContext,
  context?: TransactionEventContext,
): { tx?: Prisma.TransactionClient; context?: TransactionEventContext } {
  if (isTransactionEventContext(txOrContext)) {
    return {
      tx: txOrContext.tx,
      context: txOrContext,
    };
  }
  if (context) {
    return {
      tx: context.tx,
      context,
    };
  }
  return {
    tx: txOrContext,
    context: undefined,
  };
}

export const ALLOWED_REFUND_SOURCE_STATUSES: Partial<Record<BookingStatus, readonly BookingStatus[]>> = {
  [BookingStatus.CANCELLED_AND_REFUNDED]: [
    BookingStatus.CANCELLED_PENDING_REFUND,
    BookingStatus.REFUND_FAILED_NEEDS_ATTENTION,
    BookingStatus.CANCELLATION_PENDING,
  ],
  [BookingStatus.CANCELLED_NO_REFUND]: [
    BookingStatus.CANCELLATION_PENDING,
    BookingStatus.CANCELLED_PENDING_REFUND,
    BookingStatus.REFUND_FAILED_NEEDS_ATTENTION,
  ],
  [BookingStatus.CANCELLED_PENDING_REFUND]: [
    BookingStatus.REFUND_FAILED_NEEDS_ATTENTION,
    BookingStatus.CANCELLATION_PENDING,
    BookingStatus.CANCELLED_PENDING_REFUND,
  ],
  [BookingStatus.REFUND_FAILED_NEEDS_ATTENTION]: [
    BookingStatus.CANCELLED_PENDING_REFUND,
    BookingStatus.CANCELLATION_PENDING,
    BookingStatus.REFUND_FAILED_NEEDS_ATTENTION,
  ],
};

@Injectable()
export class BookingLifecycleService {
  private readonly logger = new Logger(BookingLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly publisher: BookingEventPublisherService,
  ) {}

  private async executeMutation<T>(
    resolvedContext: TransactionEventContext | undefined,
    resolvedTx: Prisma.TransactionClient | undefined,
    operation: (client: Prisma.TransactionClient, events: PublishableEvent[]) => Promise<T>,
  ): Promise<T> {
    if (resolvedContext) {
      return operation(resolvedContext.tx, resolvedContext.events);
    }

    if (resolvedTx) {
      const localEvents: PublishableEvent[] = [];
      return operation(resolvedTx, localEvents);
    }

    const localEvents: PublishableEvent[] = [];
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
    flightSnapshot?: FlightSnapshot,
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

    const existingByIntent = await client.booking.findUnique({
      where: { bookingIntentId },
    });
    if (existingByIntent) {
      if (existingByIntent.userId !== userId) {
        throw new ForbiddenException('You do not own this booking');
      }
      if (existingByIntent.id !== bookingId) {
        const existingById = await client.booking.findUnique({
          where: { id: bookingId },
        });
        if (existingById && existingById.bookingIntentId !== bookingIntentId) {
          throw new BadRequestException(
            'Booking ID is already associated with a different booking intent',
          );
        }
      }
      if (!existingByIntent.paymentId && paymentId) {
        return await client.booking.update({
          where: { id: existingByIntent.id },
          data: { paymentId },
        });
      }
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

    let snapshotToStore = flightSnapshot;
    if (!snapshotToStore && intent.rawOfferSnapshot && typeof intent.rawOfferSnapshot === 'object') {
      const raw = intent.rawOfferSnapshot as Record<string, unknown>;
      if (Array.isArray(raw.segments) && raw.segments.length > 0) {
        snapshotToStore = intent.rawOfferSnapshot as unknown as FlightSnapshot;
      } else if (Array.isArray(raw.slices) && raw.slices.length > 0) {
        snapshotToStore = this.parseDuffelRawOfferSnapshot(raw) ?? undefined;
      }
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
          ...(snapshotToStore
            ? { flightSnapshot: snapshotToStore as unknown as Prisma.InputJsonValue }
            : {}),
          version: 1,
        },
      });
    } catch (e: unknown) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const fallbackById = await this.prisma.booking.findUnique({
          where: { id: bookingId },
        });
        if (fallbackById) {
          if (fallbackById.userId !== userId) {
            throw new ForbiddenException('You do not own this booking');
          }
          if (fallbackById.bookingIntentId !== bookingIntentId) {
            throw new BadRequestException(
              'Booking ID is already associated with a different booking intent',
            );
          }
          if (!fallbackById.paymentId && paymentId) {
            return await this.prisma.booking.update({
              where: { id: fallbackById.id },
              data: { paymentId },
            });
          }
          return fallbackById;
        }

        const fallbackByIntent = await this.prisma.booking.findUnique({
          where: { bookingIntentId },
        });
        if (fallbackByIntent) {
          if (fallbackByIntent.userId !== userId) {
            throw new ForbiddenException('You do not own this booking');
          }
          if (!fallbackByIntent.paymentId && paymentId) {
            return await this.prisma.booking.update({
              where: { id: fallbackByIntent.id },
              data: { paymentId },
            });
          }
          return fallbackByIntent;
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
        const localEvents: PublishableEvent[] = [];
        const eventSink: PublishableEvent[] = context ? context.events : localEvents;

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

  async claimCancellation(
    bookingId: string,
    userId: string,
    staleThreshold: Date = new Date(Date.now() - 2 * 60 * 1000),
    tx?: Prisma.TransactionClient,
    context?: TransactionEventContext,
  ): Promise<{ count: number }> {
    const { tx: resolvedTx, context: resolvedContext } = resolveTxAndContext(tx, context);

    return this.executeMutation(resolvedContext, resolvedTx, async (client, events) => {
      // 1. Attempt business status transition to CANCELLATION_PENDING
      const transitionResult = await client.booking.updateMany({
        where: {
          id: bookingId,
          userId,
          status: { in: [BookingStatus.CONFIRMED, BookingStatus.COMPLETED] },
        },
        data: {
          status: BookingStatus.CANCELLATION_PENDING,
          version: { increment: 1 },
        },
      });

      if (transitionResult.count > 0) {
        const booking = await client.booking.findUnique({
          where: { id: bookingId },
          select: { version: true, status: true },
        });

        events.push(
          new BookingCancellationPendingEvent({
            bookingId,
            eventId: randomUUID(),
            sourceVersion: booking?.version ?? 1,
            status: BookingStatus.CANCELLATION_PENDING,
            timestamp: new Date(),
          }),
        );

        return { count: transitionResult.count };
      }

      // 2. Attempt refreshing stale CANCELLATION_PENDING lease
      // Invariant: If already CANCELLATION_PENDING (refreshing stale lease),
      // do NOT increment version and do NOT emit event!
      const refreshResult = await client.booking.updateMany({
        where: {
          id: bookingId,
          userId,
          status: BookingStatus.CANCELLATION_PENDING,
          updatedAt: { lte: staleThreshold },
        },
        data: {
          status: BookingStatus.CANCELLATION_PENDING,
        },
      });

      return { count: refreshResult.count };
    });
  }

  async cancelBooking(
    bookingId: string,
    cancellationStatus: BookingStatus = BookingStatus.CANCELLED_NO_REFUND,
    refundAmount: string = '0.00',
    disruptionResolution?: {
      resolvedByType?: DisruptionActorType;
      resolvedById?: string;
    },
    tx?: Prisma.TransactionClient,
    context?: TransactionEventContext,
  ): Promise<{
    count: number;
    hasActiveDisruption: boolean;
    activeDisruptionRevisionId: string | null;
    previousDisruptionStatus: DisruptionStatus | null;
  }> {
    const { tx: resolvedTx, context: resolvedContext } = resolveTxAndContext(tx, context);

    return this.executeMutation(resolvedContext, resolvedTx, async (client, events) => {
      const dbBooking = await client.booking.findUnique({
        where: { id: bookingId },
        select: {
          status: true,
          disruptionStatus: true,
          activeDisruptionRevisionId: true,
          version: true,
        },
      });

      if (!dbBooking || dbBooking.status !== BookingStatus.CANCELLATION_PENDING) {
        return {
          count: 0,
          hasActiveDisruption: false,
          activeDisruptionRevisionId: null,
          previousDisruptionStatus: null,
        };
      }

      const hasActiveDisruption =
        dbBooking.disruptionStatus === DisruptionStatus.DETECTED ||
        dbBooking.disruptionStatus === DisruptionStatus.ACKNOWLEDGED;

      const updateData: Prisma.BookingUpdateInput = {
        status: cancellationStatus,
        airlineRefundAmount: refundAmount,
        customerRefundAmount: refundAmount,
        version: { increment: 1 },
      };

      if (hasActiveDisruption) {
        updateData.disruptionStatus = DisruptionStatus.RESOLVED;
        updateData.disruptionResolvedReason = 'BOOKING_CANCELLED';
        updateData.disruptionResolvedAt = new Date();
        updateData.disruptionResolvedByType =
          disruptionResolution?.resolvedByType ?? DisruptionActorType.TRAVELLER;
        if (disruptionResolution?.resolvedById) {
          updateData.disruptionResolvedById = disruptionResolution.resolvedById;
        }
      }

      const result = await client.booking.updateMany({
        where: { id: bookingId, status: BookingStatus.CANCELLATION_PENDING },
        data: updateData,
      });

      if (result.count > 0) {
        const updated = await client.booking.findUnique({
          where: { id: bookingId },
          select: { version: true },
        });

        events.push(
          new BookingCancelledEvent({
            bookingId,
            eventId: randomUUID(),
            sourceVersion: updated?.version ?? (dbBooking.version ?? 1) + 1,
            status: cancellationStatus,
            timestamp: new Date(),
          }),
        );
      }

      return {
        count: result.count,
        hasActiveDisruption,
        activeDisruptionRevisionId: dbBooking.activeDisruptionRevisionId,
        previousDisruptionStatus: dbBooking.disruptionStatus,
      };
    });
  }

  /**
   * Updates booking refund status with no-op idempotency and audit event emission.
   *
   * Enforces the no-op invariant:
   * - If current.status === targetStatus: returns { count: 0, updatedBooking: current } (no version bump, no event).
   * - If different: updates status with version increment, emits BookingRefundUpdatedEvent, returns { count: 1, updatedBooking }.
   */
  async updateBookingRefundStatus(
    bookingId: string,
    targetStatus: BookingStatus,
    refundStatus: string = 'SUCCEEDED',
    reason?: string,
    tx?: Prisma.TransactionClient,
    context?: TransactionEventContext,
  ): Promise<{ count: number; updatedBooking?: Booking }> {
    const { tx: resolvedTx, context: resolvedContext } = resolveTxAndContext(tx, context);

    return this.executeMutation(resolvedContext, resolvedTx, async (client, events) => {
      let current = await client.booking.findUnique({
        where: { id: bookingId },
      });

      if (!current) {
        throw new NotFoundException('Booking not found');
      }

      for (let attempt = 1; attempt <= 3; attempt++) {
        if (current.status === targetStatus) {
          return { count: 0, updatedBooking: current };
        }

        const allowedSources = ALLOWED_REFUND_SOURCE_STATUSES[targetStatus];
        if (allowedSources && !allowedSources.includes(current.status)) {
          throw new ConflictException(
            `Cannot transition booking ${bookingId} from ${current.status} to ${targetStatus}`,
          );
        }

        const updateResult = await client.booking.updateMany({
          where: {
            id: bookingId,
            status: current.status,
            version: current.version,
          },
          data: {
            status: targetStatus,
            version: { increment: 1 },
          },
        });

        if (updateResult.count === 0) {
          const reloaded = await client.booking.findUnique({ where: { id: bookingId } });
          if (!reloaded) {
            throw new NotFoundException('Booking not found');
          }
          if (reloaded.status === targetStatus) {
            return { count: 0, updatedBooking: reloaded };
          }
          if (allowedSources && !allowedSources.includes(reloaded.status)) {
            throw new ConflictException(
              `Cannot transition booking ${bookingId} from reloaded status ${reloaded.status} to ${targetStatus}`,
            );
          }
          if (attempt < 3) {
            current = reloaded;
            continue;
          }
          throw new ConflictException(
            'Concurrent booking mutation detected during refund status update',
          );
        }

        const updatedBooking = await client.booking.findUnique({
          where: { id: bookingId },
        });

        events.push(
          new BookingRefundUpdatedEvent({
            bookingId,
            eventId: randomUUID(),
            sourceVersion: updatedBooking?.version ?? (current.version ?? 1) + 1,
            status: targetStatus,
            refundStatus,
            reason,
            timestamp: new Date(),
          }),
        );

        return { count: 1, updatedBooking: updatedBooking ?? undefined };
      }

      throw new ConflictException(
        'Concurrent booking mutation detected during refund status update',
      );
    });
  }

  async recordRecoveryOutcome(
    bookingId: string,
    outcome: 'CONFIRMED' | 'FAILED',
    details?: {
      pnrReference?: string;
      duffelOrderId?: string;
      failureReason?: BookingFailureReason;
      flightSnapshot?: FlightSnapshot;
      passengerSnapshot?: PassengerSnapshot;
      departureAt?: Date;
      recoveryOutcome?: string;
    },
    tx?: Prisma.TransactionClient,
    context?: TransactionEventContext,
  ): Promise<Booking> {
    const { tx: resolvedTx, context: resolvedContext } = resolveTxAndContext(tx, context);

    return this.executeMutation(resolvedContext, resolvedTx, async (client, events) => {
      let updateResult: { count: number };
      const recoveryOutcome =
        details?.recoveryOutcome ??
        (outcome === 'CONFIRMED' ? 'CONFIRMED_AFTER_PROCESSING' : 'FAILED_AFTER_PROCESSING');

      if (outcome === 'CONFIRMED') {
        updateResult = await client.booking.updateMany({
          where: { id: bookingId, status: { in: [BookingStatus.PROCESSING, BookingStatus.FAILED] } },
          data: {
            status: BookingStatus.CONFIRMED,
            failureReason: null,
            ...(details?.pnrReference ? { pnrReference: details.pnrReference } : {}),
            ...(details?.duffelOrderId ? { duffelOrderId: details.duffelOrderId } : {}),
            ...(details?.flightSnapshot
              ? { flightSnapshot: details.flightSnapshot as unknown as Prisma.InputJsonValue }
              : {}),
            ...(details?.passengerSnapshot
              ? { passengerSnapshot: details.passengerSnapshot as unknown as Prisma.InputJsonValue }
              : {}),
            ...(details?.departureAt ? { departureAt: details.departureAt } : {}),
            version: { increment: 1 },
          },
        });
      } else {
        updateResult = await client.booking.updateMany({
          where: { id: bookingId, status: BookingStatus.PROCESSING },
          data: {
            status: BookingStatus.FAILED,
            failureReason: details?.failureReason ?? BookingFailureReason.SYSTEM_ERROR,
            version: { increment: 1 },
            ...(details?.flightSnapshot
              ? { flightSnapshot: details.flightSnapshot as unknown as Prisma.InputJsonValue }
              : {}),
            ...(details?.passengerSnapshot
              ? { passengerSnapshot: details.passengerSnapshot as unknown as Prisma.InputJsonValue }
              : {}),
            ...(details?.departureAt ? { departureAt: details.departureAt } : {}),
          },
        });
      }

      const booking = await client.booking.findUnique({ where: { id: bookingId } });
      if (!booking) {
        throw new NotFoundException('Booking not found');
      }

      if (updateResult.count > 0) {
        events.push(
          new BookingRecoveryResolvedEvent({
            bookingId: booking.id,
            eventId: randomUUID(),
            sourceVersion: booking.version,
            status: booking.status,
            recoveryOutcome,
            timestamp: new Date(),
          }),
        );
      }

      return booking;
    });
  }

  private parseDuffelRawOfferSnapshot(raw: Record<string, unknown>): FlightSnapshot | null {
    if (!Array.isArray(raw.slices) || raw.slices.length === 0) {
      return null;
    }

    let totalDuration =
      typeof raw.total_duration === 'string'
        ? raw.total_duration
        : typeof raw.totalDuration === 'string'
        ? raw.totalDuration
        : 'PT0H';
    let totalMinutes = 0;
    let stops = 0;
    let cabinClass =
      typeof raw.cabinClass === 'string'
        ? raw.cabinClass
        : typeof raw.cabin_class === 'string'
        ? raw.cabin_class
        : 'economy';
    const segments: FlightSegmentSnapshot[] = [];
    let globalOrder = 0;

    for (let sliceOrder = 0; sliceOrder < raw.slices.length; sliceOrder++) {
      const slice = raw.slices[sliceOrder] as Record<string, unknown> | null;
      if (!slice) continue;
      if (typeof slice.duration === 'string') {
        totalMinutes += this.parseIsoDurationToMinutes(slice.duration);
      }
      if (Array.isArray(slice.segments)) {
        stops += Math.max(0, slice.segments.length - 1);
        for (let segmentOrder = 0; segmentOrder < slice.segments.length; segmentOrder++) {
          const seg = slice.segments[segmentOrder] as Record<string, any> | null;
          if (!seg) continue;

          if (Array.isArray(seg.passengers) && seg.passengers[0]?.cabin_class) {
            cabinClass = seg.passengers[0].cabin_class;
          } else if (seg.cabin_class) {
            cabinClass = seg.cabin_class;
          }

          const operatingCarrier = seg.operating_carrier || seg.operatingCarrier;
          const marketingCarrier = seg.marketing_carrier || seg.marketingCarrier;
          const airlineObj = seg.airline;
          const airlineName =
            operatingCarrier?.name ||
            marketingCarrier?.name ||
            (typeof airlineObj === 'object' && airlineObj?.name) ||
            'Unknown';
          const airlineIata =
            operatingCarrier?.iata_code ||
            operatingCarrier?.iataCode ||
            marketingCarrier?.iata_code ||
            marketingCarrier?.iataCode ||
            (typeof airlineObj === 'object' && (airlineObj?.iata_code || airlineObj?.iataCode)) ||
            'XX';

          const flightNumber =
            seg.marketing_carrier_flight_number ||
            seg.marketingCarrierFlightNumber ||
            seg.flight_number ||
            seg.flightNumber ||
            '0000';

          const origin = seg.origin || {};
          const destination = seg.destination || {};

          const depIata = origin.iata_code || origin.iataCode || '';
          const depName = origin.name || '';
          const depCity =
            origin.city_name ||
            origin.cityName ||
            origin.city?.name ||
            (typeof origin.city === 'string' ? origin.city : '') ||
            origin.name ||
            '';
          const depTerminal = seg.origin_terminal ?? seg.originTerminal ?? undefined;

          const arrIata = destination.iata_code || destination.iataCode || '';
          const arrName = destination.name || '';
          const arrCity =
            destination.city_name ||
            destination.cityName ||
            destination.city?.name ||
            (typeof destination.city === 'string' ? destination.city : '') ||
            destination.name ||
            '';
          const arrTerminal = seg.destination_terminal ?? seg.destinationTerminal ?? undefined;

          const departureAt = seg.departing_at || seg.departureAt || '';
          const arrivalAt = seg.arriving_at || seg.arrivalAt || '';
          const duration = seg.duration || '';

          segments.push({
            airline: {
              name: airlineName,
              iataCode: airlineIata,
            },
            flightNumber,
            departureAirport: {
              iataCode: depIata,
              name: depName,
              city: depCity,
              terminal: depTerminal !== null ? depTerminal : undefined,
            },
            arrivalAirport: {
              iataCode: arrIata,
              name: arrName,
              city: arrCity,
              terminal: arrTerminal !== null ? arrTerminal : undefined,
            },
            departureAt,
            arrivalAt,
            duration,
            aircraftType: seg.aircraft?.name || seg.aircraftType || undefined,
            duffelSegmentId: seg.id || seg.duffelSegmentId || undefined,
            sliceOrder,
            segmentOrder,
            globalOrder: globalOrder++,
          });
        }
      }
    }

    if (totalMinutes > 0 && totalDuration === 'PT0H') {
      totalDuration = this.formatMinutesToIsoDuration(totalMinutes);
    }

    return {
      segments,
      totalDuration,
      stops,
      cabinClass,
    };
  }

  private parseIsoDurationToMinutes(durationStr: string): number {
    if (!durationStr || typeof durationStr !== 'string') return 0;
    const matches = durationStr.match(/P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?/);
    if (!matches) return 0;
    const days = parseInt(matches[1] || '0', 10);
    const hours = parseInt(matches[2] || '0', 10);
    const minutes = parseInt(matches[3] || '0', 10);
    return days * 24 * 60 + hours * 60 + minutes;
  }

  private formatMinutesToIsoDuration(totalMinutes: number): string {
    if (totalMinutes <= 0) return 'PT0H';
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    let result = 'PT';
    if (hours > 0) result += `${hours}H`;
    if (minutes > 0) result += `${minutes}M`;
    return result;
  }
}

