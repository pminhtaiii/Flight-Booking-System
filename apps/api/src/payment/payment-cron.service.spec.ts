import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { BookingIntentStatus, PaymentEventSource, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from '../common/stripe.service';
import { PaymentCronService } from './payment-cron.service';

describe('PaymentCronService', () => {
  let service: PaymentCronService;
  let prisma: {
    payment: { findMany: jest.Mock; update: jest.Mock };
    idempotencyKey: { deleteMany: jest.Mock; updateMany: jest.Mock };
    paymentEvent: { create: jest.Mock };
    bookingIntent: { update: jest.Mock };
    ledgerEntry: { findFirst: jest.Mock; createMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let stripeService: { cancelPaymentIntent: jest.Mock; retrievePaymentIntent: jest.Mock };

  const payment = {
    id: 'payment-1',
    bookingIntentId: 'booking-intent-1',
    stripePaymentIntentId: 'pi_1',
    version: 0,
    amount: 12000,
    currency: 'usd',
    bookingIntent: { paymentAttemptCount: 1 },
  };

  beforeEach(() => {
    prisma = {
      payment: { findMany: jest.fn(), update: jest.fn() },
      idempotencyKey: { deleteMany: jest.fn(), updateMany: jest.fn() },
      paymentEvent: { create: jest.fn() },
      bookingIntent: { update: jest.fn() },
      ledgerEntry: { findFirst: jest.fn(), createMany: jest.fn() },
      $transaction: jest.fn(async (callback) => callback(prisma)),
    };
    stripeService = { cancelPaymentIntent: jest.fn(), retrievePaymentIntent: jest.fn() };
    const configService = { get: jest.fn((_key: string, defaultValue: number) => defaultValue) };

    service = new PaymentCronService(
      prisma as unknown as PrismaService,
      stripeService as unknown as StripeService,
      configService as unknown as ConfigService,
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
    prisma.ledgerEntry.findFirst.mockResolvedValue(null);

    await service.handleAuthorizationExpiry();

    expect(stripeService.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(prisma.payment.update).toHaveBeenCalledWith({
      where: { id: payment.id, version: payment.version },
      data: { status: PaymentStatus.SUCCEEDED, version: { increment: 1 } },
    });
    expect(prisma.paymentEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: 'payment_intent.succeeded',
        previousStatus: PaymentStatus.AUTHORIZED,
        newStatus: PaymentStatus.SUCCEEDED,
        source: PaymentEventSource.CRON,
      }),
    });
    expect(prisma.bookingIntent.update).toHaveBeenCalledWith({
      where: { id: payment.bookingIntentId },
      data: { status: BookingIntentStatus.CONFIRMED },
    });
  });
});
