import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PaymentStatus, BookingIntentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from '../common/stripe.service';
import { enforceTransition } from './payment-state-machine';

@Injectable()
export class PaymentCronService {
  private readonly logger = new Logger(PaymentCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
    private readonly configService: ConfigService,
  ) {}

  @Cron('*/5 * * * *')
  async handleAuthorizationExpiry(): Promise<void> {
    const start = Date.now();
    this.logger.log('Starting authorization expiry sweep...');

    const expireMinutes = this.configService.get<number>(
      'PAYMENT_AUTH_EXPIRE_MINUTES',
      60,
    );
    const cutoff = new Date(Date.now() - expireMinutes * 60 * 1000);

    let expiredCount = 0;
    let failureCount = 0;

    try {
      const payments = await this.prisma.payment.findMany({
        where: {
          status: PaymentStatus.AUTHORIZED,
          updatedAt: { lt: cutoff },
        },
        include: { bookingIntent: true },
      });

      for (const payment of payments) {
        try {
          enforceTransition(PaymentStatus.AUTHORIZED, PaymentStatus.EXPIRED);

          await this.stripeService.cancelPaymentIntent(
            payment.stripePaymentIntentId,
          );

          await this.prisma.payment.update({
            where: {
              id: payment.id,
              version: payment.version,
            },
            data: {
              status: PaymentStatus.EXPIRED,
              version: { increment: 1 },
            },
          });

          await this.prisma.paymentEvent.create({
            data: {
              paymentId: payment.id,
              eventType: 'authorization.expired',
              previousStatus: PaymentStatus.AUTHORIZED,
              newStatus: PaymentStatus.EXPIRED,
              amount: payment.amount,
              source: 'CRON',
              createdBy: 'system',
            },
          });

          await this.updateBookingIntentOnExpiry(payment.bookingIntentId, payment.bookingIntent.paymentAttemptCount);

          this.logger.log(
            `Expired payment ${payment.id} (PI: ${payment.stripePaymentIntentId})`,
          );
          expiredCount++;
        } catch (error) {
          failureCount++;
          this.logger.error(
            `Failed to expire payment ${payment.id}: ${(error as Error).message}`,
            (error as Error).stack,
          );
        }
      }

      const duration = Date.now() - start;
      this.logger.log(
        `Authorization expiry sweep completed in ${duration}ms. Expired: ${expiredCount}, Failures: ${failureCount}`,
      );
    } catch (error) {
      this.logger.error(
        `Authorization expiry sweep failed: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleIdempotencyKeyCleanup(): Promise<void> {
    const start = Date.now();
    this.logger.log('Starting idempotency key cleanup...');

    try {
      const result = await this.prisma.idempotencyKey.deleteMany({
        where: {
          expiresAt: { lt: new Date() },
          recoveryPoint: 'completed',
        },
      });

      const duration = Date.now() - start;
      this.logger.log(
        `Idempotency key cleanup completed in ${duration}ms. Deleted: ${result.count}`,
      );
    } catch (error) {
      this.logger.error(
        `Idempotency key cleanup failed: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }

  @Cron('*/5 * * * *')
  async handleStaleLockDetection(): Promise<void> {
    const start = Date.now();
    this.logger.log('Starting stale lock detection...');

    const lockTimeoutMinutes = this.configService.get<number>(
      'IDEMPOTENCY_LOCK_TIMEOUT_MINUTES',
      5,
    );
    const lockCutoff = new Date(Date.now() - lockTimeoutMinutes * 60 * 1000);

    try {
      const result = await this.prisma.idempotencyKey.updateMany({
        where: {
          lockedAt: { not: null, lt: lockCutoff },
        },
        data: {
          lockedAt: null,
        },
      });

      const duration = Date.now() - start;
      this.logger.log(
        `Stale lock detection completed in ${duration}ms. Cleared: ${result.count}`,
      );
    } catch (error) {
      this.logger.error(
        `Stale lock detection failed: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }

  private async updateBookingIntentOnExpiry(
    bookingIntentId: string,
    paymentAttemptCount: number,
  ): Promise<void> {
    const maxAttempts = this.configService.get<number>(
      'PAYMENT_MAX_ATTEMPTS',
      2,
    );
    const newStatus: BookingIntentStatus =
      paymentAttemptCount >= maxAttempts
        ? BookingIntentStatus.PAYMENT_EXHAUSTED
        : BookingIntentStatus.AWAITING_PAYMENT;

    await this.prisma.bookingIntent.update({
      where: { id: bookingIntentId },
      data: { status: newStatus },
    });

    this.logger.log(
      `Updated booking intent ${bookingIntentId} to ${newStatus}`,
    );
  }
}
