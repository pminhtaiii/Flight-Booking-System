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
import { RefundResolutionAction } from '@/payment/dto/resolve-refund.dto';
import { RefundResponse } from '@shared/types/payment.types';
import { enforceTransition } from '@/payment/payment-state-machine';
import { BookingStatus, PaymentStatus, PaymentEventSource, RefundStatus, RefundTriggerType, Prisma } from '@prisma/client';
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
    const triggerType =
      userRole === 'ADMIN'
        ? RefundTriggerType.ADMIN
        : RefundTriggerType.USER;

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

      if (idempotency.status === 'replay' && idempotency.responseCode >= 200 && idempotency.responseCode < 300) {
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
            triggerType,
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
        triggerType,
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

      if (stripeRefundIds.length === 0) {
        this.logger.error({
          message: `charge.refunded event has no refund IDs for payment ${payment.id}. Dropping event to avoid unfiltered match.`,
          paymentId: payment.id,
        });
        return;
      }

      // Phase 1: match REFUND_PENDING rows that already have a known stripeRefundId.
      const explicitMatches = await this.prisma.refund.findMany({
        where: {
          paymentId: payment.id,
          status: 'REFUND_PENDING',
          stripeRefundId: { in: stripeRefundIds },
        },
      });

      const matchedStripeIds = new Set(explicitMatches.map((r) => r.stripeRefundId));
      const unmatchedStripeIds = stripeRefundIds.filter((id) => !matchedStripeIds.has(id));

      // Phase 2: for any Stripe IDs that had no explicit match, attempt to atomically
      // bind one null-ID REFUND_PENDING row per unmatched ID. We update exactly one
      // row at a time (LIMIT 1 via sub-select) so two concurrent webhooks cannot both
      // claim the same null row.
      const lateBindMatches: Array<{ id: string; amount: number }> = [];
      for (const stripeId of unmatchedStripeIds) {
        const claimed = await this.prisma.$queryRaw<Array<{ id: string; amount: number }>>`
          UPDATE "refunds"
          SET    "stripeRefundId" = ${stripeId}
          WHERE  id = (
            SELECT id FROM "refunds"
            WHERE  "paymentId" = ${payment.id}
              AND  status = 'REFUND_PENDING'
              AND  "stripeRefundId" IS NULL
            ORDER BY "createdAt" ASC
            LIMIT  1
            FOR UPDATE SKIP LOCKED
          )
          RETURNING id, amount
        `;
        if (claimed.length > 0) {
          lateBindMatches.push(...claimed);
        } else {
          this.logger.warn({
            message: `Stripe refund ID ${stripeId} could not be bound to any REFUND_PENDING row for payment ${payment.id}`,
            paymentId: payment.id,
            stripeRefundId: stripeId,
          });
        }
      }

      const pendingRefunds = [...explicitMatches, ...lateBindMatches];

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
            amount: thisRefundAmount,
            source: PaymentEventSource.WEBHOOK,
            stripeEventId: event.id as string,
            createdBy: 'stripe_webhook',
            metadata: event as Prisma.InputJsonValue,
          },
        });
      });

      await this.auditService.createLog(this.prisma, {
        userId: null,
        action: 'refund_completed',
        resourceType: 'Refund',
        resourceId: pendingRefunds[0].id,
        metadata: {
          paymentId: payment.id,
          refundCount: pendingRefunds.length,
          totalAmount: thisRefundAmount,
          stripeEventId: event.id as string,
        },
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

      if (idempotency.status === 'replay' && idempotency.responseCode >= 200 && idempotency.responseCode < 300) {
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

  async processCancellationRefund(input: {
    bookingId: string;
    paymentId: string;
    amount: number;
    currency: string;
  }): Promise<{
    refundStatus: string;
    refundAmount: string;
    nextRetryAt?: string;
  }> {
    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      throw new BadRequestException('Cancellation refund amount must be a positive integer');
    }

    const payment = await this.prisma.payment.findUnique({
      where: { id: input.paymentId },
      include: { bookingIntent: { select: { userId: true } } },
    });
    if (!payment) {
      throw new NotFoundException('Payment not found');
    }

    const booking = await this.prisma.booking.findUnique({
      where: { id: input.bookingId },
      select: { id: true, paymentId: true, status: true },
    });
    if (!booking || booking.paymentId !== payment.id) {
      throw new NotFoundException('Cancellation booking not found for payment');
    }

    const refundAmount = this.toMajorCurrency(input.amount);
    if (booking.status === 'CANCELLED_AND_REFUNDED') {
      return { refundStatus: 'SUCCEEDED', refundAmount };
    }

    const idempotencyKey = `cancellation-refund:${input.bookingId}`;
    const refundReason = `cancellation:${input.bookingId}`;
    const requestHash = crypto
      .createHash('sha256')
      .update(`${input.paymentId}:${input.amount}:${input.currency}`)
      .digest('hex');
    const lock = await this.idempotencyService.acquireOrReplay(
      idempotencyKey,
      requestHash,
      payment.bookingIntent.userId,
      `/api/bookings/${input.bookingId}/cancel`,
    );
    if (lock.status === 'replay') {
      return JSON.parse(lock.responseBody) as { refundStatus: string; refundAmount: string; nextRetryAt?: string };
    }
    const idempotencyRecord = await this.prisma.idempotencyKey.findUnique({
      where: { key: idempotencyKey },
      select: { id: true },
    });
    if (!idempotencyRecord) {
      throw new InternalServerErrorException('Cancellation refund idempotency record not found');
    }

    let refund = await this.prisma.refund.findFirst({
      where: { idempotencyKeyId: idempotencyRecord.id },
    });
    if (refund?.status === 'SUCCEEDED') {
      return { refundStatus: 'SUCCEEDED', refundAmount };
    }

    if (!refund) {
      try {
        refund = await this.prisma.$transaction(async (tx) => {
          const paymentClaim = await tx.payment.updateMany({
            where: { id: input.paymentId, status: PaymentStatus.SUCCEEDED },
            data: { status: PaymentStatus.REFUND_PENDING },
          });
          if (paymentClaim.count === 1) {
            await tx.paymentEvent.create({
              data: {
                paymentId: input.paymentId,
                eventType: 'cancellation_refund_processing',
                previousStatus: PaymentStatus.SUCCEEDED,
                newStatus: PaymentStatus.REFUND_PENDING,
                amount: input.amount,
                source: PaymentEventSource.SYSTEM,
                createdBy: 'cancellation_service',
              },
            });
          }
          return tx.refund.create({
            data: {
              paymentId: input.paymentId,
              idempotencyKeyId: idempotencyRecord.id,
              amount: input.amount,
              currency: input.currency,
              reason: refundReason,
              triggerType: RefundTriggerType.SYSTEM_AUTOMATED,
              status: 'REFUND_PENDING',
              airlineRefundAmount: input.amount,
              customerRefundAmount: input.amount,
              bookingId: input.bookingId,
              retryCount: 0,
              idempotencyKeyCreatedAt: new Date(),
            },
          });
        });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
          throw error;
        }
        refund = await this.prisma.refund.findFirst({
          where: { idempotencyKeyId: idempotencyRecord.id },
        });
        if (!refund) {
          throw error;
        }
      }
    }

    let stripeRefund: { id: string } | null;
    try {
      stripeRefund = await this.createCancellationRefundWithRetries(
        payment.stripePaymentIntentId,
        input.amount,
        idempotencyKey,
      );
    } catch (error) {
      const failureFinalized = await this.finalizeCancellationRefundFailure(
        refund.id,
        input.paymentId,
        input.bookingId,
        input.amount,
      );
      if (!failureFinalized) {
        return { refundStatus: 'SUCCEEDED', refundAmount };
      }
      await this.idempotencyService.completeKey(idempotencyKey, HttpStatus.BAD_GATEWAY, {
        refundStatus: 'REFUND_FAILED_NEEDS_ATTENTION',
        refundAmount,
      });
      throw error;
    }
    if (!stripeRefund) {
      const nextRetryAt = new Date(Date.now() + 60_000);
      await this.prisma.refund.updateMany({
        where: { id: refund.id, status: RefundStatus.REFUND_PENDING },
        data: { status: RefundStatus.REFUND_RETRY_SCHEDULED, nextRetryAt },
      });
      const pending = {
        refundStatus: RefundStatus.REFUND_RETRY_SCHEDULED,
        refundAmount,
        nextRetryAt: nextRetryAt.toISOString(),
      };
      await this.idempotencyService.completeKey(idempotencyKey, HttpStatus.ACCEPTED, pending);
      return pending;
    }

    const finalized = await this.prisma.$transaction(async (tx) => {
      const refundClaim = await tx.refund.updateMany({
        where: { id: refund.id, status: RefundStatus.REFUND_PENDING },
        data: { status: 'SUCCEEDED', stripeRefundId: stripeRefund.id },
      });
      if (refundClaim.count === 0) {
        await tx.booking.updateMany({
          where: { id: input.bookingId, status: 'CANCELLED_PENDING_REFUND' },
          data: { status: 'CANCELLED_AND_REFUNDED' },
        });
        return false;
      }
      await tx.payment.update({
        where: { id: input.paymentId },
        data: { status: PaymentStatus.REFUNDED },
      });
      await tx.booking.update({
        where: { id: input.bookingId },
        data: { status: 'CANCELLED_AND_REFUNDED' },
      });
      const transactionId = crypto.randomUUID();
      await tx.ledgerEntry.createMany({
        data: [
          {
            paymentId: input.paymentId,
            transactionId,
            accountId: 'PLATFORM_REVENUE',
            entryType: 'DEBIT',
            amount: input.amount,
            currency: input.currency,
          },
          {
            paymentId: input.paymentId,
            transactionId,
            accountId: 'CUSTOMER_RECEIVABLE',
            entryType: 'CREDIT',
            amount: input.amount,
            currency: input.currency,
          },
        ],
      });
      await tx.paymentEvent.create({
        data: {
          paymentId: input.paymentId,
          eventType: 'cancellation_refund_succeeded',
          previousStatus: PaymentStatus.REFUND_PENDING,
          newStatus: PaymentStatus.REFUNDED,
          amount: input.amount,
          source: PaymentEventSource.SYSTEM,
          createdBy: 'cancellation_service',
        },
      });
      return true;
    });

    const response = { refundStatus: 'SUCCEEDED', refundAmount };
    await this.idempotencyService.completeKey(idempotencyKey, HttpStatus.OK, response);
    return finalized ? response : { refundStatus: 'SUCCEEDED', refundAmount };
  }

  /** Called only after the cron worker has CAS-claimed a due cancellation refund. */
  async recoverScheduledCancellationRefund(refundId: string): Promise<void> {
    const refund = await this.prisma.refund.findUnique({
      where: { id: refundId },
      include: {
        payment: { select: { id: true, stripePaymentIntentId: true } },
        idempotencyKey: { select: { key: true } },
      },
    });
    if (!refund || refund.status !== RefundStatus.REFUND_PROCESSING || !refund.bookingId) {
      return;
    }
    const cancellationRefund = { ...refund, bookingId: refund.bookingId };

    if (!cancellationRefund.idempotencyKeyCreatedAt || this.isIdempotencyKeyUnsafe(cancellationRefund.idempotencyKeyCreatedAt)) {
      await this.escalateScheduledCancellationRefund(cancellationRefund, 'IDEMPOTENCY_KEY_SAFETY_WINDOW');
      return;
    }

    try {
      const stripeRefund = await this.stripeService.createRefund(
        cancellationRefund.payment.stripePaymentIntentId,
        cancellationRefund.amount,
        'requested_by_customer',
        cancellationRefund.idempotencyKey.key,
      );
      await this.finalizeScheduledCancellationRefundSuccess(cancellationRefund, stripeRefund.id);
    } catch (error: unknown) {
      const errorCode = this.toSafeStripeErrorCode(error);
      if (!this.isTransientStripeError(error) || cancellationRefund.retryCount >= 3) {
        await this.escalateScheduledCancellationRefund(cancellationRefund, errorCode);
        return;
      }

      const delay = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000][cancellationRefund.retryCount];
      await this.prisma.refund.updateMany({
        where: { id: cancellationRefund.id, status: RefundStatus.REFUND_PROCESSING },
        data: {
          status: RefundStatus.REFUND_RETRY_SCHEDULED,
          retryCount: { increment: 1 },
          nextRetryAt: new Date(Date.now() + delay),
          lastErrorCode: errorCode,
          lastErrorAt: new Date(),
        },
      });
    }
  }

  async resolveEscalatedCancellationRefund(
    refundId: string,
    action: RefundResolutionAction,
  ): Promise<{ refundId: string; refundStatus: string; bookingStatus: string }> {
    const refund = await this.prisma.refund.findUnique({
      where: { id: refundId },
      select: { id: true, bookingId: true, paymentId: true, status: true, amount: true, currency: true },
    });
    if (!refund?.bookingId) {
      throw new NotFoundException('Escalated cancellation refund not found');
    }
    const bookingId = refund.bookingId;

    const result = await this.prisma.$transaction(async (tx) => {
      if (action === 'RETRY_WITH_FRESH_KEY') {
        const key = await tx.idempotencyKey.create({
          data: {
            key: `cancellation-refund:${bookingId}:${crypto.randomUUID()}`,
            requestHash: crypto.randomUUID(),
            customerId: (await tx.booking.findUniqueOrThrow({
              where: { id: bookingId },
              select: { userId: true },
            })).userId,
            requestPath: `/api/admin/refunds/${refund.id}/resolve`,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          },
        });
        const claim = await tx.refund.updateMany({
          where: { id: refund.id, status: RefundStatus.REFUND_FAILED_NEEDS_ATTENTION },
          data: {
            idempotencyKeyId: key.id,
            idempotencyKeyCreatedAt: new Date(),
            status: RefundStatus.REFUND_RETRY_SCHEDULED,
            retryCount: 0,
            nextRetryAt: new Date(),
            lastErrorCode: null,
            lastErrorAt: null,
          },
        });
        if (claim.count !== 1) {
          throw new ConflictException('Refund is not awaiting manual resolution');
        }
        await tx.booking.update({
          where: { id: bookingId },
          data: { status: BookingStatus.CANCELLED_PENDING_REFUND },
        });
        return { refundStatus: RefundStatus.REFUND_RETRY_SCHEDULED, bookingStatus: BookingStatus.CANCELLED_PENDING_REFUND };
      }

      const claim = await tx.refund.updateMany({
        where: { id: refund.id, status: RefundStatus.REFUND_FAILED_NEEDS_ATTENTION },
        data: { status: RefundStatus.SUCCEEDED, nextRetryAt: null },
      });
      if (claim.count !== 1) {
        throw new ConflictException('Refund is not awaiting manual resolution');
      }
      await tx.payment.update({
        where: { id: refund.paymentId },
        data: { status: PaymentStatus.REFUNDED },
      });
      await tx.booking.update({
        where: { id: bookingId },
        data: { status: BookingStatus.CANCELLED_AND_REFUNDED },
      });
      const transactionId = crypto.randomUUID();
      await tx.ledgerEntry.createMany({
        data: [
          {
            paymentId: refund.paymentId,
            transactionId,
            accountId: 'PLATFORM_REVENUE',
            entryType: 'DEBIT',
            amount: refund.amount,
            currency: refund.currency,
          },
          {
            paymentId: refund.paymentId,
            transactionId,
            accountId: 'CUSTOMER_RECEIVABLE',
            entryType: 'CREDIT',
            amount: refund.amount,
            currency: refund.currency,
          },
        ],
      });
      await tx.paymentEvent.create({
        data: {
          paymentId: refund.paymentId,
          eventType: 'cancellation_refund_manually_resolved',
          previousStatus: PaymentStatus.SUCCEEDED,
          newStatus: PaymentStatus.REFUNDED,
          amount: refund.amount,
          source: PaymentEventSource.API,
          createdBy: 'admin_refund_resolution',
        },
      });
      return { refundStatus: RefundStatus.SUCCEEDED, bookingStatus: BookingStatus.CANCELLED_AND_REFUNDED };
    });

    await this.auditService.createLog(null, {
      action: 'CANCELLATION_REFUND_MANUALLY_RESOLVED',
      resourceType: 'Refund',
      resourceId: refund.id,
      metadata: { action },
    });
    return { refundId: refund.id, ...result };
  }

  private async finalizeScheduledCancellationRefundSuccess(
    refund: { id: string; paymentId: string; bookingId: string; amount: number; currency: string },
    stripeRefundId: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const claim = await tx.refund.updateMany({
        where: { id: refund.id, status: RefundStatus.REFUND_PROCESSING },
        data: { status: RefundStatus.SUCCEEDED, stripeRefundId, nextRetryAt: null },
      });
      if (claim.count !== 1) return;
      await tx.payment.updateMany({
        where: { id: refund.paymentId, status: PaymentStatus.REFUND_PENDING },
        data: { status: PaymentStatus.REFUNDED },
      });
      await tx.booking.updateMany({
        where: { id: refund.bookingId, status: BookingStatus.CANCELLED_PENDING_REFUND },
        data: { status: BookingStatus.CANCELLED_AND_REFUNDED },
      });
      const transactionId = crypto.randomUUID();
      await tx.ledgerEntry.createMany({
        data: [
          {
            paymentId: refund.paymentId,
            transactionId,
            accountId: 'PLATFORM_REVENUE',
            entryType: 'DEBIT',
            amount: refund.amount,
            currency: refund.currency,
          },
          {
            paymentId: refund.paymentId,
            transactionId,
            accountId: 'CUSTOMER_RECEIVABLE',
            entryType: 'CREDIT',
            amount: refund.amount,
            currency: refund.currency,
          },
        ],
      });
      await tx.paymentEvent.create({
        data: {
          paymentId: refund.paymentId,
          eventType: 'cancellation_refund_recovered',
          previousStatus: PaymentStatus.REFUND_PENDING,
          newStatus: PaymentStatus.REFUNDED,
          amount: refund.amount,
          source: PaymentEventSource.CRON,
          createdBy: 'refund_recovery_worker',
        },
      });
    });
  }

  private async escalateScheduledCancellationRefund(
    refund: { id: string; paymentId: string; bookingId: string; amount: number },
    errorCode: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const claim = await tx.refund.updateMany({
        where: { id: refund.id, status: RefundStatus.REFUND_PROCESSING },
        data: {
          status: RefundStatus.REFUND_FAILED_NEEDS_ATTENTION,
          nextRetryAt: null,
          lastErrorCode: errorCode,
          lastErrorAt: new Date(),
        },
      });
      if (claim.count !== 1) return;
      await tx.payment.updateMany({
        where: { id: refund.paymentId, status: PaymentStatus.REFUND_PENDING },
        data: { status: PaymentStatus.SUCCEEDED },
      });
      await tx.booking.updateMany({
        where: { id: refund.bookingId, status: BookingStatus.CANCELLED_PENDING_REFUND },
        data: { status: BookingStatus.REFUND_FAILED_NEEDS_ATTENTION },
      });
      await tx.paymentEvent.create({
        data: {
          paymentId: refund.paymentId,
          eventType: 'cancellation_refund_escalated',
          previousStatus: PaymentStatus.REFUND_PENDING,
          newStatus: PaymentStatus.SUCCEEDED,
          amount: refund.amount,
          source: PaymentEventSource.CRON,
          createdBy: 'refund_recovery_worker',
          metadata: { errorCode },
        },
      });
    });
    this.logger.error(`Cancellation refund ${refund.id} requires manual attention: ${errorCode}`);
  }

  private isIdempotencyKeyUnsafe(createdAt: Date): boolean {
    return Date.now() - createdAt.getTime() >= 22 * 60 * 60 * 1000;
  }

  private toSafeStripeErrorCode(error: unknown): string {
    if (typeof error !== 'object' || error === null) return 'STRIPE_UNKNOWN_ERROR';
    const candidate = error as { statusCode?: unknown; code?: unknown };
    if (typeof candidate.code === 'string' && /^[A-Z0-9_:-]{1,80}$/.test(candidate.code)) return candidate.code;
    if (typeof candidate.statusCode === 'number') return `HTTP_${candidate.statusCode}`;
    return 'STRIPE_UNKNOWN_ERROR';
  }

  private async finalizeCancellationRefundFailure(
    refundId: string,
    paymentId: string,
    bookingId: string,
    amount: number,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const refundClaim = await tx.refund.updateMany({
        where: { id: refundId, status: RefundStatus.REFUND_PENDING },
        data: { status: 'REFUND_FAILED_NEEDS_ATTENTION' },
      });
      if (refundClaim.count === 0) {
        return false;
      }
      await tx.payment.updateMany({
        where: { id: paymentId, status: PaymentStatus.REFUND_PENDING },
        data: { status: PaymentStatus.SUCCEEDED },
      });
      await tx.booking.updateMany({
        where: { id: bookingId, status: BookingStatus.CANCELLED_PENDING_REFUND },
        data: { status: BookingStatus.REFUND_FAILED_NEEDS_ATTENTION },
      });
      await tx.paymentEvent.create({
        data: {
          paymentId,
          eventType: 'cancellation_refund_failed',
          previousStatus: PaymentStatus.REFUND_PENDING,
          newStatus: PaymentStatus.SUCCEEDED,
          amount,
          source: PaymentEventSource.SYSTEM,
          createdBy: 'cancellation_service',
        },
      });
      return true;
    });
  }

  private async createCancellationRefundWithRetries(
    paymentIntentId: string,
    amount: number,
    idempotencyKey: string,
  ): Promise<{ id: string } | null> {
    const retryDelays = [1_000, 3_000, 5_000];
    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      try {
        const refund = await this.stripeService.createRefund(
          paymentIntentId,
          amount,
          'requested_by_customer',
          idempotencyKey,
        );
        return { id: refund.id };
      } catch (error) {
        if (!this.isTransientStripeError(error)) {
          throw error;
        }
        if (attempt < retryDelays.length) {
          await this.delay(retryDelays[attempt]);
        }
      }
    }
    return null;
  }

  private isTransientStripeError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) {
      return false;
    }
    const candidate = error as { statusCode?: unknown; code?: unknown; message?: unknown };
    const statusCode = candidate.statusCode;
    if (typeof statusCode === 'number' && (statusCode === 429 || statusCode >= 500)) {
      return true;
    }
    const code = typeof candidate.code === 'string' ? candidate.code : '';
    const message = typeof candidate.message === 'string' ? candidate.message : '';
    return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|timeout|connection/i.test(`${code} ${message}`);
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  private toMajorCurrency(amount: number): string {
    return (amount / 100).toFixed(2);
  }
}
