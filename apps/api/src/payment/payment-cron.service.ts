import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@/prisma/prisma.service';
import { StripeService } from '@/common/stripe.service';
import { PaymentLedgerService } from './payment-ledger.service';
import { PaymentStatus } from '@prisma/client';
import { enforceTransition } from './payment-state-machine';

@Injectable()
export class PaymentCronService {
  private readonly logger = new Logger(PaymentCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly stripeService: StripeService,
    private readonly ledgerService: PaymentLedgerService,
  ) {}

  @Cron('*/5 * * * *')
  async handleAuthorizationExpiry(): Promise<void> {
    const startTime = Date.now();
    this.logger.log('Starting expired authorization sweep cron...');

    const authExpireMinutes = this.configService.get<number>('PAYMENT_AUTH_EXPIRE_MINUTES', 60);
    const adminAlertMinutes = this.configService.get<number>('PAYMENT_ADMIN_ALERT_MINUTES', 15);

    try {
      // Find all payments in AUTHORIZED status
      const payments = await this.prisma.payment.findMany({
        where: {
          status: PaymentStatus.AUTHORIZED,
        },
        include: {
          bookingIntent: true,
        },
      });

      let expiredCount = 0;
      let healedCount = 0;
      let staleCount = 0;

      const expireThresholdTime = new Date(Date.now() - authExpireMinutes * 60 * 1000);
      const staleThresholdTime = new Date(Date.now() - adminAlertMinutes * 60 * 1000);

      for (const payment of payments) {
        const isExpired = payment.updatedAt < expireThresholdTime;
        const isStale = payment.updatedAt < staleThresholdTime;

        if (isExpired) {
          // Check status in Stripe
          try {
            const stripeIntent = await this.stripeService.retrievePaymentIntent(payment.stripePaymentIntentId);

            if (stripeIntent.status === 'requires_capture') {
              // Void/cancel authorization
              const cancelKey = `payment-cancel-cron:${payment.id}`;
              await this.stripeService.cancelPaymentIntent(payment.stripePaymentIntentId, cancelKey);

              const nextIntentStatus = payment.bookingIntent.paymentAttemptCount >= 2 ? 'PAYMENT_EXHAUSTED' : 'AWAITING_PAYMENT';

              await this.prisma.$transaction(async (tx) => {
                const currentPayment = await tx.payment.findUnique({
                  where: { id: payment.id },
                });

                if (!currentPayment || currentPayment.status !== PaymentStatus.AUTHORIZED) {
                  return;
                }

                enforceTransition(currentPayment.status, PaymentStatus.EXPIRED);

                await tx.payment.update({
                  where: { id: payment.id, version: currentPayment.version },
                  data: {
                    status: PaymentStatus.EXPIRED,
                    version: { increment: 1 },
                  },
                });

                await tx.bookingIntent.update({
                  where: { id: payment.bookingIntentId },
                  data: {
                    status: nextIntentStatus,
                  },
                });

                await tx.paymentEvent.create({
                  data: {
                    paymentId: payment.id,
                    eventType: 'payment_intent.canceled',
                    previousStatus: PaymentStatus.AUTHORIZED,
                    newStatus: PaymentStatus.EXPIRED,
                    amount: payment.amount,
                    source: 'CRON',
                    createdBy: 'SYSTEM_CRON',
                  },
                });
              });

              this.logger.warn(`Expired payment ${payment.id} with requires_capture was canceled/expired.`);
              expiredCount++;
            } else if (stripeIntent.status === 'succeeded') {
              // Self-heal
              await this.prisma.$transaction(async (tx) => {
                const currentPayment = await tx.payment.findUnique({
                  where: { id: payment.id },
                });

                if (!currentPayment || currentPayment.status !== PaymentStatus.AUTHORIZED) {
                  return;
                }

                enforceTransition(currentPayment.status, PaymentStatus.SUCCEEDED);

                await tx.payment.update({
                  where: { id: payment.id, version: currentPayment.version },
                  data: {
                    status: PaymentStatus.SUCCEEDED,
                    version: { increment: 1 },
                  },
                });

                await tx.bookingIntent.update({
                  where: { id: payment.bookingIntentId },
                  data: {
                    status: 'COMPLETED',
                  },
                });

                await this.ledgerService.recordCaptureLedger(payment.id, payment.amount, payment.currency, tx);

                await tx.paymentEvent.create({
                  data: {
                    paymentId: payment.id,
                    eventType: 'payment_intent.succeeded',
                    previousStatus: PaymentStatus.AUTHORIZED,
                    newStatus: PaymentStatus.SUCCEEDED,
                    amount: payment.amount,
                    source: 'CRON',
                    createdBy: 'SYSTEM_CRON',
                  },
                });
              });

              this.logger.warn(`[ALERT] Self-healed expired AUTHORIZED payment ${payment.id} to SUCCEEDED because Stripe status was succeeded`);
              healedCount++;
            } else if (stripeIntent.status === 'canceled') {
              // Already canceled on Stripe, transition locally
              const nextIntentStatus = payment.bookingIntent.paymentAttemptCount >= 2 ? 'PAYMENT_EXHAUSTED' : 'AWAITING_PAYMENT';

              await this.prisma.$transaction(async (tx) => {
                const currentPayment = await tx.payment.findUnique({
                  where: { id: payment.id },
                });

                if (!currentPayment || currentPayment.status !== PaymentStatus.AUTHORIZED) {
                  return;
                }

                enforceTransition(currentPayment.status, PaymentStatus.EXPIRED);

                await tx.payment.update({
                  where: { id: payment.id, version: currentPayment.version },
                  data: {
                    status: PaymentStatus.EXPIRED,
                    version: { increment: 1 },
                  },
                });

                await tx.bookingIntent.update({
                  where: { id: payment.bookingIntentId },
                  data: {
                    status: nextIntentStatus,
                  },
                });

                await tx.paymentEvent.create({
                  data: {
                    paymentId: payment.id,
                    eventType: 'payment_intent.canceled',
                    previousStatus: PaymentStatus.AUTHORIZED,
                    newStatus: PaymentStatus.EXPIRED,
                    amount: payment.amount,
                    source: 'CRON',
                    createdBy: 'SYSTEM_CRON',
                  },
                });
              });

              this.logger.warn(`Expired payment ${payment.id} already canceled on Stripe was expired locally.`);
              expiredCount++;
            } else {
              this.logger.warn(`Expired payment ${payment.id} has unhandled Stripe status: ${stripeIntent.status}`);
            }
          } catch (stripeErr: any) {
            this.logger.error(`Failed to process expired payment ${payment.id}: ${stripeErr.message}`, stripeErr.stack);
          }
        } else if (isStale) {
          this.logger.warn(`[ALERT] Payment ${payment.id} in AUTHORIZED status is stale (older than ${adminAlertMinutes} minutes).`);
          staleCount++;
        }
      }

      const duration = Date.now() - startTime;
      this.logger.log(`Authorization expiry cron complete. Expired: ${expiredCount}, Healed: ${healedCount}, Stale: ${staleCount} in ${duration}ms.`);
    } catch (err: any) {
      this.logger.error(`Failed to run authorization expiry cron: ${err.message}`, err.stack);
    }
  }

  @Cron('0 * * * *')
  async handleIdempotencyKeyCleanup(): Promise<void> {
    const startTime = Date.now();
    this.logger.log('Starting idempotency key cleanup cron...');

    try {
      const now = new Date();
      const deleted = await this.prisma.idempotencyKey.deleteMany({
        where: {
          expiresAt: { lt: now },
          payments: { none: {} },
          refunds: { none: {} },
        },
      });

      const duration = Date.now() - startTime;
      this.logger.log(`Idempotency key cleanup cron complete. Deleted ${deleted.count} expired keys in ${duration}ms.`);
    } catch (err: any) {
      this.logger.error(`Failed to run idempotency key cleanup cron: ${err.message}`, err.stack);
    }
  }

  @Cron('*/5 * * * *')
  async handleStaleLockDetection(): Promise<void> {
    const startTime = Date.now();
    this.logger.log('Starting stale lock detection cron...');

    const lockTimeoutMinutes = this.configService.get<number>('IDEMPOTENCY_LOCK_TIMEOUT_MINUTES', 5);
    const staleTime = new Date(Date.now() - lockTimeoutMinutes * 60 * 1000);

    try {
      // Find locks that are stale
      const staleKeys = await this.prisma.idempotencyKey.findMany({
        where: {
          lockedAt: { lt: staleTime },
        },
      });

      if (staleKeys.length > 0) {
        for (const key of staleKeys) {
          this.logger.warn(`[WARNING] Clearing stale idempotency lock for key: ${key.key} (locked at ${key.lockedAt})`);
        }

        await this.prisma.idempotencyKey.updateMany({
          where: {
            lockedAt: { lt: staleTime },
          },
          data: {
            lockedAt: null,
          },
        });
      }

      const duration = Date.now() - startTime;
      this.logger.log(`Stale lock detection cron complete. Cleared ${staleKeys.length} stale locks in ${duration}ms.`);
    } catch (err: any) {
      this.logger.error(`Failed to run stale lock detection cron: ${err.message}`, err.stack);
    }
  }
}
