import { Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { DomainEventBase } from './domain-event.base';
import {
  BOOKING_EVENTS,
  BookingCreatedEvent,
  BookingConfirmedEvent,
  BookingFailedEvent,
  BookingCompletedEvent,
  BookingRecoveryResolvedEvent,
  BookingCancellationPendingEvent,
  BookingCancelledEvent,
  BookingDisruptionSyncedEvent,
  BookingDisruptionAcknowledgedEvent,
  BookingDisruptionAcceptedEvent,
  BookingRefundUpdatedEvent,
} from './booking.events';
import { REFUND_EVENTS, RefundSettledEvent } from './refund.events';

export type PublishableEvent = DomainEventBase | RefundSettledEvent;

/**
 * Transaction Event Context
 *
 * Explicit contextual pair containing the active Prisma transaction client
 * and an isolated domain event collector array.
 * Strictly no generic transaction machinery.
 */
export interface TransactionEventContext {
  readonly tx: Prisma.TransactionClient;
  readonly events: PublishableEvent[];
}

/**
 * Creates an explicit transaction-event context.
 *
 * @param tx The active Prisma TransactionClient
 * @returns TransactionEventContext with a fresh empty events array
 */
export function createContext(tx: Prisma.TransactionClient): TransactionEventContext {
  return {
    tx,
    events: [],
  };
}

/**
 * Resolves the canonical contract event name for a domain event instance.
 *
 * @param event Domain event instance
 * @returns Contract event name or null if unrecognized
 */
export function resolveEventName(event: unknown): string | null {
  if (!event || typeof event !== 'object') {
    return null;
  }

  if (event instanceof BookingCreatedEvent) return BOOKING_EVENTS.CREATED;
  if (event instanceof BookingConfirmedEvent) return BOOKING_EVENTS.CONFIRMED;
  if (event instanceof BookingFailedEvent) return BOOKING_EVENTS.FAILED;
  if (event instanceof BookingCompletedEvent) return BOOKING_EVENTS.COMPLETED;
  if (event instanceof BookingRecoveryResolvedEvent) return BOOKING_EVENTS.RECOVERY_RESOLVED;
  if (event instanceof BookingCancellationPendingEvent) return BOOKING_EVENTS.CANCELLATION_PENDING;
  if (event instanceof BookingCancelledEvent) return BOOKING_EVENTS.CANCELLED;
  if (event instanceof BookingDisruptionSyncedEvent) return BOOKING_EVENTS.DISRUPTION_SYNCED;
  if (event instanceof BookingDisruptionAcknowledgedEvent) return BOOKING_EVENTS.DISRUPTION_ACKNOWLEDGED;
  if (event instanceof BookingDisruptionAcceptedEvent) return BOOKING_EVENTS.DISRUPTION_ACCEPTED;
  if (event instanceof BookingRefundUpdatedEvent) return BOOKING_EVENTS.REFUND_UPDATED;
  if (event instanceof RefundSettledEvent) return REFUND_EVENTS.SETTLED;

  const constructorName = (event as { constructor?: { name?: string } }).constructor?.name;
  switch (constructorName) {
    case 'BookingCreatedEvent':
      return BOOKING_EVENTS.CREATED;
    case 'BookingConfirmedEvent':
      return BOOKING_EVENTS.CONFIRMED;
    case 'BookingFailedEvent':
      return BOOKING_EVENTS.FAILED;
    case 'BookingCompletedEvent':
      return BOOKING_EVENTS.COMPLETED;
    case 'BookingRecoveryResolvedEvent':
      return BOOKING_EVENTS.RECOVERY_RESOLVED;
    case 'BookingCancellationPendingEvent':
      return BOOKING_EVENTS.CANCELLATION_PENDING;
    case 'BookingCancelledEvent':
      return BOOKING_EVENTS.CANCELLED;
    case 'BookingDisruptionSyncedEvent':
      return BOOKING_EVENTS.DISRUPTION_SYNCED;
    case 'BookingDisruptionAcknowledgedEvent':
      return BOOKING_EVENTS.DISRUPTION_ACKNOWLEDGED;
    case 'BookingDisruptionAcceptedEvent':
      return BOOKING_EVENTS.DISRUPTION_ACCEPTED;
    case 'BookingRefundUpdatedEvent':
      return BOOKING_EVENTS.REFUND_UPDATED;
    case 'RefundSettledEvent':
      return REFUND_EVENTS.SETTLED;
    default:
      if ('eventName' in event && typeof (event as { eventName?: unknown }).eventName === 'string') {
        return (event as { eventName: string }).eventName;
      }
      return null;
  }
}

/**
 * BookingEventPublisherService
 *
 * Safe post-commit domain event publisher.
 * - Iterates events after successful transaction commit.
 * - Resolves contract event names.
 * - Enforces dispatch error isolation: catches all errors/rejections, logs them, and never throws to caller.
 * - Injected with Optional EventEmitter2 falling back to a clean internal instance.
 */
@Injectable()
export class BookingEventPublisherService {
  private readonly logger = new Logger(BookingEventPublisherService.name);
  private readonly emitter: EventEmitter2;

  constructor(
    @Optional()
    private readonly eventEmitter?: EventEmitter2,
  ) {
    this.emitter = this.eventEmitter ?? new EventEmitter2();
  }

  /**
   * Creates an explicit transaction-event context.
   */
  createContext(tx: Prisma.TransactionClient): TransactionEventContext {
    return createContext(tx);
  }

  /**
   * Resolves canonical contract event name for a domain event.
   */
  resolveEventName(event: unknown): string | null {
    return resolveEventName(event);
  }

  /**
   * Publishes domain events to the internal event bus.
   *
   * Dispatches asynchronously via emitAsync.
   * Catches all synchronous exceptions and rejected promises per event,
   * logging them without throwing to the caller.
   */
  async publish(
    events?: readonly PublishableEvent[] | PublishableEvent[] | null,
  ): Promise<void> {
    if (!events || !Array.isArray(events) || events.length === 0) {
      return;
    }

    for (const event of events) {
      if (!event) {
        continue;
      }

      try {
        const eventName = this.resolveEventName(event);
        if (!eventName) {
          this.logger.warn(`Could not resolve event name for domain event: ${JSON.stringify(event)}`);
          continue;
        }

        await this.emitter.emitAsync(eventName, event);
      } catch (error) {
        this.logger.error(
          `Failed to dispatch domain event: ${error instanceof Error ? error.message : String(error)}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
  }
}
