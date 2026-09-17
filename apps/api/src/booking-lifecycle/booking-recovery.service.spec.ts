import { BookingFailureReason, BookingStatus, RefundStatus, RefundTriggerType } from '@prisma/client';
import { BookingRecoveryService } from './booking-recovery.service';
import { BookingWithRelations } from './booking-lifecycle.types';

describe('BookingRecoveryService', () => {
  let service: BookingRecoveryService;
  let mockPrisma: any;
  let mockStripeService: any;
  let mockDuffelService: any;
  let mockRefundTransactionService: any;
  let mockRefundSettlementService: any;
  let mockBookingLifecycleService: any;
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
      mockPrisma.paymentEvent.findFirst.mockResolvedValue({
        metadata: { id: 'ord_123' },
      });
      mockDuffelService.cancelOrder.mockResolvedValue({});
      mockStripeService.cancelPaymentIntent.mockResolvedValue({});
      mockPrisma.payment.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.reconcileBookingIfStale(booking);

      expect(mockDuffelService.cancelOrder).toHaveBeenCalledWith('ord_123');
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
  });

  describe('sweepStaleBookings', () => {
    it('queries stale PROCESSING bookings older than 15 minutes and reconciles each', async () => {
      const staleDate = new Date(Date.now() - 20 * 60 * 1000);
      const staleBookings = [
        { id: 'b-1', status: BookingStatus.PROCESSING, createdAt: staleDate },
        { id: 'b-2', status: BookingStatus.PROCESSING, createdAt: staleDate },
      ];

      mockPrisma.booking.findMany.mockResolvedValue(staleBookings);
      const reconcileSpy = jest
        .spyOn(service, 'reconcileBookingIfStale')
        .mockResolvedValue({} as any);

      await service.sweepStaleBookings();

      expect(mockPrisma.booking.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: BookingStatus.PROCESSING,
            createdAt: { lte: expect.any(Date) },
          },
        }),
      );
      expect(reconcileSpy).toHaveBeenCalledTimes(2);
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
