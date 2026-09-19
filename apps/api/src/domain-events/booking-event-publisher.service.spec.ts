import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  BookingEventPublisherService,
  createContext,
  resolveEventName,
  TransactionEventContext,
} from './booking-event-publisher.service';
import { DomainEventsModule } from './domain-events.module';
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
import { DomainEventBase } from './domain-event.base';

describe('BookingEventPublisherService', () => {
  let publisher: BookingEventPublisherService;
  let mockEventEmitter: jest.Mocked<EventEmitter2>;
  const sampleDate = new Date('2026-09-17T12:00:00.000Z');

  const mockTx = {
    $executeRaw: jest.fn(),
    booking: {},
    bookingAgentProjection: {},
  } as unknown as Prisma.TransactionClient;

  beforeEach(() => {
    mockEventEmitter = {
      emitAsync: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<EventEmitter2>;

    publisher = new BookingEventPublisherService(mockEventEmitter);
  });

  describe('1. createContext & TransactionEventContext Structure', () => {
    it('creates context with provided Prisma transaction client and an empty events array', () => {
      const context: TransactionEventContext = createContext(mockTx);

      expect(context).toBeDefined();
      expect(context.tx).toBe(mockTx);
      expect(Array.isArray(context.events)).toBe(true);
      expect(context.events).toHaveLength(0);
    });

    it('creates context via service instance method', () => {
      const context = publisher.createContext(mockTx);

      expect(context.tx).toBe(mockTx);
      expect(context.events).toEqual([]);
    });

    it('allows mutating collector by pushing domain events', () => {
      const context = createContext(mockTx);
      const event = new BookingCreatedEvent({
        bookingId: 'book_123',
        eventId: 'evt_123',
        sourceVersion: 1,
        timestamp: sampleDate,
      });

      context.events.push(event);

      expect(context.events).toHaveLength(1);
      expect(context.events[0]).toBe(event);
    });
  });

  describe('2. Rollback Safety (Uncommitted Context Discard)', () => {
    it('emits zero events when transaction fails or rolls back without publishing', async () => {
      let rollbackHandled = false;
      const runTransaction = async (
        work: (ctx: TransactionEventContext) => Promise<void>,
      ) => {
        const ctx = publisher.createContext(mockTx);
        try {
          await work(ctx);
          await publisher.publish(ctx.events);
        } catch (error) {
          // On transaction rollback, context and events are discarded
          rollbackHandled = true;
          throw error;
        }
      };

      await expect(
        runTransaction(async (ctx) => {
          ctx.events.push(
            new BookingCreatedEvent({
              bookingId: 'book_rollback',
              eventId: 'evt_rb_01',
              sourceVersion: 1,
              timestamp: sampleDate,
            }),
          );
          throw new Error('Database constraint violation - Rolling back');
        }),
      ).rejects.toThrow('Database constraint violation - Rolling back');

      // Crucial assertion: publisher was never invoked for discarded context
      expect(mockEventEmitter.emitAsync).not.toHaveBeenCalled();
      expect(rollbackHandled).toBe(true);
    });

    it('emits events only after transaction successfully commits and caller invokes publish', async () => {
      const createdEvent = new BookingCreatedEvent({
        bookingId: 'book_commit',
        eventId: 'evt_commit_01',
        sourceVersion: 1,
        timestamp: sampleDate,
      });

      const runTransaction = async (
        work: (ctx: TransactionEventContext) => Promise<string>,
      ) => {
        const ctx = publisher.createContext(mockTx);
        const result = await work(ctx);
        // Post-commit publish
        await publisher.publish(ctx.events);
        return result;
      };

      const result = await runTransaction(async (ctx) => {
        ctx.events.push(createdEvent);
        return 'SUCCESS';
      });

      expect(result).toBe('SUCCESS');
      expect(mockEventEmitter.emitAsync).toHaveBeenCalledTimes(1);
      expect(mockEventEmitter.emitAsync).toHaveBeenCalledWith(
        BOOKING_EVENTS.CREATED,
        createdEvent,
      );
    });
  });

  describe('3. Collector Isolation Across Retry Attempts', () => {
    it('allocates a fresh empty collector per attempt so failed attempts do not leak events', async () => {
      const attempts: TransactionEventContext[] = [];
      let attemptCount = 0;

      const runWithRetry = async () => {
        while (attemptCount < 3) {
          attemptCount++;
          const txClient = { id: `tx_attempt_${attemptCount}` } as unknown as Prisma.TransactionClient;
          const ctx = publisher.createContext(txClient);
          attempts.push(ctx);

          if (attemptCount < 3) {
            // Failed attempt adds an event, then aborts
            ctx.events.push(
              new BookingFailedEvent({
                bookingId: `book_retry_${attemptCount}`,
                eventId: `evt_fail_${attemptCount}`,
                sourceVersion: 1,
                timestamp: sampleDate,
                failureReason: 'TRANSIENT_LOCK_TIMEOUT',
              }),
            );
            continue; // retry
          }

          // Successful attempt adds the definitive event
          const successfulEvent = new BookingConfirmedEvent({
            bookingId: 'book_retry_final',
            eventId: 'evt_confirm_final',
            sourceVersion: 2,
            timestamp: sampleDate,
          });
          ctx.events.push(successfulEvent);

          // Only the committed context is published
          await publisher.publish(ctx.events);
          return;
        }
      };

      await runWithRetry();

      expect(attempts).toHaveLength(3);
      // Attempt 1 and 2 had their own collectors
      expect(attempts[0].events).toHaveLength(1);
      expect(attempts[1].events).toHaveLength(1);
      expect(attempts[2].events).toHaveLength(1);

      // Verify array references are completely isolated
      expect(attempts[0].events).not.toBe(attempts[1].events);
      expect(attempts[1].events).not.toBe(attempts[2].events);

      // Only attempt 3 (the committed one) was emitted to the bus
      expect(mockEventEmitter.emitAsync).toHaveBeenCalledTimes(1);
      expect(mockEventEmitter.emitAsync).toHaveBeenCalledWith(
        BOOKING_EVENTS.CONFIRMED,
        attempts[2].events[0],
      );
    });
  });

  describe('4. Dispatch Error Isolation', () => {
    it('does not reject or throw when event listener throws synchronous error', async () => {
      mockEventEmitter.emitAsync.mockImplementationOnce(() => {
        throw new Error('Sync listener error in projection handler');
      });

      const event = new BookingConfirmedEvent({
        bookingId: 'book_err_sync',
        eventId: 'evt_err_sync',
        sourceVersion: 2,
        timestamp: sampleDate,
      });

      await expect(publisher.publish([event])).resolves.not.toThrow();
      expect(mockEventEmitter.emitAsync).toHaveBeenCalledWith(
        BOOKING_EVENTS.CONFIRMED,
        event,
      );
    });

    it('does not reject or throw when event listener rejects asynchronous promise', async () => {
      mockEventEmitter.emitAsync.mockRejectedValueOnce(
        new Error('Async projection database connection dropped'),
      );

      const event = new BookingConfirmedEvent({
        bookingId: 'book_err_async',
        eventId: 'evt_err_async',
        sourceVersion: 2,
        timestamp: sampleDate,
      });

      await expect(publisher.publish([event])).resolves.not.toThrow();
      expect(mockEventEmitter.emitAsync).toHaveBeenCalledWith(
        BOOKING_EVENTS.CONFIRMED,
        event,
      );
    });

    it('continues dispatching subsequent events when an earlier event rejects', async () => {
      const event1 = new BookingCreatedEvent({
        bookingId: 'book_multi_1',
        eventId: 'evt_m1',
        sourceVersion: 1,
        timestamp: sampleDate,
      });
      const event2 = new BookingConfirmedEvent({
        bookingId: 'book_multi_2',
        eventId: 'evt_m2',
        sourceVersion: 2,
        timestamp: sampleDate,
      });

      // First event fails, second event succeeds
      mockEventEmitter.emitAsync
        .mockRejectedValueOnce(new Error('First event failed'))
        .mockResolvedValueOnce([]);

      await expect(publisher.publish([event1, event2])).resolves.not.toThrow();

      expect(mockEventEmitter.emitAsync).toHaveBeenCalledTimes(2);
      expect(mockEventEmitter.emitAsync).toHaveBeenNthCalledWith(
        1,
        BOOKING_EVENTS.CREATED,
        event1,
      );
      expect(mockEventEmitter.emitAsync).toHaveBeenNthCalledWith(
        2,
        BOOKING_EVENTS.CONFIRMED,
        event2,
      );
    });
  });

  describe('5. Proper Event Name Resolution & Payload Forwarding', () => {
    it('resolves and dispatches all 11 booking events with correct contract name and payload', async () => {
      const allEvents: DomainEventBase[] = [
        new BookingCreatedEvent({
          bookingId: 'b1',
          eventId: 'e1',
          sourceVersion: 1,
          timestamp: sampleDate,
          status: 'PROCESSING',
        }),
        new BookingConfirmedEvent({
          bookingId: 'b2',
          eventId: 'e2',
          sourceVersion: 2,
          timestamp: sampleDate,
          status: 'CONFIRMED',
        }),
        new BookingFailedEvent({
          bookingId: 'b3',
          eventId: 'e3',
          sourceVersion: 2,
          timestamp: sampleDate,
          status: 'FAILED',
          failureReason: 'PAYMENT_FAILED',
        }),
        new BookingCompletedEvent({
          bookingId: 'b4',
          eventId: 'e4',
          sourceVersion: 3,
          timestamp: sampleDate,
          status: 'COMPLETED',
        }),
        new BookingRecoveryResolvedEvent({
          bookingId: 'b5',
          eventId: 'e5',
          sourceVersion: 2,
          timestamp: sampleDate,
          status: 'CONFIRMED',
          recoveryOutcome: 'CONFIRMED_AFTER_PROCESSING',
        }),
        new BookingCancellationPendingEvent({
          bookingId: 'b6',
          eventId: 'e6',
          sourceVersion: 2,
          timestamp: sampleDate,
          status: 'CANCELLATION_PENDING',
          reason: 'USER_CANCELLED',
        }),
        new BookingCancelledEvent({
          bookingId: 'b7',
          eventId: 'e7',
          sourceVersion: 3,
          timestamp: sampleDate,
          status: 'CANCELLED',
          reason: 'REFUNDED',
        }),
        new BookingDisruptionSyncedEvent({
          bookingId: 'b8',
          eventId: 'e8',
          sourceVersion: 2,
          timestamp: sampleDate,
          status: 'CONFIRMED',
          revisionId: 'rev_1',
        }),
        new BookingDisruptionAcknowledgedEvent({
          bookingId: 'b9',
          eventId: 'e9',
          sourceVersion: 3,
          timestamp: sampleDate,
          status: 'CONFIRMED',
          disruptionId: 'disr_1',
        }),
        new BookingDisruptionAcceptedEvent({
          bookingId: 'b10',
          eventId: 'e10',
          sourceVersion: 4,
          timestamp: sampleDate,
          status: 'CONFIRMED',
          disruptionId: 'disr_1',
        }),
        new BookingRefundUpdatedEvent({
          bookingId: 'b11',
          eventId: 'e11',
          sourceVersion: 3,
          timestamp: sampleDate,
          status: 'CANCELLED',
          refundStatus: 'SUCCEEDED',
        }),
      ];

      const expectedNames = [
        BOOKING_EVENTS.CREATED,
        BOOKING_EVENTS.CONFIRMED,
        BOOKING_EVENTS.FAILED,
        BOOKING_EVENTS.COMPLETED,
        BOOKING_EVENTS.RECOVERY_RESOLVED,
        BOOKING_EVENTS.CANCELLATION_PENDING,
        BOOKING_EVENTS.CANCELLED,
        BOOKING_EVENTS.DISRUPTION_SYNCED,
        BOOKING_EVENTS.DISRUPTION_ACKNOWLEDGED,
        BOOKING_EVENTS.DISRUPTION_ACCEPTED,
        BOOKING_EVENTS.REFUND_UPDATED,
      ];

      await publisher.publish(allEvents);

      expect(mockEventEmitter.emitAsync).toHaveBeenCalledTimes(11);
      expectedNames.forEach((expectedName, index) => {
        expect(mockEventEmitter.emitAsync).toHaveBeenNthCalledWith(
          index + 1,
          expectedName,
          allEvents[index],
        );
      });
    });

    it('resolves and dispatches RefundSettledEvent with refund.settled event name', async () => {
      const refundEvent = new RefundSettledEvent({
        eventId: 'evt_ref_01',
        refundId: 'ref_123',
        amount: 5400,
        currency: 'USD',
        timestamp: sampleDate,
        bookingId: 'book_ref_123',
      });

      await publisher.publish([refundEvent]);

      expect(mockEventEmitter.emitAsync).toHaveBeenCalledTimes(1);
      expect(mockEventEmitter.emitAsync).toHaveBeenCalledWith(
        REFUND_EVENTS.SETTLED,
        refundEvent,
      );
    });

    it('resolves event name using resolveEventName helper', () => {
      const event = new BookingCreatedEvent({
        bookingId: 'b_test',
        eventId: 'e_test',
        sourceVersion: 1,
      });

      expect(resolveEventName(event)).toBe(BOOKING_EVENTS.CREATED);
      expect(publisher.resolveEventName(event)).toBe(BOOKING_EVENTS.CREATED);
    });
  });

  describe('6. Handling Empty / Undefined / Malformed Events', () => {
    it('handles empty events array without calling emitAsync', async () => {
      await expect(publisher.publish([])).resolves.not.toThrow();
      expect(mockEventEmitter.emitAsync).not.toHaveBeenCalled();
    });

    it('handles null and undefined input gracefully', async () => {
      await expect(publisher.publish(undefined as any)).resolves.not.toThrow();
      await expect(publisher.publish(null as any)).resolves.not.toThrow();
      expect(mockEventEmitter.emitAsync).not.toHaveBeenCalled();
    });

    it('handles array containing null/undefined elements without throwing', async () => {
      await expect(
        publisher.publish([null as any, undefined as any]),
      ).resolves.not.toThrow();
      expect(mockEventEmitter.emitAsync).not.toHaveBeenCalled();
    });

    it('skips unrecognized objects without failing the batch', async () => {
      const validEvent = new BookingCreatedEvent({
        bookingId: 'b_valid',
        eventId: 'e_valid',
        sourceVersion: 1,
      });
      const unrecognized = { randomField: 'value' };

      await expect(
        publisher.publish([unrecognized as any, validEvent]),
      ).resolves.not.toThrow();

      // Only the valid recognized event should be emitted
      expect(mockEventEmitter.emitAsync).toHaveBeenCalledTimes(1);
      expect(mockEventEmitter.emitAsync).toHaveBeenCalledWith(
        BOOKING_EVENTS.CREATED,
        validEvent,
      );
    });

    it('logs only bounded metadata for unrecognized events without exposing payload data', async () => {
      const secret = 'passenger@example.com / passport-123 / card-456';
      const unrecognized: Record<string, unknown> = {
        bookingId: secret,
        passenger: { email: secret },
      };
      unrecognized.self = unrecognized;
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      try {
        await expect(
          publisher.publish([unrecognized as unknown as DomainEventBase]),
        ).resolves.not.toThrow();

        expect(warnSpy).toHaveBeenCalledTimes(1);
        const warning = String(warnSpy.mock.calls[0]?.[0]);
        expect(warning).toContain('Could not resolve event name for domain event');
        expect(warning).not.toContain(secret);
        expect(warning.length).toBeLessThan(256);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe('7. EventEmitter Fallback & Nest Module Composition', () => {
    it('instantiates cleanly with fallback EventEmitter2 when no EventEmitter2 is injected', async () => {
      const serviceWithoutInjection = new BookingEventPublisherService();

      expect(serviceWithoutInjection).toBeDefined();
      // Should publish without error using the internal fallback instance
      const event = new BookingCreatedEvent({
        bookingId: 'b_fallback',
        eventId: 'e_fallback',
        sourceVersion: 1,
      });
      await expect(
        serviceWithoutInjection.publish([event]),
      ).resolves.not.toThrow();
    });

    it('resolves through TestingModule via DomainEventsModule without requiring root EventEmitterModule', async () => {
      const module: TestingModule = await Test.createTestingModule({
        imports: [DomainEventsModule],
      }).compile();

      const service = module.get<BookingEventPublisherService>(
        BookingEventPublisherService,
      );
      expect(service).toBeDefined();
      expect(service).toBeInstanceOf(BookingEventPublisherService);
    });
  });
});
