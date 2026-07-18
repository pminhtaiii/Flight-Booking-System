import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  InternalServerErrorException,
  HttpStatus,
} from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { StripeService } from '@/common/stripe.service';
import { PaymentIdempotencyService } from '@/payment/payment-idempotency.service';
import { AuditService } from '@/audit/audit.service';
import { RefundPaymentDto } from '@/payment/dto/refund-payment.dto';
import { RefundResponse } from '@shared/types/payment.types';
import { enforceTransition } from '@/payment/payment-state-machine';
import { PaymentStatus, PaymentEventSource, RefundTriggerType, Prisma } from '@prisma/client';
import * as crypto from 'crypto';

@Injectable()
export class PaymentRefundService {
  private readonly logger = new Logger(PaymentRefundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
    private readonly idempotencyService: PaymentIdempotencyService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Initiates a refund for a given payment (admin/user-triggered).
   */
  async initiateRefund(
    paymentId: string,
    dto: RefundPaymentDto,
    idempotencyKey: string,
    userId: string,
    userRole: string,
  ): Promise<RefundResponse> {
    try {
      // 1. Find Payment with bookingIntent
      const payment = await this.prisma.payment.findUnique({
        where: { id: paymentId },
        include: { bookingIntent: true },
      });

      if (!payment) {
        throw new NotFoundException('Payment not found');
      }

      // 2. Validate user owns the payment (admins bypass ownership check)
      if (userRole !== 'ADMIN' && payment.bookingIntent.userId !== userId) {
        throw new ForbiddenException('You do not own this payment');
      }

      // 3. Validate payment status allows refund
      const previousStatus = payment.status as PaymentStatus;
      enforceTransition(previousStatus, PaymentStatus.REFUND_PENDING);

      // 4. Calculate total already refunded
      const succeededRefunds = await this.prisma.refund.findMany({
        where: {
          paymentId,
          status: 'SUCCEEDED',
        },
        select: { amount: true },
      });

      const totalRefunded = succeededRefunds.reduce(
        (sum: number, r: { amount: number }) => sum + r.amount,
        0,
      );

      if (dto.amount > payment.amount - totalRefunded) {
        throw new BadRequestException(
          `Refund amount (${dto.amount}) exceeds remaining refundable amount (${payment.amount - totalRefunded})`,
        );
      }

      // 5. Create idempotency key record for the refund
      const refundIdempotencyKey = `refund:${paymentId}:${idempotencyKey}`;
      const requestHash = this.idempotencyService.computeHash(dto);

      const idempotency = await this.idempotencyService.acquireOrReplay(
        refundIdempotencyKey,
        requestHash,
        userId,
        '/api/bookings/payment/refund',
      );

      if (idempotency.status === 'replay') {
        return JSON.parse(idempotency.responseBody) as RefundResponse;
      }

      // 6. Create Refund record and transition Payment status BEFORE calling Stripe.
      //    This ensures we have a traceable record before any money moves.
      //    Optimistic lock on payment.version prevents concurrent double-refunds.
      let refund: Awaited<ReturnType<typeof this.prisma.refund.create>>;
      try {
      refund = await this.prisma.$transaction(async (tx) => {
        const idempotencyKeyRecord = await tx.idempotencyKey.findUnique({
          where: { key: refundIdempotencyKey },
          select: { id: true },
        });

        if (!idempotencyKeyRecord) {
          throw new InternalServerErrorException('Idempotency key record not found');
        }

        const createdRefund = await tx.refund.create({
          data: {
            paymentId,
            idempotencyKeyId: idempotencyKeyRecord.id,
            stripeRefundId: null,
            amount: dto.amount,
            currency: payment.currency,
            reason: dto.reason,
            triggerType: RefundTriggerType.ADMIN,
            triggeredByUserId: userId,
            status: 'REFUND_PENDING',
          },
        });

        // Transition Payment to REFUND_PENDING
        await tx.payment.update({
          where: { id: paymentId, version: payment.version },
          data: {
            status: PaymentStatus.REFUND_PENDING,
            version: { increment: 1 },
          },
        });

        // Append PaymentEvent
        await tx.paymentEvent.create({
          data: {
            paymentId,
            eventType: 'refund_initiated',
            previousStatus,
            newStatus: PaymentStatus.REFUND_PENDING,
            amount: dto.amount,
            source: PaymentEventSource.API,
            createdBy: userId,
          },
        });

        return createdRefund;
      });
      } catch (txError) {
        if (txError instanceof Prisma.PrismaClientKnownRequestError && txError.code === 'P2025') {
          throw new ConflictException(
            'Payment status changed concurrently. Please retry.',
          );
        }
        throw txError;
      }

      // 7. Call Stripe to create refund (after DB record exists)
      let stripeRefund;
      try {
        stripeRefund = await this.stripeService.createRefund(
          payment.stripePaymentIntentId,
          dto.amount,
          dto.reason,
          `${idempotencyKey}-stripe-refund`,
        );
      } catch (stripeError) {
        // Stripe call failed — mark Refund as FAILED and revert Payment to previousStatus
        await this.prisma.$transaction(async (tx) => {
          await tx.refund.update({
            where: { id: refund.id },
            data: { status: 'FAILED' },
          });
          await tx.payment.update({
            where: { id: paymentId },
            data: { status: previousStatus },
          });
          await tx.paymentEvent.create({
            data: {
              paymentId,
              eventType: 'refund_failed',
              previousStatus: PaymentStatus.REFUND_PENDING,
              newStatus: previousStatus,
              amount: dto.amount,
              source: PaymentEventSource.API,
              createdBy: userId,
            },
          });
        });
        this.logger.error(
          `Stripe refund failed for payment ${paymentId}, Refund ${refund.id} marked FAILED, Payment reverted to ${previousStatus}`,
          stripeError instanceof Error ? stripeError.stack : undefined,
        );
        await this.idempotencyService.completeKey(refundIdempotencyKey, 500, {
          error: stripeError instanceof Error ? stripeError.message : String(stripeError),
        });
        throw stripeError;
      }

      // 8. Update Refund with Stripe refund ID
      refund = await this.prisma.refund.update({
        where: { id: refund.id },
        data: { stripeRefundId: stripeRefund.id },
      });

      // 10. Audit log
      await this.auditService.createLog(this.prisma, {
        userId,
        action: 'refund_initiated',
        resourceType: 'Refund',
        resourceId: refund.id,
        metadata: {
          paymentId,
          amount: dto.amount,
          reason: dto.reason,
        },
      });

      // 11. Complete idempotency key
      const responseBody: RefundResponse = {
        refundId: refund.id,
        paymentId,
        amount: dto.amount,
        currency: payment.currency,
        status: refund.status,
        triggerType: RefundTriggerType.ADMIN,
      };

      await this.idempotencyService.completeKey(
        refundIdempotencyKey,
        HttpStatus.CREATED,
        responseBody,
      );

      return responseBody;
    } catch (error) {
      this.logger.error(
        `Error in initiateRefund: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  /**
   * Handles charge.refunded webhook event from Stripe.
   */
  async handleChargeRefunded(event: Record<string, unknown>): Promise<void> {
    try {
      const data = event.data as Record<string, unknown>;
      const charge = data.object as Record<string, unknown>;
      const paymentIntentId = charge.payment_intent as string;

      if (!paymentIntentId) {
        this.logger.warn('charge.refunded event missing payment_intent, skipping');
        return;
      }

      // Find the Payment by stripePaymentIntentId
      const payment = await this.prisma.payment.findUnique({
        where: { stripePaymentIntentId: paymentIntentId },
      });

      if (!payment) {
        this.logger.error({
          message: `Payment not found for stripePaymentIntentId: ${paymentIntentId}`,
          eventType: 'charge.refunded',
        });
        return;
      }

      // Match specific Stripe refunds from the event to our REFUND_PENDING records
      const stripeRefunds = (charge.refunds as Record<string, unknown>)?.data as Array<Record<string, unknown>> | undefined;
      const stripeRefundIds = stripeRefunds?.map((r) => r.id as string) ?? [];

      // Find REFUND_PENDING refunds whose stripeRefundId matches one in this event
      const pendingRefunds = await this.prisma.refund.findMany({
        where: {
          paymentId: payment.id,
          status: 'REFUND_PENDING',
          stripeRefundId: stripeRefundIds.length > 0 ? { in: stripeRefundIds } : undefined,
        },
      });

      if (pendingRefunds.length === 0) {
        this.logger.warn({
          message: `No matching REFUND_PENDING refunds found for payment ${payment.id} and Stripe refund IDs ${stripeRefundIds.join(', ')}`,
          paymentId: payment.id,
          stripeRefundIds,
        });
        return;
      }

      // Calculate the refund amount from matched refunds only
      const chargeAmountRefunded = (charge.amount_refunded as number) || 0;
      const thisRefundAmount = pendingRefunds.reduce(
        (sum: number, r: { amount: number }) => sum + r.amount,
        0,
      );

      await this.prisma.$transaction(async (tx) => {
        // Update only the matched pending refunds to SUCCEEDED
        await tx.refund.updateMany({
          where: {
            id: { in: pendingRefunds.map((r) => r.id) },
            status: 'REFUND_PENDING',
          },
          data: { status: 'SUCCEEDED' },
        });

        // Calculate total refunded across all successful refunds
        const allSucceededRefunds = await tx.refund.findMany({
          where: {
            paymentId: payment.id,
            status: 'SUCCEEDED',
          },
          select: { amount: true },
        });

        const totalRefunded = allSucceededRefunds.reduce(
          (sum: number, r: { amount: number }) => sum + r.amount,
          0,
        );

        // Determine new payment status
        const newStatus: PaymentStatus =
          totalRefunded >= payment.amount
            ? PaymentStatus.REFUNDED
            : PaymentStatus.PARTIALLY_REFUNDED;

        const previousStatus = payment.status as PaymentStatus;

        // Walk through FSM transitions explicitly so every DB write is a sanctioned edge.
        if (previousStatus === PaymentStatus.REFUND_PENDING) {
          enforceTransition(previousStatus, newStatus);
          await tx.payment.update({
            where: { id: payment.id },
            data: { status: newStatus },
          });
        } else if (previousStatus === PaymentStatus.PARTIALLY_REFUNDED) {
          // PARTIALLY_REFUNDED → REFUND_PENDING → final status
          enforceTransition(previousStatus, PaymentStatus.REFUND_PENDING);
          await tx.payment.update({
            where: { id: payment.id },
            data: { status: PaymentStatus.REFUND_PENDING },
          });
          enforceTransition(PaymentStatus.REFUND_PENDING, newStatus);
          await tx.payment.update({
            where: { id: payment.id },
            data: { status: newStatus },
          });
        } else {
          // Should never happen: initiateRefund always moves payment to REFUND_PENDING first.
          // Throw to roll back the transaction so we don't commit partial state.
          throw new Error(
            `handleChargeRefunded called with unexpected previousStatus: ${previousStatus}`,
          );
        }

        // Create reversing ledger entries: DEBIT PLATFORM_REVENUE, CREDIT CUSTOMER_RECEIVABLE
        const transactionId = crypto.randomUUID();
        await tx.ledgerEntry.createMany({
          data: [
            {
              paymentId: payment.id,
              transactionId,
              accountId: 'PLATFORM_REVENUE',
              entryType: 'DEBIT',
              amount: thisRefundAmount,
              currency: payment.currency,
            },
            {
              paymentId: payment.id,
              transactionId,
              accountId: 'CUSTOMER_RECEIVABLE',
              entryType: 'CREDIT',
              amount: thisRefundAmount,
              currency: payment.currency,
            },
          ],
        });

        // Append PaymentEvent
        await tx.paymentEvent.create({
          data: {
            paymentId: payment.id,
            eventType: 'charge.refunded',
            previousStatus,
            newStatus,
            amount: chargeAmountRefunded,
            source: PaymentEventSource.WEBHOOK,
            stripeEventId: event.id as string,
            createdBy: 'stripe_webhook',
            metadata: event as Prisma.InputJsonValue,
          },
        });
      });

      this.logger.log({
        message: `charge.refunded processed for payment ${payment.id}`,
        paymentId: payment.id,
        pendingRefundsCount: pendingRefunds.length,
        chargeAmountRefunded,
      });
    } catch (error) {
      this.logger.error(
        `Error in handleChargeRefunded: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  /**
   * Triggers an automated/system-initiated refund (e.g., for failed Duffel bookings).
   */
  async triggerAutomatedRefund(
    paymentId: string,
    reason: string,
  ): Promise<RefundResponse> {
    try {
      const idempotencyKey = `refund:${paymentId}:${reason}:1`;

      // Check if refund already exists (idempotency guard)
      const existingKey = await this.prisma.idempotencyKey.findUnique({
        where: { key: idempotencyKey },
      });

      if (existingKey?.responseBody && existingKey.responseCode && existingKey.responseCode >= 200 && existingKey.responseCode < 300) {
        return JSON.parse(
          typeof existingKey.responseBody === 'string'
            ? existingKey.responseBody
            : JSON.stringify(existingKey.responseBody),
        ) as RefundResponse;
      }

      // Find the payment
      const payment = await this.prisma.payment.findUnique({
        where: { id: paymentId },
        include: { bookingIntent: true },
      });

      if (!payment) {
        throw new NotFoundException('Payment not found');
      }

      // Validate payment status allows refund
      const previousStatus = payment.status as PaymentStatus;
      enforceTransition(previousStatus, PaymentStatus.REFUND_PENDING);

      // Calculate total already refunded
      const succeededRefunds = await this.prisma.refund.findMany({
        where: { paymentId, status: 'SUCCEEDED' },
        select: { amount: true },
      });

      const totalRefunded = succeededRefunds.reduce(
        (sum: number, r: { amount: number }) => sum + r.amount,
        0,
      );

      const refundableAmount = payment.amount - totalRefunded;
      if (refundableAmount <= 0) {
        throw new BadRequestException('No refundable amount remaining');
      }

      // Acquire idempotency key
      const requestHash = this.idempotencyService.computeHash({ reason });
      const idempotency = await this.idempotencyService.acquireOrReplay(
        idempotencyKey,
        requestHash,
        'system',
        '/api/bookings/payment/refund',
      );

      if (idempotency.status === 'replay') {
        return JSON.parse(idempotency.responseBody) as RefundResponse;
      }

      // Create Refund record and transition Payment status BEFORE calling Stripe
      //    Optimistic lock on payment.version prevents concurrent double-refunds.
      let refund: Awaited<ReturnType<typeof this.prisma.refund.create>>;
      try {
      refund = await this.prisma.$transaction(async (tx) => {
        const idempotencyKeyRecord = await tx.idempotencyKey.findUnique({
          where: { key: idempotencyKey },
          select: { id: true },
        });

        if (!idempotencyKeyRecord) {
          throw new InternalServerErrorException('Idempotency key record not found');
        }

        const createdRefund = await tx.refund.create({
          data: {
            paymentId,
            idempotencyKeyId: idempotencyKeyRecord.id,
            stripeRefundId: null,
            amount: refundableAmount,
            currency: payment.currency,
            reason,
            triggerType: RefundTriggerType.SYSTEM_AUTOMATED,
            triggeredByUserId: null,
            requiresReview: true,
            status: 'REFUND_PENDING',
          },
        });

        await tx.payment.update({
          where: { id: paymentId, version: payment.version },
          data: {
            status: PaymentStatus.REFUND_PENDING,
            version: { increment: 1 },
          },
        });

        await tx.paymentEvent.create({
          data: {
            paymentId,
            eventType: 'refund_initiated',
            previousStatus,
            newStatus: PaymentStatus.REFUND_PENDING,
            amount: refundableAmount,
            source: PaymentEventSource.SYSTEM,
            createdBy: 'system',
          },
        });

        return createdRefund;
      });
      } catch (txError) {
        if (txError instanceof Prisma.PrismaClientKnownRequestError && txError.code === 'P2025') {
          throw new ConflictException(
            'Payment status changed concurrently. Please retry.',
          );
        }
        throw txError;
      }

      // Call Stripe to create refund (after DB record exists)
      let stripeRefund;
      try {
        stripeRefund = await this.stripeService.createRefund(
          payment.stripePaymentIntentId,
          refundableAmount,
          reason,
          `${idempotencyKey}-stripe-refund`,
        );
      } catch (stripeError) {
        // Stripe call failed — mark Refund as FAILED and revert Payment to previousStatus
        await this.prisma.$transaction(async (tx) => {
          await tx.refund.update({
            where: { id: refund.id },
            data: { status: 'FAILED' },
          });
          await tx.payment.update({
            where: { id: paymentId },
            data: { status: previousStatus },
          });
          await tx.paymentEvent.create({
            data: {
              paymentId,
              eventType: 'refund_failed',
              previousStatus: PaymentStatus.REFUND_PENDING,
              newStatus: previousStatus,
              amount: refundableAmount,
              source: PaymentEventSource.SYSTEM,
              createdBy: 'system',
            },
          });
        });
        this.logger.error(
          `Stripe refund failed for automated refund on payment ${paymentId}, Refund ${refund.id} marked FAILED, Payment reverted to ${previousStatus}`,
          stripeError instanceof Error ? stripeError.stack : undefined,
        );
        await this.idempotencyService.completeKey(idempotencyKey, 500, {
          error: stripeError instanceof Error ? stripeError.message : String(stripeError),
        });
        throw stripeError;
      }

      // Update Refund with Stripe refund ID
      refund = await this.prisma.refund.update({
        where: { id: refund.id },
        data: { stripeRefundId: stripeRefund.id },
      });

      // Audit log
      await this.auditService.createLog(this.prisma, {
        userId: null,
        action: 'refund_initiated',
        resourceType: 'Refund',
        resourceId: refund.id,
        metadata: {
          paymentId,
          amount: refundableAmount,
          reason,
          triggerType: 'SYSTEM_AUTOMATED',
        },
      });

      const responseBody: RefundResponse = {
        refundId: refund.id,
        paymentId,
        amount: refundableAmount,
        currency: payment.currency,
        status: refund.status,
        triggerType: RefundTriggerType.SYSTEM_AUTOMATED,
      };

      await this.idempotencyService.completeKey(
        idempotencyKey,
        HttpStatus.CREATED,
        responseBody,
      );

      return responseBody;
    } catch (error) {
      this.logger.error(
        `Error in triggerAutomatedRefund: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }
}
