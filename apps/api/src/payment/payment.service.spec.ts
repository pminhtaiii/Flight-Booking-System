import 'reflect-metadata';
import { PaymentService } from './payment.service';
import { PrismaService } from '@/prisma/prisma.service';
import { StripeService } from '@/common/stripe.service';
import { PaymentIdempotencyService } from '@/payment/payment-idempotency.service';
import { DuffelService } from '@/duffel/duffel.service';
import { AuditService } from '@/audit/audit.service';
import { PaymentMethodService } from '@/payment/payment-method.service';
import { HttpStatus, InternalServerErrorException } from '@nestjs/common';

describe('PaymentService - recoveryPoint === completed', () => {
  let service: PaymentService;
  let mockPrisma: any;
  let mockStripe: any;
  let mockIdempotency: any;
  let mockDuffel: any;
  let mockAudit: any;
  let mockPaymentMethod: any;

  beforeEach(() => {
    mockPrisma = {
      $transaction: jest.fn((cb) => cb(mockPrisma)),
      bookingIntent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      payment: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      booking: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      paymentEvent: {
        findFirst: jest.fn(),
        create: jest.fn(),
      },
      ledgerEntry: {
        createMany: jest.fn(),
      },
    };

    mockStripe = {};
    
    mockIdempotency = {
      computeHash: jest.fn().mockReturnValue('mock-hash'),
      acquireOrReplay: jest.fn().mockResolvedValue({ status: 'acquired' }),
      getResumePoint: jest.fn(),
      completeKey: jest.fn(),
    };

    mockDuffel = {
      mapDuffelOrderToSnapshots: jest.fn().mockReturnValue({
        flightSnapshot: { segments: [{ departureAt: '2026-07-20T10:00:00Z' }] },
        passengerSnapshot: { passengers: [] }
      })
    };
    mockAudit = { createLog: jest.fn() };
    mockPaymentMethod = { saveMethod: jest.fn() };
    const mockBookingService = { createBooking: jest.fn().mockResolvedValue({ id: '123e4567-e89b-42d3-a456-426614174000', userId: 'user-123' }), updateToConfirmed: jest.fn(), updateToFailed: jest.fn() };

    service = new PaymentService(
      mockPrisma as unknown as PrismaService,
      mockStripe as unknown as StripeService,
      mockIdempotency as unknown as PaymentIdempotencyService,
      mockDuffel as unknown as DuffelService,
      mockAudit as unknown as AuditService,
      mockPaymentMethod as unknown as PaymentMethodService,
      mockBookingService as any
    );
  });

  describe('confirmPayment recoveryPoint === completed', () => {
    const dto = { paymentId: 'payment-123', bookingId: '123e4567-e89b-42d3-a456-426614174000' };
    const idempotencyKey = 'key-123';
    const userId = 'user-123';

    it('returns successResponse and completes key when payment.status is SUCCEEDED', async () => {
      // 1. Mock payment lookup
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        id: 'payment-123',
        bookingIntentId: 'intent-123',
        status: 'SUCCEEDED',
        bookingIntent: { userId: 'user-123' },
      });

      // 2. Mock resume point
      mockIdempotency.getResumePoint.mockResolvedValueOnce('completed');

      // 3. Mock paymentEvent query for duffel_order_created
      mockPrisma.paymentEvent.findFirst.mockResolvedValueOnce({
        metadata: {
          id: 'duffel-order-abc',
          booking_reference: 'PNR123',
        },
      });

      const response = await service.executeConfirmPayment(dto, idempotencyKey, userId);

      expect(mockIdempotency.completeKey).toHaveBeenCalledWith(
        idempotencyKey,
        HttpStatus.OK,
        expect.objectContaining({
          success: true,
          paymentId: 'payment-123',
          status: 'SUCCEEDED',
          bookingReference: 'PNR123',
          duffelOrderId: 'duffel-order-abc',
        }),
      );

      expect(response).toEqual({
        success: true,
        paymentId: 'payment-123',
        status: 'SUCCEEDED',
        bookingReference: 'PNR123',
        duffelOrderId: 'duffel-order-abc',
      });
    });

    it('throws InternalServerErrorException if payment is SUCCEEDED but duffel event metadata is missing', async () => {
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        id: 'payment-123',
        bookingIntentId: 'intent-123',
        status: 'SUCCEEDED',
        bookingIntent: { userId: 'user-123' },
      });

      mockIdempotency.getResumePoint.mockResolvedValueOnce('completed');
      mockPrisma.paymentEvent.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.executeConfirmPayment(dto, idempotencyKey, userId),
      ).rejects.toThrow(InternalServerErrorException);
    });

    it('returns failureResponse and completes key with BAD_GATEWAY if status is CANCELLED and duffel event exists', async () => {
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        id: 'payment-123',
        bookingIntentId: 'intent-123',
        status: 'CANCELLED',
        bookingIntent: { userId: 'user-123' },
      });

      mockIdempotency.getResumePoint.mockResolvedValueOnce('completed');

      // Mock duffel event exists (indicating order was created but capture failed/background processing failed)
      mockPrisma.paymentEvent.findFirst.mockResolvedValueOnce({
        metadata: { id: 'duffel-order-abc' },
      });

      // Mock bookingIntent query
      mockPrisma.bookingIntent.findUnique.mockResolvedValueOnce({
        id: 'intent-123',
        status: 'CANCELLED',
      });

      const response = await service.executeConfirmPayment(dto, idempotencyKey, userId);

      expect(mockIdempotency.completeKey).toHaveBeenCalledWith(
        idempotencyKey,
        HttpStatus.BAD_GATEWAY,
        expect.objectContaining({
          success: false,
          error: 'Stripe capture failed or background processing failed. Duffel order cancelled and hold released.',
          bookingStatus: 'CANCELLED',
        }),
      );

      expect(response).toEqual({
        success: false,
        error: 'Stripe capture failed or background processing failed. Duffel order cancelled and hold released.',
        bookingStatus: 'CANCELLED',
      });
    });

    it('returns failureResponse and completes key with BAD_GATEWAY if status is CANCELLED and duffel event does not exist', async () => {
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        id: 'payment-123',
        bookingIntentId: 'intent-123',
        status: 'CANCELLED',
        bookingIntent: { userId: 'user-123' },
      });

      mockIdempotency.getResumePoint.mockResolvedValueOnce('completed');

      // Mock duffel event does NOT exist (indicating duffel order was not created)
      mockPrisma.paymentEvent.findFirst.mockResolvedValueOnce(null);

      mockPrisma.bookingIntent.findUnique.mockResolvedValueOnce({
        id: 'intent-123',
        status: 'AWAITING_PAYMENT',
      });

      const response = await service.executeConfirmPayment(dto, idempotencyKey, userId);

      expect(mockIdempotency.completeKey).toHaveBeenCalledWith(
        idempotencyKey,
        HttpStatus.BAD_GATEWAY,
        expect.objectContaining({
          success: false,
          error: 'Duffel booking failed. Payment hold released.',
          bookingStatus: 'AWAITING_PAYMENT',
        }),
      );

      expect(response).toEqual({
        success: false,
        error: 'Duffel booking failed. Payment hold released.',
        bookingStatus: 'AWAITING_PAYMENT',
      });
    });
  });

  describe('post-capture saved payment methods', () => {
    it('syncs the payment method after a successful capture', async () => {
      mockPrisma.payment.findUnique.mockResolvedValue({
        id: 'payment-123',
        bookingIntentId: 'intent-123',
        stripePaymentIntentId: 'pi-123',
        stripeCustomerId: 'cus-123',
        amount: 10000,
        currency: 'usd',
        status: 'AUTHORIZED',
        bookingIntent: { userId: 'user-123' },
      });
      mockPrisma.paymentEvent.findFirst.mockResolvedValue({
        metadata: { id: 'duffel-order-123', booking_reference: 'PNR123' },
      });
      mockPrisma.$transaction = jest.fn().mockImplementation(async (callback) =>
        callback({
          payment: { update: jest.fn() },
          paymentEvent: { create: jest.fn() },
          bookingIntent: {
            update: jest.fn(),
            findUnique: jest.fn().mockResolvedValue({
              id: 'intent-123',
              passengers: [{ id: 'passenger-1', type: 'adult' }],
              user: { email: 'john@example.com' },
            }),
          },
          ledgerEntry: { createMany: jest.fn() },
        }),
      );
      mockIdempotency.getResumePoint.mockResolvedValue('captured');
      mockIdempotency.updateRecoveryPoint = jest.fn();
      mockAudit.createLog = jest.fn();

      await service.executeConfirmPayment(
        { paymentId: 'payment-123', bookingId: '123e4567-e89b-42d3-a456-426614174000' },
        'confirm-key-123',
        'user-123',
      );

      expect(mockPaymentMethod.saveMethod).toHaveBeenCalledWith(
        'user-123',
        'cus-123',
        'pi-123',
      );
    });
  });

  describe('handleBackgroundError', () => {
    const paymentId = 'payment-123';
    const idempotencyKey = 'key-123';
    const userId = 'user-123';
    const error = new Error('Some background error');

    beforeEach(() => {
      mockPrisma.$transaction = jest.fn().mockImplementation(async (cb) => cb(mockPrisma));
      mockPrisma.payment.update = jest.fn();
      mockPrisma.paymentEvent.create = jest.fn();
      mockPrisma.bookingIntent.update = jest.fn();

      mockStripe.retrievePaymentIntent = jest.fn();
      mockStripe.cancelPaymentIntent = jest.fn();
      mockDuffel.cancelOrder = jest.fn();
      mockIdempotency.updateRecoveryPoint = jest.fn();
    });

    it('when Stripe retrieval returns status === succeeded, logs/updates recovery point to captured, returns early, and does NOT compensate', async () => {
      // Setup payment
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        id: paymentId,
        stripePaymentIntentId: 'pi_123',
        bookingIntentId: 'intent-123',
        status: 'AUTHORIZED',
        amount: 100,
      });

      // Stripe returns succeeded
      mockStripe.retrievePaymentIntent.mockResolvedValueOnce({
        id: 'pi_123',
        status: 'succeeded',
      });

      // Resume point is null
      mockIdempotency.getResumePoint.mockResolvedValueOnce(null);

      // Call handleBackgroundError
      await (service as any).handleBackgroundError(paymentId, idempotencyKey, userId, error);

      // Verify recovery point updated to 'captured'
      expect(mockIdempotency.updateRecoveryPoint).toHaveBeenCalledWith(idempotencyKey, 'captured');

      // Verify no compensation methods are called
      expect(mockDuffel.cancelOrder).not.toHaveBeenCalled();
      expect(mockStripe.cancelPaymentIntent).not.toHaveBeenCalled();
      expect(mockPrisma.payment.update).not.toHaveBeenCalled();
    });

    it('when Stripe retrieval returns status !== succeeded, continues compensation', async () => {
      // Setup payment
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        id: paymentId,
        stripePaymentIntentId: 'pi_123',
        bookingIntentId: 'intent-123',
        status: 'AUTHORIZED',
        amount: 100,
      });

      // Stripe returns requires_capture
      mockStripe.retrievePaymentIntent.mockResolvedValueOnce({
        id: 'pi_123',
        status: 'requires_capture',
      });

      // Resume point is null
      mockIdempotency.getResumePoint.mockResolvedValueOnce(null);

      // Mock duffel event query - return one to verify Duffel cancelOrder is called
      mockPrisma.paymentEvent.findFirst.mockResolvedValueOnce({
        metadata: { id: 'duffel-order-abc' },
      });

      // Mock bookingIntent query
      mockPrisma.bookingIntent.findUnique.mockResolvedValueOnce({
        id: 'intent-123',
        paymentAttemptCount: 1,
      });

      // Call handleBackgroundError
      await (service as any).handleBackgroundError(paymentId, idempotencyKey, userId, error);

      // Verify recovery point is NOT updated to 'captured'
      expect(mockIdempotency.updateRecoveryPoint).not.toHaveBeenCalledWith(idempotencyKey, 'captured');

      // Verify compensation methods are called
      expect(mockDuffel.cancelOrder).toHaveBeenCalledWith('duffel-order-abc');
      expect(mockStripe.cancelPaymentIntent).toHaveBeenCalledWith('pi_123');

      // Verify payment transitioned to CANCELLED
      expect(mockPrisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: paymentId },
          data: { status: 'CANCELLED' },
        })
      );

      // Verify bookingIntent status is updated
      expect(mockPrisma.bookingIntent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'intent-123' },
          data: { status: 'AWAITING_PAYMENT' },
        })
      );
    });

    it('when Stripe retrieval fails (throws), it logs the error and returns early (recoverable)', async () => {
      // Setup payment
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        id: paymentId,
        stripePaymentIntentId: 'pi_123',
        bookingIntentId: 'intent-123',
        status: 'AUTHORIZED',
        amount: 100,
      });

      // Stripe retrieve throws
      mockStripe.retrievePaymentIntent.mockRejectedValueOnce(new Error('Stripe API error'));

      // Call handleBackgroundError
      await (service as any).handleBackgroundError(paymentId, idempotencyKey, userId, error);

      // Verify compensation methods are NOT called and return is early/recoverable
      expect(mockStripe.cancelPaymentIntent).not.toHaveBeenCalled();
      expect(mockPrisma.payment.update).not.toHaveBeenCalled();
    });
  });

  describe('createPayment - stale-lock retry', () => {
    const dto = {
      bookingIntentId: 'intent-123',
      paymentMethodId: 'pm_123',
      saveCard: false,
    };
    const idempotencyKey = 'key-123';
    const userId = 'user-123';
    const ipAddress = '127.0.0.1';

    beforeEach(() => {
      mockPrisma.$transaction = jest.fn().mockImplementation(async (cb) => cb(mockPrisma));
      mockPrisma.$queryRaw = jest.fn().mockResolvedValue([
        {
          id: 'intent-123',
          status: 'PENDING',
          paymentAttemptCount: 1,
          confirmedPrice: 100,
          currency: 'USD',
          userId: 'user-123',
        },
      ]);
      mockPrisma.$executeRaw = jest.fn().mockResolvedValue(1);
      mockPrisma.payment.findFirst = jest.fn();
      mockPrisma.payment.create = jest.fn();
      mockPrisma.user = {
        findUnique: jest.fn().mockResolvedValue({
          email: 'test@example.com',
          stripeCustomerId: 'cus_123',
        }),
        updateMany: jest.fn(),
      };
      mockPrisma.idempotencyKey = {
        findUnique: jest.fn().mockResolvedValue({ id: 'key_id_123' }),
      };
      mockPrisma.paymentEvent = {
        create: jest.fn().mockResolvedValue({}),
      };
      mockAudit.createLog = jest.fn().mockResolvedValue({});
      mockIdempotency.updateRecoveryPoint = jest.fn().mockResolvedValue({});

      mockStripe.createPaymentIntent = jest.fn().mockResolvedValue({
        id: 'pi_123',
        client_secret: 'secret_123',
      });
    });

    it('should skip booking intent count increment when payment already exists for the idempotency key', async () => {
      const mockPayment = {
        id: 'payment-123',
        bookingIntentId: 'intent-123',
        attemptNumber: 1,
        idempotencyKeyId: 'key_id_123',
        stripePaymentIntentId: 'pi_123',
        stripeCustomerId: 'cus_123',
        amount: 10000,
        currency: 'usd',
        status: 'CREATED',
      };

      mockPrisma.payment.findFirst.mockResolvedValue(mockPayment);

      const response = await service.createPayment(dto, idempotencyKey, userId, ipAddress);

      expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
      expect(mockPrisma.payment.create).not.toHaveBeenCalled();
      expect(response).toEqual({
        paymentId: 'payment-123',
        clientSecret: 'secret_123',
        status: 'CREATED',
      });
    });

    it('should proceed with incrementing booking intent count and creating payment when no payment exists', async () => {
      mockPrisma.payment.findFirst.mockResolvedValue(null);
      mockPrisma.payment.create.mockResolvedValue({
        id: 'payment-456',
        status: 'CREATED',
      });

      const response = await service.createPayment(dto, idempotencyKey, userId, ipAddress);

      expect(mockPrisma.$executeRaw).toHaveBeenCalled();
      expect(mockPrisma.payment.create).toHaveBeenCalled();
      expect(response).toEqual({
        paymentId: 'payment-456',
        clientSecret: 'secret_123',
        status: 'CREATED',
      });
    });

    it('should complete successfully even if paymentAttemptCount is already 2 (exhausted limit) if payment record exists', async () => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        {
          id: 'intent-123',
          status: 'PENDING',
          paymentAttemptCount: 2,
          confirmedPrice: 100,
          currency: 'USD',
          userId: 'user-123',
        },
      ]);

      const mockPayment = {
        id: 'payment-123',
        bookingIntentId: 'intent-123',
        attemptNumber: 1,
        idempotencyKeyId: 'key_id_123',
        stripePaymentIntentId: 'pi_123',
        stripeCustomerId: 'cus_123',
        amount: 10000,
        currency: 'usd',
        status: 'CREATED',
      };

      mockPrisma.payment.findFirst.mockResolvedValue(mockPayment);

      const response = await service.createPayment(dto, idempotencyKey, userId, ipAddress);

      expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
      expect(response).toEqual({
        paymentId: 'payment-123',
        clientSecret: 'secret_123',
        status: 'CREATED',
      });
    });
  });
});

