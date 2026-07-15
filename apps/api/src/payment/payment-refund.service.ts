import { Injectable, BadRequestException, NotFoundException, Logger, HttpStatus } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { StripeService } from '@/common/stripe.service';
import { PaymentIdempotencyService } from './payment-idempotency.service';
import { PaymentStatus, RefundStatus, RefundTriggerType, Prisma } from '@prisma/client';
import Stripe from 'stripe';
import * as crypto from 'crypto';

@Injectable()
export class PaymentRefundService {
  private readonly logger = new Logger(PaymentRefundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
    private readonly idempotencyService: PaymentIdempotencyService
  ) {}

  /**
   * Initiates a refund for a given payment.
   */
  async initiateRefund(
    paymentId: string,
    amount: number,
    reason: string,
    triggerType: RefundTriggerType,
    userId?: string,
    idempotencyKeyInput?: string
  ): Promise<any> {
    this.logger.log(
      `Initiating refund: paymentId=${paymentId}, amount=${amount}, triggerType=${triggerType}, userId=${userId}`
    );

    // Retrieve corresponding Payment from local DB
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { bookingIntent: true },
    });

    if (!payment) {
      throw new NotFoundException(`Payment with ID ${paymentId} not found`);
    }

    // 1. Generates/acquires an IdempotencyKey for the refund
    let idempotencyKey: string;
    if (triggerType === RefundTriggerType.SYSTEM_AUTOMATED) {
      const existingAutoRefund = await this.prisma.refund.findFirst({
        where: { paymentId, triggerType: RefundTriggerType.SYSTEM_AUTOMATED },
        include: { idempotencyKey: true },
      });

      if (existingAutoRefund) {
        idempotencyKey = existingAutoRefund.idempotencyKey.key;
      } else {
        const occurrence = 1;
        const sanitizedReason = reason.replace(/\s+/g, '_').toLowerCase();
        idempotencyKey = `refund:${paymentId}:${sanitizedReason}:${occurrence}`;
      }
    } else {
      idempotencyKey = idempotencyKeyInput || `refund-admin:${paymentId}:${crypto.randomUUID()}`;
    }

    const requestParams = { paymentId, amount, reason, triggerType };
    const requestHash = this.idempotencyService.computeHash(requestParams);
    const customerId = userId || payment.bookingIntent.userId;

    const result = await this.idempotencyService.acquireOrReplay({
      key: idempotencyKey,
      requestHash,
      customerId,
      requestPath: `/api/payments/${paymentId}/refund`,
      requestParams,
    });

    if (result.status === 'replay') {
      this.logger.log(`Idempotency key ${idempotencyKey} hit. Replaying refund response.`);
      return result.responseBody;
    }

    // 2. Checks if the payment is in a refundable state (SUCCEEDED or PARTIALLY_REFUNDED)
    if (payment.status !== PaymentStatus.SUCCEEDED && payment.status !== PaymentStatus.PARTIALLY_REFUNDED) {
      await this.idempotencyService.releaseLock(idempotencyKey, result.leaseToken!);
      throw new BadRequestException(
        `Payment ${paymentId} is not in a refundable state (current status: ${payment.status})`
      );
    }

    // 3. Validates that the refund amount is less than or equal to the remaining refundable balance
    const activeRefunds = await this.prisma.refund.findMany({
      where: {
        paymentId,
        status: { in: [RefundStatus.REFUND_PENDING, RefundStatus.SUCCEEDED] },
      },
    });

    const totalRefundedOrPending = activeRefunds.reduce((sum, r) => sum + r.amount, 0);
    const remainingBalance = payment.amount - totalRefundedOrPending;

    if (amount > remainingBalance) {
      await this.idempotencyService.releaseLock(idempotencyKey, result.leaseToken!);
      throw new BadRequestException(
        `Refund amount ${amount} exceeds the remaining refundable balance of ${remainingBalance}`
      );
    }

    const leaseToken = result.leaseToken!;

    try {
      // 4. Creates the Refund record and updates payment status & events in a single transaction
      let refundRecord;
      let paymentEventRecord;
      await this.prisma.$transaction(async (tx) => {
        const livePayment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });

        // Create local refund record
        refundRecord = await tx.refund.create({
          data: {
            paymentId,
            idempotencyKeyId: result.idempotencyKey.id,
            amount,
            currency: payment.currency,
            reason,
            triggerType,
            triggeredByUserId: userId || null,
            requiresReview: triggerType === RefundTriggerType.SYSTEM_AUTOMATED,
            status: RefundStatus.REFUND_PENDING,
          },
        });

        // Update payment status
        await tx.payment.update({
          where: { id: paymentId, version: livePayment.version },
          data: {
            status: PaymentStatus.REFUND_PENDING,
            version: { increment: 1 },
          },
        });

        // Create PaymentEvent
        paymentEventRecord = await tx.paymentEvent.create({
          data: {
            paymentId,
            eventType: 'refund.created',
            previousStatus: payment.status,
            newStatus: PaymentStatus.REFUND_PENDING,
            amount,
            source: triggerType === RefundTriggerType.SYSTEM_AUTOMATED ? 'SYSTEM' : 'API',
            createdBy: userId || 'SYSTEM',
          },
        });
      });

      // 5. Calls Stripe's refunds.create using stripeService.createRefund
      let stripeReason: Stripe.RefundCreateParams.Reason = 'requested_by_customer';
      if (triggerType === RefundTriggerType.SYSTEM_AUTOMATED) {
        stripeReason = 'duplicate';
      } else if (reason.toLowerCase().includes('duplicate')) {
        stripeReason = 'duplicate';
      } else if (reason.toLowerCase().includes('fraud')) {
        stripeReason = 'fraudulent';
      }

      const stripeRefund = await this.stripeService.createRefund({
        paymentIntentId: payment.stripePaymentIntentId,
        amount,
        reason: stripeReason,
        idempotencyKey,
      });

      // 6. Backfill Stripe refund ID on refund and event records
      await this.prisma.$transaction(async (tx) => {
        await tx.refund.update({
          where: { id: refundRecord.id },
          data: { stripeRefundId: stripeRefund.id },
        });

        await tx.paymentEvent.update({
          where: { id: paymentEventRecord.id },
          data: { stripeEventId: stripeRefund.id },
        });
      });

      const updatedRefund = await this.prisma.refund.findUnique({
        where: { id: (refundRecord as any).id },
      });

      // Complete the idempotency key
      await this.idempotencyService.completeKey(
        idempotencyKey,
        HttpStatus.CREATED,
        updatedRefund,
        leaseToken
      );

      this.logger.log(`Successfully initiated refund for Payment ${paymentId}`);
      return updatedRefund;
    } catch (error: any) {
      this.logger.error(`Failed to initiate refund for Payment ${paymentId}: ${error.message}`, error.stack);

      // If the DB transaction committed (refundRecord exists) but Stripe call failed,
      // clean up the orphaned REFUND_PENDING record so it does not permanently reduce
      // the refundable balance on subsequent attempts.
      if (refundRecord) {
        try {
          await this.prisma.$transaction(async (tx) => {
            const livePayment = await tx.payment.findUnique({ where: { id: paymentId } });

            await tx.refund.updateMany({
              where: { id: (refundRecord as any).id, status: RefundStatus.REFUND_PENDING },
              data: { status: RefundStatus.FAILED },
            });

            // Revert payment status to pre-refund state only if it is still REFUND_PENDING
            if (livePayment && livePayment.status === PaymentStatus.REFUND_PENDING) {
              await tx.payment.update({
                where: { id: paymentId, version: livePayment.version },
                data: {
                  status: payment.status, // revert to SUCCEEDED or PARTIALLY_REFUNDED
                  version: { increment: 1 },
                },
              });
            }
          });
        } catch (cleanupError: any) {
          this.logger.error(
            `Refund cleanup transaction failed for Payment ${paymentId}: ${cleanupError.message}`,
            cleanupError.stack
          );
        }
      }

      await this.idempotencyService.releaseLock(idempotencyKey, leaseToken);
      throw error;
    }
  }
}
