import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEventBase } from '@/domain-events/domain-event.base';
import { BookingEventHydratorService } from '@/domain-events/booking-event-hydrator.service';
import { BookingProjectionService } from './booking-projection.service';
import { BookingProjectionRepository } from './booking-projection.repository';
import { BookingProjectionMetrics } from './booking-projection.metrics';
import { BOOKING_EVENTS } from '@/domain-events/booking.events';
export const PROJECTION_BOOKING_EVENTS = 'booking.**';

const CATALOGUED_BOOKING_EVENTS = new Set<string>(Object.values(BOOKING_EVENTS));

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
    const eventName = this.resolveEventName(event);
    const anyEvent = event as Record<string, unknown> | null | undefined;

    if (
      !CATALOGUED_BOOKING_EVENTS.has(eventName) ||
      !anyEvent ||
      typeof anyEvent.eventId !== 'string' ||
      anyEvent.eventId.trim().length === 0 ||
      typeof anyEvent.sourceVersion !== 'number' ||
      !Number.isFinite(anyEvent.sourceVersion)
    ) {
      return;
    }

    const startTime = Date.now();
    let failureRecorded = false;

    try {
      if (!event || !event.bookingId) {
        this.logger.warn({
          message: 'Booking event received with missing or invalid bookingId',
          eventName,
          eventId: (event as unknown as { eventId?: string })?.eventId,
        });
        this.metrics.incrementFailureTotal('INVALID_EVENT');
        failureRecorded = true;
        this.metrics.incrementEventsTotal(eventName, 'ERROR');
        return;
      }

      let snapshot;
      try {
        snapshot = await this.hydrator.hydrate(
          event.bookingId,
          event.sourceVersion,
          event.eventId,
        );
      } catch (error) {
        this.metrics.incrementFailureTotal('HYDRATION_FAILED');
        failureRecorded = true;
        throw error;
      }

      if (!snapshot) {
        this.logger.warn({
          message: 'Booking snapshot could not be hydrated for event',
          eventName,
          bookingId: event.bookingId,
          eventId: (event as unknown as { eventId?: string })?.eventId,
        });
        this.metrics.incrementFailureTotal('HYDRATION_FAILED');
        failureRecorded = true;
        this.metrics.incrementEventsTotal(eventName, 'ERROR');
        return;
      }

      let data;
      try {
        data = this.projectionService.extractProjectionData(snapshot);
      } catch (error) {
        this.metrics.incrementFailureTotal('EXTRACTION_FAILED');
        failureRecorded = true;
        throw error;
      }

      if (!data) {
        this.logger.warn({
          message: 'Projection data could not be extracted from snapshot',
          eventName,
          bookingId: event.bookingId,
          eventId: (event as unknown as { eventId?: string })?.eventId,
        });
        this.metrics.incrementFailureTotal('EXTRACTION_FAILED');
        failureRecorded = true;
        this.metrics.incrementEventsTotal(eventName, 'ERROR');
        return;
      }

      try {
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
        this.metrics.incrementFailureTotal('DATABASE_ERROR');
        failureRecorded = true;
        throw error;
      }
    } catch (error) {
      if (!failureRecorded) {
        this.metrics.incrementFailureTotal('UNEXPECTED_ERROR');
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error({
        message: 'Failed to process booking projection event',
        eventName,
        bookingId: (event as unknown as { bookingId?: string })?.bookingId,
        eventId: (event as unknown as { eventId?: string })?.eventId,
        sourceVersion: (event as unknown as { sourceVersion?: number })?.sourceVersion,
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
      });
      this.metrics.incrementEventsTotal(eventName, 'ERROR');
    } finally {
      const durationMs = Date.now() - startTime;
      this.metrics.recordDuration(durationMs);
    }
  }
}
