import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { BookingStatus, PaymentStatus } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { StripeService } from '@/common/stripe.service';
import { PaymentIdempotencyService } from '@/payment/payment-idempotency.service';
import { AuditService } from '@/audit/audit.service';
import { PaymentRefundService } from './payment-refund.service';

describe('PaymentRefundService cancellation refunds', () => {
  let service: PaymentRefundService;
  const prisma = {
    payment: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    booking: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    refund: { findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    idempotencyKey: { findUnique: jest.fn() },
    paymentEvent: { create: jest.fn() },
    ledgerEntry: { createMany: jest.fn() },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
  };
  const stripe = { createRefund: jest.fn() };
  const idempotency = {
    acquireOrReplay: jest.fn(),
    completeKey: jest.fn(),
  };
  const audit = { createLog: jest.fn() };

  beforeEach(async () => {
    jest.resetAllMocks();
    idempotency.acquireOrReplay.mockResolvedValue({ status: 'acquired' });
    idempotency.completeKey.mockResolvedValue(undefined);
    prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma));
    prisma.payment.findUnique.mockResolvedValue({
      id: 'payment-1',
      stripePaymentIntentId: 'pi_1',
      status: PaymentStatus.SUCCEEDED,
      bookingIntent: { userId: 'user-1' },
    });
    prisma.booking.findUnique.mockResolvedValue({
      id: 'booking-1',
      paymentId: 'payment-1',
      status: BookingStatus.CANCELLED_PENDING_REFUND,
    });
    prisma.idempotencyKey.findUnique.mockResolvedValue({ id: 'key-1' });
    prisma.refund.findFirst.mockResolvedValue(null);
    prisma.refund.create.mockResolvedValue({ id: 'refund-1' });
    prisma.payment.updateMany.mockResolvedValue({ count: 1 });
    prisma.refund.updateMany.mockResolvedValue({ count: 1 });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentRefundService,
        { provide: PrismaService, useValue: prisma },
        { provide: StripeService, useValue: stripe },
        { provide: PaymentIdempotencyService, useValue: idempotency },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = module.get(PaymentRefundService);
  });

  it('finalizes the refund, payment, booking, event, and balanced ledger atomically after Stripe succeeds', async () => {
    stripe.createRefund.mockResolvedValue({ id: 're_1', status: 'succeeded' });

    const result = await service.processCancellationRefund({
      bookingId: 'booking-1',
      paymentId: 'payment-1',
      amount: 12_500,
      currency: 'usd',
    });

    expect(result).toEqual({ refundStatus: 'SUCCEEDED', refundAmount: '125.00' });
    expect(stripe.createRefund).toHaveBeenCalledWith('pi_1', 12_500, 'requested_by_customer', 'cancellation-refund:booking-1');
    expect(prisma.refund.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'refund-1', status: 'REFUND_PENDING' },
      data: expect.objectContaining({ status: 'SUCCEEDED', stripeRefundId: 're_1' }),
    }));
    expect(prisma.payment.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'payment-1' },
      data: expect.objectContaining({ status: PaymentStatus.REFUNDED }),
    }));
    expect(prisma.booking.update).toHaveBeenCalledWith({
      where: { id: 'booking-1' },
      data: { status: BookingStatus.CANCELLED_AND_REFUNDED },
    });
    expect(prisma.ledgerEntry.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: [
        expect.objectContaining({ accountId: 'PLATFORM_REVENUE', entryType: 'DEBIT', amount: 12_500 }),
        expect.objectContaining({ accountId: 'CUSTOMER_RECEIVABLE', entryType: 'CREDIT', amount: 12_500 }),
      ],
    }));
  });

  it('retries only transient Stripe failures with the same deterministic idempotency key and leaves exhaustion pending', async () => {
    stripe.createRefund
      .mockRejectedValueOnce({ statusCode: 503, message: 'upstream unavailable' })
      .mockRejectedValueOnce({ statusCode: 429, message: 'rate limited' })
      .mockRejectedValueOnce({ statusCode: 500, message: 'upstream unavailable' })
      .mockRejectedValueOnce({ statusCode: 503, message: 'upstream unavailable' });
    jest.spyOn(service as unknown as { delay: (milliseconds: number) => Promise<void> }, 'delay').mockResolvedValue();

    const result = await service.processCancellationRefund({
      bookingId: 'booking-1',
      paymentId: 'payment-1',
      amount: 12_500,
      currency: 'usd',
    });

    expect(result.refundStatus).toBe('REFUND_RETRY_SCHEDULED');
    expect(result.nextRetryAt).toEqual(expect.any(String));
    expect(stripe.createRefund).toHaveBeenCalledTimes(4);
    expect(stripe.createRefund.mock.calls.map((call) => call[3])).toEqual([
      'cancellation-refund:booking-1',
      'cancellation-refund:booking-1',
      'cancellation-refund:booking-1',
      'cancellation-refund:booking-1',
    ]);
    expect(prisma.refund.update).not.toHaveBeenCalled();
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  it('marks a permanently rejected refund for attention and restores the payment state', async () => {
    stripe.createRefund.mockRejectedValue({ statusCode: 400, message: 'invalid refund request' });

    await expect(service.processCancellationRefund({
      bookingId: 'booking-1',
      paymentId: 'payment-1',
      amount: 12_500,
      currency: 'usd',
    })).rejects.toEqual(expect.objectContaining({ statusCode: 400 }));

    expect(prisma.refund.updateMany).toHaveBeenCalledWith({
      where: { id: 'refund-1', status: 'REFUND_PENDING' },
      data: { status: 'REFUND_FAILED_NEEDS_ATTENTION' },
    });
    expect(prisma.payment.updateMany).toHaveBeenCalledWith({
      where: { id: 'payment-1', status: PaymentStatus.REFUND_PENDING },
      data: { status: PaymentStatus.SUCCEEDED },
    });
    expect(prisma.paymentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ eventType: 'cancellation_refund_failed' }),
    }));
    expect(prisma.booking.updateMany).toHaveBeenCalledWith({
      where: { id: 'booking-1', status: 'CANCELLED_PENDING_REFUND' },
      data: { status: 'REFUND_FAILED_NEEDS_ATTENTION' },
    });
  });

  it('does not write ledger entries or events when a webhook already finalized the refund', async () => {
    stripe.createRefund.mockResolvedValue({ id: 're_1', status: 'succeeded' });
    prisma.refund.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.processCancellationRefund({
      bookingId: 'booking-1',
      paymentId: 'payment-1',
      amount: 12_500,
      currency: 'usd',
    })).resolves.toEqual({ refundStatus: 'SUCCEEDED', refundAmount: '125.00' });

    expect(prisma.payment.update).not.toHaveBeenCalled();
    expect(prisma.booking.update).not.toHaveBeenCalled();
    expect(prisma.booking.updateMany).toHaveBeenCalledWith({
      where: { id: 'booking-1', status: 'CANCELLED_PENDING_REFUND' },
      data: { status: 'CANCELLED_AND_REFUNDED' },
    });
    expect(prisma.ledgerEntry.createMany).not.toHaveBeenCalled();
    expect(prisma.paymentEvent.create).toHaveBeenCalledTimes(1);
  });

  it('escalates a stale cancellation refund before calling Stripe again', async () => {
    prisma.refund.findUnique.mockResolvedValue({
      id: 'refund-1',
      status: 'REFUND_PROCESSING',
      bookingId: 'booking-1',
      paymentId: 'payment-1',
      retryCount: 0,
      amount: 12_500,
      currency: 'usd',
      idempotencyKeyCreatedAt: new Date(Date.now() - 22 * 60 * 60 * 1000),
      payment: { id: 'payment-1', stripePaymentIntentId: 'pi_1' },
      idempotencyKey: { key: 'cancellation-refund:booking-1' },
    });
    prisma.refund.updateMany.mockResolvedValue({ count: 1 });

    await service.recoverScheduledCancellationRefund('refund-1');

    expect(stripe.createRefund).not.toHaveBeenCalled();
    expect(prisma.refund.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'refund-1', status: 'REFUND_PROCESSING' },
      data: expect.objectContaining({
        status: 'REFUND_FAILED_NEEDS_ATTENTION',
        lastErrorCode: 'IDEMPOTENCY_KEY_SAFETY_WINDOW',
      }),
    }));
    expect(prisma.booking.updateMany).toHaveBeenCalledWith({
      where: { id: 'booking-1', status: 'CANCELLED_PENDING_REFUND' },
      data: { status: 'REFUND_FAILED_NEEDS_ATTENTION' },
    });
  });

  it('requeues a transient worker failure for the next retry window without changing its Stripe key', async () => {
    prisma.refund.findUnique.mockResolvedValue({
      id: 'refund-1',
      status: 'REFUND_PROCESSING',
      bookingId: 'booking-1',
      paymentId: 'payment-1',
      retryCount: 0,
      amount: 12_500,
      currency: 'usd',
      idempotencyKeyCreatedAt: new Date(),
      payment: { id: 'payment-1', stripePaymentIntentId: 'pi_1' },
      idempotencyKey: { key: 'cancellation-refund:booking-1' },
    });
    stripe.createRefund.mockRejectedValue({ statusCode: 503, message: 'unavailable' });
    prisma.refund.updateMany.mockResolvedValue({ count: 1 });

    await service.recoverScheduledCancellationRefund('refund-1');

    expect(stripe.createRefund).toHaveBeenCalledWith(
      'pi_1', 12_500, 'requested_by_customer', 'cancellation-refund:booking-1',
    );
    expect(prisma.refund.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'refund-1', status: 'REFUND_PROCESSING' },
      data: expect.objectContaining({
        status: 'REFUND_RETRY_SCHEDULED',
        retryCount: { increment: 1 },
        nextRetryAt: expect.any(Date),
        lastErrorCode: 'HTTP_503',
      }),
    }));
  });

  it('finalizes a CAS-claimed scheduled refund exactly once after Stripe succeeds', async () => {
    prisma.refund.findUnique.mockResolvedValue({
      id: 'refund-1',
      status: 'REFUND_PROCESSING',
      bookingId: 'booking-1',
      paymentId: 'payment-1',
      retryCount: 1,
      amount: 12_500,
      currency: 'usd',
      idempotencyKeyCreatedAt: new Date(),
      payment: { id: 'payment-1', stripePaymentIntentId: 'pi_1' },
      idempotencyKey: { key: 'cancellation-refund:booking-1' },
    });
    stripe.createRefund.mockResolvedValue({ id: 're_1' });
    prisma.refund.updateMany.mockResolvedValue({ count: 1 });

    await service.recoverScheduledCancellationRefund('refund-1');

    expect(prisma.refund.updateMany).toHaveBeenCalledWith({
      where: { id: 'refund-1', status: 'REFUND_PROCESSING' },
      data: { status: 'SUCCEEDED', stripeRefundId: 're_1', nextRetryAt: null },
    });
    expect(prisma.booking.updateMany).toHaveBeenCalledWith({
      where: { id: 'booking-1', status: 'CANCELLED_PENDING_REFUND' },
      data: { status: 'CANCELLED_AND_REFUNDED' },
    });
    expect(prisma.ledgerEntry.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: [
        expect.objectContaining({ accountId: 'PLATFORM_REVENUE', entryType: 'DEBIT', amount: 12_500 }),
        expect.objectContaining({ accountId: 'CUSTOMER_RECEIVABLE', entryType: 'CREDIT', amount: 12_500 }),
      ],
    }));
  });

  it('records balanced accounting entries and a payment event when an admin confirms an external refund', async () => {
    prisma.refund.findUnique.mockResolvedValue({
      id: 'refund-1',
      bookingId: 'booking-1',
      paymentId: 'payment-1',
      status: 'REFUND_FAILED_NEEDS_ATTENTION',
      amount: 12_500,
      currency: 'usd',
    });

    await service.resolveEscalatedCancellationRefund('refund-1', 'MARK_RESOLVED_MANUALLY');

    expect(prisma.ledgerEntry.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: [
        expect.objectContaining({
          paymentId: 'payment-1',
          accountId: 'PLATFORM_REVENUE',
          entryType: 'DEBIT',
          amount: 12_500,
          currency: 'usd',
        }),
        expect.objectContaining({
          paymentId: 'payment-1',
          accountId: 'CUSTOMER_RECEIVABLE',
          entryType: 'CREDIT',
          amount: 12_500,
          currency: 'usd',
        }),
      ],
    }));
    expect(prisma.paymentEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        paymentId: 'payment-1',
        eventType: 'cancellation_refund_manually_resolved',
        previousStatus: PaymentStatus.SUCCEEDED,
        newStatus: PaymentStatus.REFUNDED,
        amount: 12_500,
        source: 'API',
        createdBy: 'admin_refund_resolution',
      }),
    });
  });

  it('does not apply a manual resolution when another admin already claimed the refund', async () => {
    prisma.refund.findUnique.mockResolvedValue({
      id: 'refund-1',
      bookingId: 'booking-1',
      paymentId: 'payment-1',
      status: 'REFUND_FAILED_NEEDS_ATTENTION',
      amount: 12_500,
      currency: 'usd',
    });
    prisma.refund.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      service.resolveEscalatedCancellationRefund('refund-1', 'MARK_RESOLVED_MANUALLY'),
    ).rejects.toThrow('Refund is not awaiting manual resolution');

    expect(prisma.payment.update).not.toHaveBeenCalled();
    expect(prisma.booking.update).not.toHaveBeenCalled();
    expect(prisma.ledgerEntry.createMany).not.toHaveBeenCalled();
    expect(prisma.paymentEvent.create).not.toHaveBeenCalled();
    expect(audit.createLog).not.toHaveBeenCalled();
  });

  it('transitions associated CANCELLED_PENDING_REFUND bookings to CANCELLED_AND_REFUNDED upon charge.refunded webhook completion', async () => {
    prisma.payment.findUnique.mockResolvedValue({
      id: 'payment-1',
      stripePaymentIntentId: 'pi_1',
      status: PaymentStatus.REFUND_PENDING,
      amount: 10000,
      currency: 'usd',
    });
    prisma.refund.findMany
      .mockResolvedValueOnce([
        {
          id: 'refund-1',
          paymentId: 'payment-1',
          status: 'REFUND_PENDING',
          stripeRefundId: 're_1',
          bookingId: 'booking-1',
          amount: 10000,
        },
      ])
      .mockResolvedValueOnce([
        { amount: 10000 },
      ]);
    prisma.refund.updateMany.mockResolvedValue({ count: 1 });
    prisma.payment.update.mockResolvedValue({ id: 'payment-1' });
    prisma.booking.updateMany.mockResolvedValue({ count: 1 });
    prisma.ledgerEntry.createMany.mockResolvedValue({ count: 2 });
    prisma.paymentEvent.create.mockResolvedValue({ id: 'evt-1' });

    const webhookEvent = {
      id: 'evt_stripe_1',
      type: 'charge.refunded',
      data: {
        object: {
          payment_intent: 'pi_1',
          amount_refunded: 10000,
          refunds: {
            data: [{ id: 're_1', amount: 10000 }],
          },
        },
      },
    };

    await service.handleChargeRefunded(webhookEvent);

    expect(prisma.booking.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['booking-1'] },
        status: BookingStatus.CANCELLED_PENDING_REFUND,
      },
      data: { status: BookingStatus.CANCELLED_AND_REFUNDED },
    });
    expect(prisma.booking.updateMany).toHaveBeenCalledWith({
      where: {
        paymentId: 'payment-1',
        status: BookingStatus.CANCELLED_PENDING_REFUND,
      },
      data: { status: BookingStatus.CANCELLED_AND_REFUNDED },
    });
    expect(prisma.payment.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'payment-1' },
      data: { status: PaymentStatus.REFUNDED },
    }));
  });
});
