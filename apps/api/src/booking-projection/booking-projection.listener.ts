import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEventBase } from '@/domain-events/domain-event.base';
import { BookingEventHydratorService } from '@/domain-events/booking-event-hydrator.service';
import { BookingProjectionService } from './booking-projection.service';
import { BookingProjectionRepository } from './booking-projection.repository';
import { BookingProjectionMetrics } from './booking-projection.metrics';
import { BOOKING_EVENTS } from '@/domain-events/booking.events';

export const PROJECTION_BOOKING_EVENTS = 'booking.**';

@Injectable()
export class BookingProjectionListener {
  private readonly logger = new Logger(BookingProjectionListener.name);

  constructor(
    private readonly hydrator: BookingEventHydratorService,
    private readonly projectionService: BookingProjectionService,
    private readonly repository: BookingProjectionRepository,
    private readonly metrics: BookingProjectionMetrics,
  ) {}

  private resolveEventName(event: unknown): string {
    if (!event || typeof event !== 'object') {
      return 'booking.unknown';
    }
    const anyEvent = event as Record<string, unknown>;
    if (typeof anyEvent.eventName === 'string' && anyEvent.eventName.trim().length > 0) {
      return anyEvent.eventName;
    }
    if (typeof anyEvent.type === 'string' && anyEvent.type.trim().length > 0) {
      return anyEvent.type;
    }
    const constructorName = (event as { constructor?: { name?: string } }).constructor?.name;
    if (constructorName && constructorName !== 'Object') {
      const classMap: Record<string, string> = {
        BookingCreatedEvent: 'booking.created',
        BookingConfirmedEvent: 'booking.confirmed',
        BookingFailedEvent: 'booking.failed',
        BookingCompletedEvent: 'booking.completed',
        BookingRecoveryResolvedEvent: 'booking.recovery.resolved',
        BookingCancellationPendingEvent: 'booking.cancellation.pending',
        BookingCancelledEvent: 'booking.cancelled',
        BookingDisruptionSyncedEvent: 'booking.disruption.synced',
        BookingDisruptionAcknowledgedEvent: 'booking.disruption.acknowledged',
        BookingDisruptionAcceptedEvent: 'booking.disruption.accepted',
        BookingRefundUpdatedEvent: 'booking.refund.updated',
      };
      if (classMap[constructorName]) {
        return classMap[constructorName];
      }
    }
    return 'booking.unknown';
  }

  @OnEvent(PROJECTION_BOOKING_EVENTS)
  async handleBookingEvent(event: DomainEventBase): Promise<void> {
    const startTime = Date.now();
    const eventName = this.resolveEventName(event);

    try {
      if (!event || !event.bookingId) {
        this.logger.warn({
          message: 'Booking event received with missing or invalid bookingId',
          eventName,
          eventId: (event as unknown as { eventId?: string })?.eventId,
        });
        this.metrics.incrementEventsTotal(eventName, 'ERROR');
        return;
      }

      const snapshot = await this.hydrator.hydrate(event.bookingId, event.sourceVersion);
      if (!snapshot) {
        this.logger.warn({
          message: 'Booking snapshot could not be hydrated for event',
          eventName,
          bookingId: event.bookingId,
          eventId: (event as unknown as { eventId?: string })?.eventId,
        });
        this.metrics.incrementEventsTotal(eventName, 'ERROR');
        return;
      }

      const data = this.projectionService.extractProjectionData(snapshot);
      if (!data) {
        this.logger.warn({
          message: 'Projection data could not be extracted from snapshot',
          eventName,
          bookingId: event.bookingId,
          eventId: (event as unknown as { eventId?: string })?.eventId,
        });
        this.metrics.incrementEventsTotal(eventName, 'ERROR');
        return;
      }

      const result = await this.repository.upsertGuarded({
        bookingId: event.bookingId,
        status: snapshot.status,
        sourceVersion: snapshot.version,
        data,
      });

      if (result.outcome === 'STALE_IGNORED') {
        this.metrics.incrementEventsTotal(eventName, 'STALE_IGNORED');
      } else {
        this.metrics.incrementEventsTotal(eventName, 'SUCCESS');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error({
        message: 'Failed to process booking projection event',
        bookingId: (event as unknown as { bookingId?: string })?.bookingId,
        eventId: (event as unknown as { eventId?: string })?.eventId,
        sourceVersion: (event as unknown as { sourceVersion?: number })?.sourceVersion,
        error: errorMessage,
      });
      this.metrics.incrementEventsTotal(eventName, 'ERROR');
    } finally {
      const durationMs = Date.now() - startTime;
      this.metrics.recordDuration(durationMs);
    }
  }
}
