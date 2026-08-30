import { BookingStatus, RefundStatus, RefundTriggerType } from '@prisma/client';
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
  let mockProjectionService: any;

  beforeEach(() => {
    mockPrisma = {
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
      },
      bookingIntent: {
        findUnique: jest.fn(),
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

    mockBookingLifecycleService = {
      checkAndCompleteBooking: jest.fn(),
    };

    mockProjectionService = {
      createOrUpdateProjection: jest.fn().mockResolvedValue(null),
      updateProjectionStatus: jest.fn().mockResolvedValue(null),
    };

    service = new BookingRecoveryService(
      mockPrisma,
      mockStripeService,
      mockDuffelService,
      mockRefundTransactionService,
      mockRefundSettlementService,
      mockBookingLifecycleService,
      mockProjectionService,
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
    });

    it('marks booking FAILED with BOOKING_TIMEOUT if missing stripePaymentIntentId', async () => {
      const booking = {
        id: 'b-1',
        status: BookingStatus.PROCESSING,
        createdAt: staleDate,
        payment: null,
      } as unknown as BookingWithRelations;

      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.reconcileBookingIfStale(booking);

      expect(result.status).toBe(BookingStatus.FAILED);
      expect(result.failureReason).toBe('BOOKING_TIMEOUT');
      expect(mockPrisma.booking.updateMany).toHaveBeenCalledWith({
        where: { id: 'b-1', status: BookingStatus.PROCESSING },
        data: { status: BookingStatus.FAILED, failureReason: 'BOOKING_TIMEOUT' },
      });
      expect(mockProjectionService.updateProjectionStatus).toHaveBeenCalledWith(
        'b-1',
        BookingStatus.FAILED,
      );
    });

    it('handles incomplete Stripe payment: cancels Duffel order, cancels Stripe intent, and marks booking FAILED with CAPTURE_FAILED', async () => {
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
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.payment.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.reconcileBookingIfStale(booking);

      expect(mockDuffelService.cancelOrder).toHaveBeenCalledWith('ord_123');
      expect(mockStripeService.cancelPaymentIntent).toHaveBeenCalledWith('pi_123');
      expect(result.status).toBe(BookingStatus.FAILED);
      expect(result.failureReason).toBe('CAPTURE_FAILED');
      expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith({
        where: { id: 'pay-1', status: { notIn: ['CANCELLED', 'REFUNDED'] } },
        data: { status: 'CANCELLED' },
      });
      expect(mockProjectionService.updateProjectionStatus).toHaveBeenCalledWith(
        'b-1',
        BookingStatus.FAILED,
      );
    });

    it('handles Stripe payment succeeded with existing Duffel order: confirms booking and syncs payment and projection', async () => {
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
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.payment.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.reconcileBookingIfStale(booking);

      expect(result.status).toBe(BookingStatus.CONFIRMED);
      expect(result.pnrReference).toBe('PNR999');
      expect(result.duffelOrderId).toBe('ord_123');
      expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith({
        where: { id: 'pay-1', status: { notIn: ['SUCCEEDED', 'REFUNDED', 'CANCELLED'] } },
        data: { status: 'SUCCEEDED' },
      });
      expect(mockProjectionService.createOrUpdateProjection).toHaveBeenCalledWith('b-1');
    });

    it('handles Stripe payment succeeded but NO Duffel order: marks FAILED with SYSTEM_ERROR and triggers automated refund', async () => {
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
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });

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
      expect(result.failureReason).toBe('SYSTEM_ERROR');
      expect(mockProjectionService.updateProjectionStatus).toHaveBeenCalledWith(
        'b-1',
        BookingStatus.FAILED,
      );
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
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });

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
