import { BookingFailureReason, BookingStatus, RefundStatus, RefundTriggerType } from '@prisma/client';
import { BookingRecoveryService } from './booking-recovery.service';
import { BookingWithRelations } from './booking-lifecycle.types';

type InternalLockRecoveryService = {
  reconcileBookingWithLock: (bookingId: string) => Promise<void>;
};

const internalService = (s: unknown): InternalLockRecoveryService =>
  s as unknown as InternalLockRecoveryService;

describe('BookingRecoveryService', () => {
  let service: BookingRecoveryService;
  let mockPrisma: any;
  let mockStripeService: any;
  let mockDuffelService: any;
  let mockRefundTransactionService: any;
  let mockRefundSettlementService: any;
  let mockBookingLifecycleService: any;
  let mockCacheService: any;
  let mockPublisher: any;

  beforeEach(() => {
    mockPrisma = {
      $transaction: jest.fn().mockImplementation(async (cb: any) => {
        if (typeof cb === 'function') {
          return cb(mockPrisma);
        }
        return cb;
      }),
      booking: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      payment: {
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      paymentEvent: {
        findFirst: jest.fn(),
        create: jest.fn(),
      },
      ledgerEntry: {
        createMany: jest.fn(),
      },
      bookingIntent: {
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      refund: {
        findMany: jest.fn(),
      },
    };

    mockStripeService = {
      retrievePaymentIntent: jest.fn(),
      cancelPaymentIntent: jest.fn(),
      createRefund: jest.fn(),
    };

    mockDuffelService = {
      cancelOrder: jest.fn(),
      mapDuffelOrderToSnapshots: jest.fn(),
    };

    mockRefundTransactionService = {
      reserveTransaction: jest.fn(),
    };

    mockRefundSettlementService = {
      settleVerifiedOutcome: jest.fn(),
    };

    mockCacheService = {
      acquireLock: jest.fn().mockResolvedValue(true),
      releaseLock: jest.fn().mockResolvedValue(true),
    };

    mockPublisher = {
      createContext: jest.fn((tx: any) => ({ tx, events: [] })),
      publish: jest.fn().mockResolvedValue(undefined),
    };

    mockBookingLifecycleService = {
      checkAndCompleteBooking: jest.fn(),
      confirmBooking: jest.fn().mockImplementation(async (id, pnr, orderId, flight, passenger, tx, eventContext) => {
        if (eventContext?.events) {
          eventContext.events.push({
            eventId: 'evt-confirmed-1',
            bookingId: id,
            eventName: 'booking.confirmed',
          });
        }
        return { id, status: BookingStatus.CONFIRMED, pnrReference: pnr, duffelOrderId: orderId };
      }),
      failBooking: jest.fn().mockImplementation(async (id, reason, flight, passenger, dep, tx, eventContext) => {
        if (eventContext?.events) {
          eventContext.events.push({
            eventId: 'evt-failed-1',
            bookingId: id,
            eventName: 'booking.failed',
          });
        }
        return { id, status: BookingStatus.FAILED, failureReason: reason };
      }),
    };

    service = new BookingRecoveryService(
      mockPrisma,
      mockStripeService,
      mockDuffelService,
      mockRefundTransactionService,
      mockRefundSettlementService,
      mockBookingLifecycleService,
      mockCacheService,
      mockPublisher,
    );
  });

  describe('reconcileBookingIfStale', () => {
    const staleDate = new Date(Date.now() - 20 * 60 * 1000);
    const recentDate = new Date(Date.now() - 5 * 60 * 1000);

    it('returns booking untouched if status is not PROCESSING', async () => {
      const booking = {
        id: 'b-1',
        status: BookingStatus.CONFIRMED,
        createdAt: staleDate,
      } as unknown as BookingWithRelations;

      const result = await service.reconcileBookingIfStale(booking);

      expect(result).toBe(booking);
      expect(mockPrisma.booking.updateMany).not.toHaveBeenCalled();
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('returns booking untouched if createdAt is less than 15 minutes ago', async () => {
      const booking = {
        id: 'b-1',
        status: BookingStatus.PROCESSING,
        createdAt: recentDate,
      } as unknown as BookingWithRelations;

      const result = await service.reconcileBookingIfStale(booking);

      expect(result).toBe(booking);
      expect(mockPrisma.booking.updateMany).not.toHaveBeenCalled();
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('marks booking FAILED with BOOKING_TIMEOUT if missing stripePaymentIntentId (Branch 4)', async () => {
      const booking = {
        id: 'b-1',
        status: BookingStatus.PROCESSING,
        createdAt: staleDate,
        payment: null,
      } as unknown as BookingWithRelations;

      const result = await service.reconcileBookingIfStale(booking);

      expect(result.status).toBe(BookingStatus.FAILED);
      expect(result.failureReason).toBe(BookingFailureReason.BOOKING_TIMEOUT);
      expect(mockPrisma.$transaction).toHaveBeenCalled();
      expect(mockBookingLifecycleService.failBooking).toHaveBeenCalledWith(
        'b-1',
        BookingFailureReason.BOOKING_TIMEOUT,
        undefined,
        undefined,
        undefined,
        expect.anything(),
        expect.objectContaining({ events: expect.any(Array) }),
      );
      expect(mockPublisher.publish).toHaveBeenCalledWith([
        expect.objectContaining({
          eventId: 'evt-failed-1',
          bookingId: 'b-1',
          eventName: 'booking.failed',
        }),
      ]);
    });

    it('handles incomplete Stripe payment: cancels Duffel order, cancels Stripe intent, and marks booking FAILED with CAPTURE_FAILED (Branch 2)', async () => {
      const booking = {
        id: 'b-1',
        status: BookingStatus.PROCESSING,
        createdAt: staleDate,
        payment: {
          id: 'pay-1',
          stripePaymentIntentId: 'pi_123',
        },
      } as unknown as BookingWithRelations;

      mockStripeService.retrievePaymentIntent.mockResolvedValue({
        status: 'requires_payment_method',
      });
      mockPrisma.paymentEvent.findFirst.mockImplementation(async ({ where }: any) => {
        if (where?.eventType === 'duffel_order_cancelled') return null;
        if (where?.eventType === 'duffel_order_created') return { metadata: { id: 'ord_123' } };
        return null;
      });
      mockDuffelService.cancelOrder.mockResolvedValue({});
      mockStripeService.cancelPaymentIntent.mockResolvedValue({});
      mockPrisma.payment.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.reconcileBookingIfStale(booking);

      expect(mockDuffelService.cancelOrder).toHaveBeenCalledWith('ord_123');
      expect(mockPrisma.paymentEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            paymentId: 'pay-1',
            eventType: 'duffel_order_cancelled',
            metadata: { duffelOrderId: 'ord_123' },
          }),
        }),
      );
      expect(mockStripeService.cancelPaymentIntent).toHaveBeenCalledWith('pi_123');
      expect(result.status).toBe(BookingStatus.FAILED);
      expect(result.failureReason).toBe(BookingFailureReason.CAPTURE_FAILED);
      expect(mockPrisma.$transaction).toHaveBeenCalled();
      expect(mockBookingLifecycleService.failBooking).toHaveBeenCalledWith(
        'b-1',
        BookingFailureReason.CAPTURE_FAILED,
        undefined,
        undefined,
        undefined,
        expect.anything(),
        expect.objectContaining({ events: expect.any(Array) }),
      );
      expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith({
        where: { id: 'pay-1', status: { notIn: ['CANCELLED', 'REFUNDED'] } },
        data: { status: 'CANCELLED' },
      });
      expect(mockPublisher.publish).toHaveBeenCalledWith([
        expect.objectContaining({
          eventId: 'evt-failed-1',
          bookingId: 'b-1',
          eventName: 'booking.failed',
        }),
      ]);
    });

    it('handles Stripe payment succeeded with existing Duffel order: confirms booking and syncs payment and publisher (Branch 1)', async () => {
      const booking = {
        id: 'b-1',
        bookingIntentId: 'intent-1',
        status: BookingStatus.PROCESSING,
        createdAt: staleDate,
        payment: {
          id: 'pay-1',
          stripePaymentIntentId: 'pi_123',
        },
      } as unknown as BookingWithRelations;

      mockStripeService.retrievePaymentIntent.mockResolvedValue({ status: 'succeeded' });
      mockPrisma.paymentEvent.findFirst.mockResolvedValue({
        metadata: {
          id: 'ord_123',
          booking_reference: 'PNR999',
          passengers: [{ given_name: 'REDACTED', family_name: 'REDACTED' }],
        },
      });
      mockPrisma.bookingIntent.findUnique.mockResolvedValue({
        id: 'intent-1',
        passengers: [{ givenName: 'John', familyName: 'Doe', duffelPassengerId: 'pas_1' }],
        user: { email: 'john@example.com' },
      });
      mockDuffelService.mapDuffelOrderToSnapshots.mockReturnValue({
        flightSnapshot: {
          segments: [{ departureAt: '2026-09-01T10:00:00.000Z' }],
        },
        passengerSnapshot: {
          passengers: [{ firstName: 'John', lastName: 'Doe' }],
        },
      });
      mockPrisma.payment.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.reconcileBookingIfStale(booking);

      expect(result.status).toBe(BookingStatus.CONFIRMED);
      expect(result.pnrReference).toBe('PNR999');
      expect(result.duffelOrderId).toBe('ord_123');
      expect(mockPrisma.$transaction).toHaveBeenCalled();
      expect(mockBookingLifecycleService.confirmBooking).toHaveBeenCalledWith(
        'b-1',
        'PNR999',
        'ord_123',
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ events: expect.any(Array) }),
      );
      expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith({
        where: { id: 'pay-1', status: { notIn: ['SUCCEEDED', 'REFUNDED', 'CANCELLED'] } },
        data: { status: 'SUCCEEDED' },
      });
      expect(mockPublisher.publish).toHaveBeenCalledWith([
        expect.objectContaining({
          eventId: 'evt-confirmed-1',
          bookingId: 'b-1',
          eventName: 'booking.confirmed',
        }),
      ]);
    });

    it('skips malformed persisted passenger entries while recovering a valid Duffel order', async () => {
      const booking = {
        id: 'b-1',
        bookingIntentId: 'intent-1',
        status: BookingStatus.PROCESSING,
        createdAt: staleDate,
        payment: {
          id: 'pay-1',
          stripePaymentIntentId: 'pi_123',
        },
      } as unknown as BookingWithRelations;

      mockStripeService.retrievePaymentIntent.mockResolvedValue({ status: 'succeeded' });
      mockPrisma.paymentEvent.findFirst.mockResolvedValue({
        metadata: {
          id: 'ord_123',
          booking_reference: 'PNR999',
          passengers: [null],
        },
      });
      mockPrisma.bookingIntent.findUnique.mockResolvedValue({
        id: 'intent-1',
        passengers: [
          {
            givenName: 'John',
            familyName: 'Doe',
            dateOfBirth: new Date('1980-01-01T00:00:00.000Z'),
            duffelPassengerId: null,
          },
        ],
        user: { email: 'john@example.com' },
      });
      mockDuffelService.mapDuffelOrderToSnapshots.mockReturnValue({
        flightSnapshot: { segments: [{ departureAt: '2026-09-01T10:00:00.000Z' }] },
        passengerSnapshot: { passengers: [] },
      });

      await expect(service.reconcileBookingIfStale(booking)).resolves.toMatchObject({
        status: BookingStatus.CONFIRMED,
        pnrReference: 'PNR999',
        duffelOrderId: 'ord_123',
      });
      expect(mockDuffelService.mapDuffelOrderToSnapshots).toHaveBeenCalled();
      expect(mockBookingLifecycleService.confirmBooking).toHaveBeenCalledWith(
        'b-1',
        'PNR999',
        'ord_123',
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ events: expect.any(Array) }),
      );
    });

    it('handles Stripe payment succeeded but NO Duffel order: marks FAILED with SYSTEM_ERROR and triggers automated refund (Branch 3)', async () => {
      const booking = {
        id: 'b-1',
        status: BookingStatus.PROCESSING,
        createdAt: staleDate,
        payment: {
          id: 'pay-1',
          stripePaymentIntentId: 'pi_123',
        },
      } as unknown as BookingWithRelations;

      mockStripeService.retrievePaymentIntent.mockResolvedValue({ status: 'succeeded' });
      mockPrisma.paymentEvent.findFirst.mockResolvedValue(null);

      mockPrisma.payment.findUnique.mockResolvedValue({
        id: 'pay-1',
        amount: 5000,
        currency: 'USD',
        stripePaymentIntentId: 'pi_123',
      });
      mockPrisma.refund.findMany.mockResolvedValue([]);
      mockRefundTransactionService.reserveTransaction.mockResolvedValue({
        id: 'ref-1',
        status: RefundStatus.REFUND_PENDING,
      });
      mockStripeService.createRefund.mockResolvedValue({ id: 're_123' });
      mockRefundSettlementService.settleVerifiedOutcome.mockResolvedValue({
        transactionStatus: RefundStatus.SUCCEEDED,
      });

      const result = await service.reconcileBookingIfStale(booking);

      expect(result.status).toBe(BookingStatus.FAILED);
      expect(result.failureReason).toBe(BookingFailureReason.SYSTEM_ERROR);
      expect(mockPrisma.$transaction).toHaveBeenCalled();
      expect(mockBookingLifecycleService.failBooking).toHaveBeenCalledWith(
        'b-1',
        BookingFailureReason.SYSTEM_ERROR,
        undefined,
        undefined,
        undefined,
        expect.anything(),
        expect.objectContaining({ events: expect.any(Array) }),
      );
      expect(mockPublisher.publish).toHaveBeenCalledWith([
        expect.objectContaining({
          eventId: 'evt-failed-1',
          bookingId: 'b-1',
          eventName: 'booking.failed',
        }),
      ]);
      expect(mockRefundTransactionService.reserveTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'DIRECT',
          paymentId: 'pay-1',
          amount: 5000,
          currency: 'USD',
          triggerType: RefundTriggerType.SYSTEM_AUTOMATED,
        }),
      );
      expect(mockStripeService.createRefund).toHaveBeenCalledWith(
        'pi_123',
        5000,
        'Stale processing booking timeout without duffel order',
        expect.stringContaining('stripe-refund'),
      );
      expect(mockRefundSettlementService.settleVerifiedOutcome).toHaveBeenCalledWith(
        expect.objectContaining({
          transactionId: 'ref-1',
          outcome: expect.objectContaining({
            status: 'SUCCEEDED',
            providerReference: 're_123',
          }),
        }),
      );
    });

    it('settles refund as FAILED if stripe createRefund throws during automated refund', async () => {
      const booking = {
        id: 'b-1',
        status: BookingStatus.PROCESSING,
        createdAt: staleDate,
        payment: {
          id: 'pay-1',
          stripePaymentIntentId: 'pi_123',
        },
      } as unknown as BookingWithRelations;

      mockStripeService.retrievePaymentIntent.mockResolvedValue({ status: 'succeeded' });
      mockPrisma.paymentEvent.findFirst.mockResolvedValue(null);

      mockPrisma.payment.findUnique.mockResolvedValue({
        id: 'pay-1',
        amount: 5000,
        currency: 'USD',
        stripePaymentIntentId: 'pi_123',
      });
      mockPrisma.refund.findMany.mockResolvedValue([]);
      mockRefundTransactionService.reserveTransaction.mockResolvedValue({
        id: 'ref-1',
        status: RefundStatus.REFUND_PENDING,
      });
      mockStripeService.createRefund.mockRejectedValue(new Error('Stripe API network timeout'));

      const result = await service.reconcileBookingIfStale(booking);

      expect(result.status).toBe(BookingStatus.FAILED);
      expect(mockRefundSettlementService.settleVerifiedOutcome).toHaveBeenCalledWith(
        expect.objectContaining({
          transactionId: 'ref-1',
          outcome: expect.objectContaining({
            status: 'FAILED',
          }),
        }),
      );
    });

    it('skips triggerAutomatedRefund if failBooking produces zero transition events (Branch 3 duplicate protection)', async () => {
      const booking = {
        id: 'b-1',
        status: BookingStatus.PROCESSING,
        createdAt: staleDate,
        payment: {
          id: 'pay-1',
          stripePaymentIntentId: 'pi_123',
        },
      } as unknown as BookingWithRelations;

      mockStripeService.retrievePaymentIntent.mockResolvedValue({ status: 'succeeded' });
      mockPrisma.paymentEvent.findFirst.mockResolvedValue(null);

      // Simulate concurrent transition: failBooking does NOT push events into eventContext
      mockBookingLifecycleService.failBooking.mockImplementation(
        async (
          _id: string,
          _reason: BookingFailureReason,
          _flight: unknown,
          _passenger: unknown,
          _dep: unknown,
          _tx: unknown,
          _ctx: unknown,
        ) => {
          return { id: 'b-1', status: BookingStatus.FAILED };
        },
      );

      const result = await service.reconcileBookingIfStale(booking);

      expect(mockBookingLifecycleService.failBooking).toHaveBeenCalledWith(
        'b-1',
        BookingFailureReason.SYSTEM_ERROR,
        undefined,
        undefined,
        undefined,
        expect.anything(),
        expect.anything(),
      );
      expect(mockPublisher.publish).not.toHaveBeenCalled();
      expect(mockRefundTransactionService.reserveTransaction).not.toHaveBeenCalled();
      expect(mockStripeService.createRefund).not.toHaveBeenCalled();
      expect(mockRefundSettlementService.settleVerifiedOutcome).not.toHaveBeenCalled();
      expect(result.status).toBe(BookingStatus.PROCESSING);
    });

    it('publishes zero events if transaction rolls back and preserves existing financial and booking records without duplicate writes', async () => {
      const booking = {
        id: 'b-1',
        status: BookingStatus.PROCESSING,
        createdAt: staleDate,
        payment: { id: 'p-1', stripePaymentIntentId: 'pi-1' },
      } as unknown as BookingWithRelations;

      mockStripeService.retrievePaymentIntent.mockResolvedValue({ status: 'succeeded' });
      mockPrisma.paymentEvent.findFirst.mockResolvedValue({ metadata: { id: 'ord-1' } });
      mockDuffelService.mapDuffelOrderToSnapshots.mockReturnValue({
        flightSnapshot: { segments: [{ departureAt: new Date().toISOString() }] },
        passengerSnapshot: { passengers: [] },
      });

      mockPrisma.$transaction.mockRejectedValue(new Error('Transaction deadlock'));

      await expect(service.reconcileBookingIfStale(booking)).rejects.toThrow('Transaction deadlock');
      expect(mockPublisher.publish).not.toHaveBeenCalled();
      expect(mockPrisma.paymentEvent.create).not.toHaveBeenCalled();
      expect(mockPrisma.ledgerEntry.createMany).not.toHaveBeenCalled();
      expect(mockPrisma.bookingIntent.update).not.toHaveBeenCalled();
      expect(mockPrisma.bookingIntent.updateMany).not.toHaveBeenCalled();
    });

    it('does not publish events while transaction is unresolved and publishes one committed batch after resolution', async () => {
      const booking = {
        id: 'b-1',
        status: BookingStatus.PROCESSING,
        createdAt: staleDate,
        payment: null,
      } as unknown as BookingWithRelations;

      let publishCalledDuringTransaction = false;
      mockPrisma.$transaction.mockImplementation(async (cb: any) => {
        publishCalledDuringTransaction = mockPublisher.publish.mock.calls.length > 0;
        return cb(mockPrisma);
      });

      await service.reconcileBookingIfStale(booking);

      expect(publishCalledDuringTransaction).toBe(false);
      expect(mockPublisher.publish).toHaveBeenCalledTimes(1);
    });

    it('does not update payment or mutate status if lifecycle booking transition produces zero count (no-op)', async () => {
      const booking = {
        id: 'b-1',
        status: BookingStatus.PROCESSING,
        createdAt: staleDate,
        payment: { id: 'p-1', stripePaymentIntentId: 'pi-1' },
      } as unknown as BookingWithRelations;

      mockStripeService.retrievePaymentIntent.mockResolvedValue({ status: 'succeeded' });
      mockPrisma.paymentEvent.findFirst.mockResolvedValue({ metadata: { id: 'ord-1' } });
      mockDuffelService.mapDuffelOrderToSnapshots.mockReturnValue({
        flightSnapshot: { segments: [{ departureAt: new Date().toISOString() }] },
        passengerSnapshot: { passengers: [] },
      });

      // Simulate lifecycle confirmBooking returning without adding events (count 0 / concurrent transition)
      mockBookingLifecycleService.confirmBooking.mockResolvedValue({ id: 'b-1', status: 'CONFIRMED' });

      await service.reconcileBookingIfStale(booking);

      expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('skips Duffel cancelOrder and Stripe cancelPaymentIntent if payment.status is already CANCELLED', async () => {
      const booking = {
        id: 'b-1',
        status: BookingStatus.PROCESSING,
        createdAt: staleDate,
        payment: {
          id: 'pay-1',
          status: 'CANCELLED',
          stripePaymentIntentId: 'pi_123',
        },
      } as unknown as BookingWithRelations;

      mockStripeService.retrievePaymentIntent.mockResolvedValue({
        status: 'requires_payment_method',
      });

      const result = await service.reconcileBookingIfStale(booking);

      expect(mockDuffelService.cancelOrder).not.toHaveBeenCalled();
      expect(mockStripeService.cancelPaymentIntent).not.toHaveBeenCalled();
      expect(mockPrisma.paymentEvent.create).not.toHaveBeenCalled();
      expect(result.status).toBe(BookingStatus.FAILED);
      expect(result.failureReason).toBe(BookingFailureReason.CAPTURE_FAILED);
    });

    it('skips Duffel cancelOrder and Stripe cancelPaymentIntent if payment.status is already REFUNDED', async () => {
      const booking = {
        id: 'b-1',
        status: BookingStatus.PROCESSING,
        createdAt: staleDate,
        payment: {
          id: 'pay-1',
          status: 'REFUNDED',
          stripePaymentIntentId: 'pi_123',
        },
      } as unknown as BookingWithRelations;

      mockStripeService.retrievePaymentIntent.mockResolvedValue({
        status: 'requires_payment_method',
      });

      const result = await service.reconcileBookingIfStale(booking);

      expect(mockDuffelService.cancelOrder).not.toHaveBeenCalled();
      expect(mockStripeService.cancelPaymentIntent).not.toHaveBeenCalled();
      expect(mockPrisma.paymentEvent.create).not.toHaveBeenCalled();
      expect(result.status).toBe(BookingStatus.FAILED);
    });

    it('skips Stripe cancelPaymentIntent if intent.status is canceled', async () => {
      const booking = {
        id: 'b-1',
        status: BookingStatus.PROCESSING,
        createdAt: staleDate,
        payment: {
          id: 'pay-1',
          status: 'AUTHORIZED',
          stripePaymentIntentId: 'pi_123',
        },
      } as unknown as BookingWithRelations;

      mockStripeService.retrievePaymentIntent.mockResolvedValue({
        status: 'canceled',
      });
      mockPrisma.paymentEvent.findFirst.mockImplementation(async ({ where }: any) => {
        if (where?.eventType === 'duffel_order_cancelled') return null;
        if (where?.eventType === 'duffel_order_created') return { metadata: { id: 'ord_123' } };
        return null;
      });
      mockDuffelService.cancelOrder.mockResolvedValue({});
      mockPrisma.payment.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.reconcileBookingIfStale(booking);

      expect(mockDuffelService.cancelOrder).toHaveBeenCalledWith('ord_123');
      expect(mockPrisma.paymentEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            paymentId: 'pay-1',
            eventType: 'duffel_order_cancelled',
            metadata: { duffelOrderId: 'ord_123' },
          }),
        }),
      );
      expect(mockStripeService.cancelPaymentIntent).not.toHaveBeenCalled();
      expect(result.status).toBe(BookingStatus.FAILED);
    });

    it('skips Duffel cancelOrder if duffel_order_cancelled event already exists', async () => {
      const booking = {
        id: 'b-1',
        status: BookingStatus.PROCESSING,
        createdAt: staleDate,
        payment: {
          id: 'pay-1',
          status: 'AUTHORIZED',
          stripePaymentIntentId: 'pi_123',
        },
      } as unknown as BookingWithRelations;

      mockStripeService.retrievePaymentIntent.mockResolvedValue({
        status: 'requires_payment_method',
      });
      mockPrisma.paymentEvent.findFirst.mockImplementation(async ({ where }: any) => {
        if (where?.eventType === 'duffel_order_cancelled') {
          return { id: BigInt(1), eventType: 'duffel_order_cancelled' };
        }
        return null;
      });
      mockStripeService.cancelPaymentIntent.mockResolvedValue({});
      mockPrisma.payment.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.reconcileBookingIfStale(booking);

      expect(mockDuffelService.cancelOrder).not.toHaveBeenCalled();
      expect(mockPrisma.paymentEvent.create).not.toHaveBeenCalled();
      expect(mockStripeService.cancelPaymentIntent).toHaveBeenCalledWith('pi_123');
      expect(result.status).toBe(BookingStatus.FAILED);
    });

    it('does not update payment or mutate status if failBooking produces zero count (concurrent transition)', async () => {
      const booking = {
        id: 'b-1',
        status: BookingStatus.PROCESSING,
        createdAt: staleDate,
        payment: { id: 'p-1', stripePaymentIntentId: 'pi-1' },
      } as unknown as BookingWithRelations;

      mockStripeService.retrievePaymentIntent.mockResolvedValue({
        status: 'requires_payment_method',
      });
      mockPrisma.paymentEvent.findFirst.mockResolvedValue(null);
      mockStripeService.cancelPaymentIntent.mockResolvedValue({});

      // Simulate lifecycle failBooking returning without adding events (count 0 / concurrent transition)
      mockBookingLifecycleService.failBooking.mockResolvedValue({ id: 'b-1', status: 'FAILED' });

      await service.reconcileBookingIfStale(booking);

      expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
      expect(mockPublisher.publish).not.toHaveBeenCalled();
      expect(booking.status).toBe(BookingStatus.PROCESSING);
    });
  });

  describe('handleReconciliationRequested', () => {
    it('does nothing if event or bookingId is missing', async () => {
      const lockSpy = jest
        .spyOn(internalService(service), 'reconcileBookingWithLock')
        .mockResolvedValue(undefined);

      await service.handleReconciliationRequested(undefined as unknown as { bookingId: string });
      await service.handleReconciliationRequested({} as unknown as { bookingId: string });
      await service.handleReconciliationRequested({ bookingId: '' });

      expect(lockSpy).not.toHaveBeenCalled();
    });

    it('delegates to reconcileBookingWithLock with bookingId', async () => {
      const lockSpy = jest
        .spyOn(internalService(service), 'reconcileBookingWithLock')
        .mockResolvedValue(undefined);

      await service.handleReconciliationRequested({ bookingId: 'booking-123' });

      expect(lockSpy).toHaveBeenCalledWith('booking-123');
    });

    it('executes real lock flow (acquireLock with 300s and releaseLock) end-to-end without mocking reconcileBookingWithLock', async () => {
      const bookingId = 'b-handle-recon-lock-int';
      const staleDate = new Date(Date.now() - 20 * 60 * 1000);
      mockCacheService.acquireLock.mockResolvedValue(true);
      mockPrisma.booking.findUnique.mockResolvedValue({
        id: bookingId,
        status: BookingStatus.PROCESSING,
        createdAt: staleDate,
      });
      jest
        .spyOn(service, 'reconcileBookingIfStale')
        .mockResolvedValue({} as unknown as BookingWithRelations);

      await service.handleReconciliationRequested({ bookingId });

      expect(mockCacheService.acquireLock).toHaveBeenCalledWith(
        `booking:recon:lock:${bookingId}`,
        expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        ),
        300,
      );
      const token = mockCacheService.acquireLock.mock.calls[0][1];
      expect(mockCacheService.releaseLock).toHaveBeenCalledWith(
        `booking:recon:lock:${bookingId}`,
        token,
      );
      expect(service.reconcileBookingIfStale).toHaveBeenCalled();
    });
  });

  describe('reconcileBookingWithLock', () => {
    const staleDate = new Date(Date.now() - 20 * 60 * 1000);
    const recentDate = new Date(Date.now() - 5 * 60 * 1000);

    it('acquires lock using key booking:recon:lock:{bookingId}, randomUUID token, and 300s TTL', async () => {
      const bookingId = 'b-lock-1';
      mockCacheService.acquireLock.mockResolvedValue(true);
      mockPrisma.booking.findUnique.mockResolvedValue({
        id: bookingId,
        status: BookingStatus.PROCESSING,
        createdAt: staleDate,
      });
      jest
        .spyOn(service, 'reconcileBookingIfStale')
        .mockResolvedValue({} as unknown as BookingWithRelations);

      await internalService(service).reconcileBookingWithLock(bookingId);

      expect(mockCacheService.acquireLock).toHaveBeenCalledWith(
        `booking:recon:lock:${bookingId}`,
        expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        ),
        300,
      );
      const token = mockCacheService.acquireLock.mock.calls[0][1];
      expect(mockCacheService.releaseLock).toHaveBeenCalledWith(
        `booking:recon:lock:${bookingId}`,
        token,
      );
    });

    it('skips reconciliation without querying DB or running recovery when lock is held (collision)', async () => {
      const bookingId = 'b-lock-collision';
      mockCacheService.acquireLock.mockResolvedValue(false);

      await internalService(service).reconcileBookingWithLock(bookingId);

      expect(mockCacheService.acquireLock).toHaveBeenCalledWith(
        `booking:recon:lock:${bookingId}`,
        expect.any(String),
        300,
      );
      expect(mockPrisma.booking.findUnique).not.toHaveBeenCalled();
      expect(mockCacheService.releaseLock).not.toHaveBeenCalled();
    });

    it('releases lock in finally with matching token even if reconcileBookingIfStale throws', async () => {
      const bookingId = 'b-lock-error';
      mockCacheService.acquireLock.mockResolvedValue(true);
      mockPrisma.booking.findUnique.mockResolvedValue({
        id: bookingId,
        status: BookingStatus.PROCESSING,
        createdAt: staleDate,
      });
      jest.spyOn(service, 'reconcileBookingIfStale').mockRejectedValue(new Error('Downstream recovery failure'));

      await internalService(service).reconcileBookingWithLock(bookingId);

      const token = mockCacheService.acquireLock.mock.calls[0][1];
      expect(mockCacheService.releaseLock).toHaveBeenCalledWith(
        `booking:recon:lock:${bookingId}`,
        token,
      );
    });

    it('skips recovery if latest booking state is already CONFIRMED upon DB reload', async () => {
      const bookingId = 'b-confirmed';
      mockCacheService.acquireLock.mockResolvedValue(true);
      mockPrisma.booking.findUnique.mockResolvedValue({
        id: bookingId,
        status: BookingStatus.CONFIRMED,
        createdAt: staleDate,
      });
      const reconcileSpy = jest.spyOn(service, 'reconcileBookingIfStale');

      await internalService(service).reconcileBookingWithLock(bookingId);

      expect(mockPrisma.booking.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: bookingId },
        }),
      );
      expect(reconcileSpy).not.toHaveBeenCalled();
      expect(mockCacheService.releaseLock).toHaveBeenCalled();
    });

    it('skips recovery if latest booking is recent (< 15 minutes old)', async () => {
      const bookingId = 'b-recent';
      mockCacheService.acquireLock.mockResolvedValue(true);
      mockPrisma.booking.findUnique.mockResolvedValue({
        id: bookingId,
        status: BookingStatus.PROCESSING,
        createdAt: recentDate,
      });
      const reconcileSpy = jest.spyOn(service, 'reconcileBookingIfStale');

      await internalService(service).reconcileBookingWithLock(bookingId);

      expect(reconcileSpy).not.toHaveBeenCalled();
      expect(mockCacheService.releaseLock).toHaveBeenCalled();
    });

    it('skips recovery if booking is not found in DB', async () => {
      const bookingId = 'b-missing';
      mockCacheService.acquireLock.mockResolvedValue(true);
      mockPrisma.booking.findUnique.mockResolvedValue(null);
      const reconcileSpy = jest.spyOn(service, 'reconcileBookingIfStale');

      await internalService(service).reconcileBookingWithLock(bookingId);

      expect(reconcileSpy).not.toHaveBeenCalled();
      expect(mockCacheService.releaseLock).toHaveBeenCalled();
    });

    it('contains errors and logs without leaking unhandled rejections when an exception occurs', async () => {
      const bookingId = 'b-throw';
      mockCacheService.acquireLock.mockRejectedValue(new Error('Redis connection drop'));

      await expect(internalService(service).reconcileBookingWithLock(bookingId)).resolves.toBeUndefined();
    });
  });

  describe('sweepStaleBookings', () => {
    it('queries stale PROCESSING bookings older than 15 minutes and delegates each to reconcileBookingWithLock', async () => {
      const staleDate = new Date(Date.now() - 20 * 60 * 1000);
      const staleBookings = [
        { id: 'b-1', status: BookingStatus.PROCESSING, createdAt: staleDate },
        { id: 'b-2', status: BookingStatus.PROCESSING, createdAt: staleDate },
      ];

      mockPrisma.booking.findMany.mockResolvedValue(staleBookings);
      const lockSpy = jest
        .spyOn(internalService(service), 'reconcileBookingWithLock')
        .mockResolvedValue(undefined);

      await service.sweepStaleBookings();

      expect(mockPrisma.booking.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: BookingStatus.PROCESSING,
            createdAt: { lte: expect.any(Date) },
          },
        }),
      );
      expect(lockSpy).toHaveBeenCalledTimes(2);
      expect(lockSpy).toHaveBeenNthCalledWith(1, 'b-1');
      expect(lockSpy).toHaveBeenNthCalledWith(2, 'b-2');
    });

    it('executes real lock flow (acquireLock with 300s and releaseLock) end-to-end without mocking reconcileBookingWithLock', async () => {
      const staleBookingId = 'b-sweep-lock-int';
      const staleDate = new Date(Date.now() - 20 * 60 * 1000);
      mockPrisma.booking.findMany.mockResolvedValue([
        {
          id: staleBookingId,
          status: BookingStatus.PROCESSING,
          createdAt: staleDate,
        },
      ]);
      mockCacheService.acquireLock.mockResolvedValue(true);
      mockPrisma.booking.findUnique.mockResolvedValue({
        id: staleBookingId,
        status: BookingStatus.PROCESSING,
        createdAt: staleDate,
      });
      jest
        .spyOn(service, 'reconcileBookingIfStale')
        .mockResolvedValue({} as unknown as BookingWithRelations);

      await service.sweepStaleBookings();

      expect(mockCacheService.acquireLock).toHaveBeenCalledWith(
        `booking:recon:lock:${staleBookingId}`,
        expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        ),
        300,
      );
      const token = mockCacheService.acquireLock.mock.calls[0][1];
      expect(mockCacheService.releaseLock).toHaveBeenCalledWith(
        `booking:recon:lock:${staleBookingId}`,
        token,
      );
      expect(service.reconcileBookingIfStale).toHaveBeenCalled();
    });
  });

  describe('sweepUncompletedBookings', () => {
    it('queries past CONFIRMED bookings and calls checkAndCompleteBooking', async () => {
      const pastBookings = [
        {
          id: 'b-1',
          status: BookingStatus.CONFIRMED,
          departureAt: new Date(Date.now() - 3600_000),
        },
        {
          id: 'b-2',
          status: BookingStatus.CONFIRMED,
          departureAt: new Date(Date.now() - 7200_000),
        },
      ];

      mockPrisma.booking.findMany.mockResolvedValue(pastBookings);
      mockBookingLifecycleService.checkAndCompleteBooking.mockResolvedValue({} as any);

      await service.sweepUncompletedBookings();

      expect(mockPrisma.booking.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: BookingStatus.CONFIRMED,
            departureAt: { lte: expect.any(Date) },
          },
        }),
      );
      expect(mockBookingLifecycleService.checkAndCompleteBooking).toHaveBeenCalledTimes(2);
    });
  });
});
