import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { PaymentWebhookService } from './payment-webhook.service';
import { PrismaService } from '@/prisma/prisma.service';
import { StripeService } from '@/common/stripe.service';
import { PaymentRefundService } from './payment-refund.service';
import { AuditService } from '@/audit/audit.service';
import { PaymentStatus, PaymentEventSource, Prisma } from '@prisma/client';

describe('PaymentWebhookService', () => {
  let service: PaymentWebhookService;
  let mockPrisma: any;
  let mockStripe: any;

  beforeEach(async () => {
    mockPrisma = {
      payment: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      paymentEvent: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
      bookingIntent: {
        findUnique: jest.fn().mockResolvedValue({ paymentAttemptCount: 1 }),
        update: jest.fn(),
      },
      ledgerEntry: {
        findFirst: jest.fn(),
        createMany: jest.fn(),
      },
      $transaction: jest.fn((cb) => cb(mockPrisma)),
    };

    mockStripe = {
      retrievePaymentIntent: jest.fn(),
    };

    const mockPaymentRefundService = {
      handleChargeRefunded: jest.fn(),
    };

    const mockAuditService = {
      createLog: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentWebhookService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: StripeService, useValue: mockStripe },
        { provide: PaymentRefundService, useValue: mockPaymentRefundService },
        { provide: AuditService, useValue: mockAuditService },
      ],
    }).compile();

    service = module.get<PaymentWebhookService>(PaymentWebhookService);
  });

  describe('handleWebhookEvent', () => {
    const stripeEventId = 'evt_123';
    const mockPaymentIntentId = 'pi_123';
    const mockAmount = 10000;
    const mockCurrency = 'usd';

    const createMockEvent = (type: string, status: string) => ({
      id: stripeEventId,
      type,
      data: {
        object: {
          id: mockPaymentIntentId,
          amount: mockAmount,
          currency: mockCurrency,
          status,
          metadata: {
            bookingIntentId: 'intent_123',
          },
        },
      },
    });

    it('T003: deduplicates events if stripeEventId already processed', async () => {
      mockPrisma.paymentEvent.findUnique.mockResolvedValueOnce({ id: 1n });

      const event = createMockEvent('payment_intent.succeeded', 'succeeded');
      const result = await service.handleWebhookEvent(event);

      expect(result).toBe(true);
      expect(mockPrisma.paymentEvent.findUnique).toHaveBeenCalledWith({
        where: { stripeEventId },
      });
      expect(mockPrisma.payment.findUnique).not.toHaveBeenCalled();
    });

    it('T004: handles payment_intent.succeeded successfully (valid transition AUTHORIZED -> SUCCEEDED)', async () => {
      mockPrisma.paymentEvent.findUnique.mockResolvedValueOnce(null);
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        id: 'payment_123',
        bookingIntentId: 'intent_123',
        stripePaymentIntentId: mockPaymentIntentId,
        amount: mockAmount,
        currency: mockCurrency,
        status: PaymentStatus.AUTHORIZED,
      });
      mockPrisma.ledgerEntry.findFirst.mockResolvedValueOnce(null);

      const event = createMockEvent('payment_intent.succeeded', 'succeeded');
      const result = await service.handleWebhookEvent(event);

      expect(result).toBe(true);
      expect(mockPrisma.payment.update).toHaveBeenCalledWith({
        where: { id: 'payment_123' },
        data: { status: PaymentStatus.SUCCEEDED },
      });
      expect(mockPrisma.bookingIntent.update).toHaveBeenCalledWith({
        where: { id: 'intent_123' },
        data: { status: 'CONFIRMED' },
      });
      expect(mockPrisma.ledgerEntry.createMany).toHaveBeenCalled();
      expect(mockPrisma.paymentEvent.create).toHaveBeenCalledWith({
        data: {
          paymentId: 'payment_123',
          eventType: 'payment_intent.succeeded',
          previousStatus: PaymentStatus.AUTHORIZED,
          newStatus: PaymentStatus.SUCCEEDED,
          amount: mockAmount,
          source: PaymentEventSource.WEBHOOK,
          stripeEventId,
          createdBy: 'stripe_webhook',
          metadata: expect.any(Object),
        },
      });
    });

    it('T004: handles payment_intent.succeeded no-op if payment status is already SUCCEEDED', async () => {
      mockPrisma.paymentEvent.findUnique.mockResolvedValueOnce(null);
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        id: 'payment_123',
        bookingIntentId: 'intent_123',
        stripePaymentIntentId: mockPaymentIntentId,
        amount: mockAmount,
        currency: mockCurrency,
        status: PaymentStatus.SUCCEEDED,
      });

      const event = createMockEvent('payment_intent.succeeded', 'succeeded');
      const result = await service.handleWebhookEvent(event);

      expect(result).toBe(true);
      expect(mockPrisma.payment.update).not.toHaveBeenCalled();
      expect(mockPrisma.paymentEvent.create).toHaveBeenCalledWith({
        data: {
          paymentId: 'payment_123',
          eventType: 'payment_intent.succeeded',
          previousStatus: PaymentStatus.SUCCEEDED,
          newStatus: PaymentStatus.SUCCEEDED,
          amount: mockAmount,
          source: PaymentEventSource.WEBHOOK,
          stripeEventId,
          createdBy: 'stripe_webhook',
          metadata: expect.any(Object),
        },
      });
    });

    it('T005: handles payment_intent.payment_failed (CREATED -> FAILED)', async () => {
      mockPrisma.paymentEvent.findUnique.mockResolvedValueOnce(null);
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        id: 'payment_123',
        bookingIntentId: 'intent_123',
        stripePaymentIntentId: mockPaymentIntentId,
        amount: mockAmount,
        currency: mockCurrency,
        status: PaymentStatus.CREATED,
      });

      const event = createMockEvent('payment_intent.payment_failed', 'requires_payment_method');
      const result = await service.handleWebhookEvent(event);

      expect(result).toBe(true);
      expect(mockPrisma.payment.update).toHaveBeenCalledWith({
        where: { id: 'payment_123' },
        data: { status: PaymentStatus.FAILED },
      });
      expect(mockPrisma.paymentEvent.create).toHaveBeenCalledWith({
        data: {
          paymentId: 'payment_123',
          eventType: 'payment_intent.payment_failed',
          previousStatus: PaymentStatus.CREATED,
          newStatus: PaymentStatus.FAILED,
          amount: mockAmount,
          source: PaymentEventSource.WEBHOOK,
          stripeEventId,
          createdBy: 'stripe_webhook',
          metadata: expect.any(Object),
        },
      });
    });

    it('T006: handles payment_intent.canceled (AUTHORIZED -> CANCELLED)', async () => {
      mockPrisma.paymentEvent.findUnique.mockResolvedValueOnce(null);
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        id: 'payment_123',
        bookingIntentId: 'intent_123',
        stripePaymentIntentId: mockPaymentIntentId,
        amount: mockAmount,
        currency: mockCurrency,
        status: PaymentStatus.AUTHORIZED,
      });

      const event = createMockEvent('payment_intent.canceled', 'canceled');
      const result = await service.handleWebhookEvent(event);

      expect(result).toBe(true);
      expect(mockPrisma.payment.update).toHaveBeenCalledWith({
        where: { id: 'payment_123' },
        data: { status: PaymentStatus.CANCELLED },
      });
    });

    it('T007: performs Tier 1 self-healing reconciliation for out-of-order transition (CREATED -> SUCCEEDED)', async () => {
      mockPrisma.paymentEvent.findUnique.mockResolvedValueOnce(null);
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        id: 'payment_123',
        bookingIntentId: 'intent_123',
        stripePaymentIntentId: mockPaymentIntentId,
        amount: mockAmount,
        currency: mockCurrency,
        status: PaymentStatus.CREATED,
      });
      mockPrisma.ledgerEntry.findFirst.mockResolvedValueOnce(null);

      mockStripe.retrievePaymentIntent.mockResolvedValueOnce({
        id: mockPaymentIntentId,
        status: 'succeeded',
      });

      const event = createMockEvent('payment_intent.succeeded', 'succeeded');
      const result = await service.handleWebhookEvent(event);

      expect(result).toBe(true);
      expect(mockStripe.retrievePaymentIntent).toHaveBeenCalledWith(mockPaymentIntentId);
      expect(mockPrisma.payment.update).toHaveBeenCalledWith({
        where: { id: 'payment_123' },
        data: { status: PaymentStatus.SUCCEEDED },
      });
      expect(mockPrisma.bookingIntent.update).toHaveBeenCalledWith({
        where: { id: 'intent_123' },
        data: { status: 'CONFIRMED' },
      });
      expect(mockPrisma.ledgerEntry.createMany).toHaveBeenCalled();
    });

    it('T008: performs Tier 2 alert + drop for irreconcilable transition (REFUNDED -> SUCCEEDED)', async () => {
      mockPrisma.paymentEvent.findUnique.mockResolvedValueOnce(null);
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        id: 'payment_123',
        bookingIntentId: 'intent_123',
        stripePaymentIntentId: mockPaymentIntentId,
        amount: mockAmount,
        currency: mockCurrency,
        status: PaymentStatus.REFUNDED,
      });

      const event = createMockEvent('payment_intent.succeeded', 'succeeded');
      const result = await service.handleWebhookEvent(event);

      expect(result).toBe(true);
      expect(mockStripe.retrievePaymentIntent).not.toHaveBeenCalled();
      expect(mockPrisma.payment.update).not.toHaveBeenCalled();
      expect(mockPrisma.paymentEvent.create).not.toHaveBeenCalled();
    });

    it('T008: performs Tier 2 alert + drop if Stripe retrieval mismatches event status', async () => {
      mockPrisma.paymentEvent.findUnique.mockResolvedValueOnce(null);
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        id: 'payment_123',
        bookingIntentId: 'intent_123',
        stripePaymentIntentId: mockPaymentIntentId,
        amount: mockAmount,
        currency: mockCurrency,
        status: PaymentStatus.CREATED,
      });

      mockStripe.retrievePaymentIntent.mockResolvedValueOnce({
        id: mockPaymentIntentId,
        status: 'canceled',
      });

      const event = createMockEvent('payment_intent.succeeded', 'succeeded');
      const result = await service.handleWebhookEvent(event);

      expect(result).toBe(true);
      expect(mockStripe.retrievePaymentIntent).toHaveBeenCalledWith(mockPaymentIntentId);
      expect(mockPrisma.payment.update).not.toHaveBeenCalled();
    });

    it('returns true if payment intent not found in DB', async () => {
      mockPrisma.paymentEvent.findUnique.mockResolvedValueOnce(null);
      mockPrisma.payment.findUnique.mockResolvedValueOnce(null);

      const event = createMockEvent('payment_intent.succeeded', 'succeeded');
      
      const result = await service.handleWebhookEvent(event);
      expect(result).toBe(true);
    });

    it('Issue 1: handles concurrent duplicate event (Prisma P2002 on stripeEventId) gracefully by returning true', async () => {
      mockPrisma.paymentEvent.findUnique.mockResolvedValueOnce(null);
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        id: 'payment_123',
        bookingIntentId: 'intent_123',
        stripePaymentIntentId: mockPaymentIntentId,
        amount: mockAmount,
        currency: mockCurrency,
        status: PaymentStatus.AUTHORIZED,
      });
      
      const prismaError = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed',
        { code: 'P2002', clientVersion: '5.14.0', meta: { target: ['stripeEventId'] } }
      );
      mockPrisma.payment.update.mockRejectedValueOnce(prismaError);

      const event = createMockEvent('payment_intent.succeeded', 'succeeded');
      const result = await service.handleWebhookEvent(event);

      expect(result).toBe(true);
    });

    it('Issue 2: drops/fails self-healing if target status is FAILED and canonical status is canceled (out-of-order transition AUTHORIZED -> FAILED)', async () => {
      mockPrisma.paymentEvent.findUnique.mockResolvedValueOnce(null);
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        id: 'payment_123',
        bookingIntentId: 'intent_123',
        stripePaymentIntentId: mockPaymentIntentId,
        amount: mockAmount,
        currency: mockCurrency,
        status: PaymentStatus.AUTHORIZED,
      });

      mockStripe.retrievePaymentIntent.mockResolvedValueOnce({
        id: mockPaymentIntentId,
        status: 'canceled',
      });

      const event = createMockEvent('payment_intent.payment_failed', 'canceled');
      const result = await service.handleWebhookEvent(event);

      expect(result).toBe(true);
      expect(mockPrisma.payment.update).not.toHaveBeenCalled();
    });
  });
});
