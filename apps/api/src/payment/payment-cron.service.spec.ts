import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { BookingIntentStatus, PaymentEventSource, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from '../common/stripe.service';
import { PaymentCronService } from './payment-cron.service';
import { PaymentMethodService } from './payment-method.service';

describe('PaymentCronService', () => {
  let service: PaymentCronService;
  let prisma: {
    payment: { findMany: jest.Mock; update: jest.Mock };
    idempotencyKey: { deleteMany: jest.Mock; updateMany: jest.Mock };
    paymentEvent: { create: jest.Mock };
    bookingIntent: { findUnique: jest.Mock; update: jest.Mock };
    ledgerEntry: { findFirst: jest.Mock; createMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let transaction: {
    payment: { update: jest.Mock };
    paymentEvent: { create: jest.Mock };
    bookingIntent: { findUnique: jest.Mock; update: jest.Mock };
    ledgerEntry: { findFirst: jest.Mock; createMany: jest.Mock };
  };
  let stripeService: { cancelPaymentIntent: jest.Mock; retrievePaymentIntent: jest.Mock };
  let paymentMethodService: { saveMethod: jest.Mock };

  const payment = {
    id: 'payment-1',
    bookingIntentId: 'booking-intent-1',
    stripePaymentIntentId: 'pi_1',
    version: 0,
    amount: 12000,
    currency: 'usd',
    stripeCustomerId: 'cus_1',
    bookingIntent: { paymentAttemptCount: 1, userId: 'user-1' },
  };

  beforeEach(() => {
    prisma = {
      payment: { findMany: jest.fn(), update: jest.fn() },
      idempotencyKey: { deleteMany: jest.fn(), updateMany: jest.fn() },
      paymentEvent: { create: jest.fn() },
      bookingIntent: { findUnique: jest.fn(), update: jest.fn() },
      ledgerEntry: { findFirst: jest.fn(), createMany: jest.fn() },
      $transaction: jest.fn(),
    };
    transaction = {
      payment: { update: jest.fn() },
      paymentEvent: { create: jest.fn() },
      bookingIntent: { findUnique: jest.fn(), update: jest.fn() },
      ledgerEntry: { findFirst: jest.fn(), createMany: jest.fn() },
    };
    prisma.$transaction.mockImplementation(async (callback) => callback(transaction));
    transaction.bookingIntent.findUnique.mockResolvedValue({ paymentAttemptCount: 1 });
    stripeService = { cancelPaymentIntent: jest.fn(), retrievePaymentIntent: jest.fn() };
    paymentMethodService = { saveMethod: jest.fn() };
    const configService = { get: jest.fn((_key: string, defaultValue: number) => defaultValue) };

    service = new PaymentCronService(
      prisma as unknown as PrismaService,
      stripeService as unknown as StripeService,
      configService as unknown as ConfigService,
      paymentMethodService as unknown as PaymentMethodService,
    );
  });

  it('deletes every expired idempotency key regardless of recovery point', async () => {
    prisma.idempotencyKey.deleteMany.mockResolvedValue({ count: 3 });

    await service.handleIdempotencyKeyCleanup();

    expect(prisma.idempotencyKey.deleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lt: expect.any(Date) } },
    });
  });

  it('reconciles a succeeded Stripe intent instead of expiring it', async () => {
    prisma.payment.findMany.mockResolvedValue([payment]);
    stripeService.retrievePaymentIntent.mockResolvedValue({ status: 'succeeded' });
    transaction.ledgerEntry.findFirst.mockResolvedValue(null);

    await service.handleAuthorizationExpiry();

    expect(stripeService.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(transaction.payment.update).toHaveBeenCalledWith({
      where: { id: payment.id, version: payment.version },
      data: { status: PaymentStatus.SUCCEEDED, version: { increment: 1 } },
    });
    expect(transaction.paymentEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: 'payment_intent.succeeded',
        previousStatus: PaymentStatus.AUTHORIZED,
        newStatus: PaymentStatus.SUCCEEDED,
        source: PaymentEventSource.CRON,
      }),
    });
    expect(transaction.bookingIntent.update).toHaveBeenCalledWith({
      where: { id: payment.bookingIntentId },
      data: { status: BookingIntentStatus.CONFIRMED },
    });
    expect(paymentMethodService.saveMethod).toHaveBeenCalledWith(
      payment.bookingIntent.userId,
      payment.stripeCustomerId,
      payment.stripePaymentIntentId,
    );
  });

  it('expires an uncaptured authorization together with its event and booking intent', async () => {
    prisma.payment.findMany.mockResolvedValue([payment]);
    stripeService.retrievePaymentIntent.mockResolvedValue({ status: 'requires_capture' });

    await service.handleAuthorizationExpiry();

    expect(stripeService.cancelPaymentIntent).toHaveBeenCalledWith(
      payment.stripePaymentIntentId,
    );
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(transaction.payment.update).toHaveBeenCalledWith({
      where: { id: payment.id, version: payment.version },
      data: { status: PaymentStatus.EXPIRED, version: { increment: 1 } },
    });
    expect(transaction.paymentEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: 'authorization.expired',
        previousStatus: PaymentStatus.AUTHORIZED,
        newStatus: PaymentStatus.EXPIRED,
        source: PaymentEventSource.CRON,
      }),
    });
    expect(transaction.bookingIntent.update).toHaveBeenCalledWith({
      where: { id: payment.bookingIntentId },
      data: { status: BookingIntentStatus.AWAITING_PAYMENT },
    });
    expect(prisma.payment.update).not.toHaveBeenCalled();
    expect(prisma.paymentEvent.create).not.toHaveBeenCalled();
    expect(prisma.bookingIntent.update).not.toHaveBeenCalled();
  });

  it('uses the transaction-local payment attempt count when expiring an authorization', async () => {
    prisma.payment.findMany.mockResolvedValue([payment]);
    stripeService.retrievePaymentIntent.mockResolvedValue({ status: 'requires_capture' });
    transaction.bookingIntent.findUnique.mockResolvedValue({ paymentAttemptCount: 2 });

    await service.handleAuthorizationExpiry();

    expect(transaction.bookingIntent.findUnique).toHaveBeenCalledWith({
      where: { id: payment.bookingIntentId },
      select: { paymentAttemptCount: true },
    });
    expect(transaction.bookingIntent.update).toHaveBeenCalledWith({
      where: { id: payment.bookingIntentId },
      data: { status: BookingIntentStatus.PAYMENT_EXHAUSTED },
    });
  });

  it('expires a locally authorized payment when its Stripe intent is already canceled', async () => {
    prisma.payment.findMany.mockResolvedValue([payment]);
    stripeService.retrievePaymentIntent.mockResolvedValue({ status: 'canceled' });

    await service.handleAuthorizationExpiry();

    expect(stripeService.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(transaction.payment.update).toHaveBeenCalledWith({
      where: { id: payment.id, version: payment.version },
      data: { status: PaymentStatus.EXPIRED, version: { increment: 1 } },
    });
    expect(transaction.paymentEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: 'authorization.expired',
        previousStatus: PaymentStatus.AUTHORIZED,
        newStatus: PaymentStatus.EXPIRED,
        source: PaymentEventSource.CRON,
      }),
    });
    expect(transaction.bookingIntent.update).toHaveBeenCalledWith({
      where: { id: payment.bookingIntentId },
      data: { status: BookingIntentStatus.AWAITING_PAYMENT },
    });
  });
});
