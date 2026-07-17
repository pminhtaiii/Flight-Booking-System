import 'reflect-metadata';
import { PaymentService } from './payment.service';
import { PrismaService } from '@/prisma/prisma.service';
import { StripeService } from '@/common/stripe.service';
import { PaymentIdempotencyService } from '@/payment/payment-idempotency.service';
import { DuffelService } from '@/duffel/duffel.service';
import { AuditService } from '@/audit/audit.service';
import { HttpStatus, InternalServerErrorException } from '@nestjs/common';

describe('PaymentService - recoveryPoint === completed', () => {
  let service: PaymentService;
  let mockPrisma: any;
  let mockStripe: any;
  let mockIdempotency: any;
  let mockDuffel: any;
  let mockAudit: any;

  beforeEach(() => {
    mockPrisma = {
      payment: {
        findUnique: jest.fn(),
      },
      paymentEvent: {
        findFirst: jest.fn(),
      },
      bookingIntent: {
        findUnique: jest.fn(),
      },
    };

    mockStripe = {};
    
    mockIdempotency = {
      computeHash: jest.fn().mockReturnValue('mock-hash'),
      acquireOrReplay: jest.fn().mockResolvedValue({ status: 'acquired' }),
      getResumePoint: jest.fn(),
      completeKey: jest.fn(),
    };

    mockDuffel = {};
    mockAudit = {};

    service = new PaymentService(
      mockPrisma as unknown as PrismaService,
      mockStripe as unknown as StripeService,
      mockIdempotency as unknown as PaymentIdempotencyService,
      mockDuffel as unknown as DuffelService,
      mockAudit as unknown as AuditService,
    );
  });

  describe('confirmPayment recoveryPoint === completed', () => {
    const dto = { paymentId: 'payment-123' };
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
});
