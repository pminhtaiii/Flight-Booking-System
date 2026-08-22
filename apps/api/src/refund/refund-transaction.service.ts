import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  PaymentStatus,
  Refund,
  RefundStatus,
  RefundTriggerType,
} from '@prisma/client';
import * as crypto from 'crypto';
import { PrismaService } from '@/prisma/prisma.service';

export type ReserveRefundTransactionInput = {
  paymentId: string;
  cancellationRefundObligationId?: string;
  amount: number;
  currency: string;
  reason: string;
  triggerType: RefundTriggerType;
  actorId?: string;
  idempotencyKey: string;
};

const ACTIVE_REFUND_STATUSES: readonly RefundStatus[] = [
  RefundStatus.REFUND_PENDING,
  RefundStatus.REFUND_PROCESSING,
  RefundStatus.REFUND_RETRY_SCHEDULED,
] as const;

@Injectable()
export class RefundTransactionService {
  private readonly logger = new Logger(RefundTransactionService.name);

  constructor(private readonly prisma: PrismaService) {}

  private computeRequestHash(input: ReserveRefundTransactionInput): string {
    return crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          paymentId: input.paymentId,
          obligationId: input.cancellationRefundObligationId,
          amount: input.amount,
          currency: input.currency,
          reason: input.reason,
        }),
      )
      .digest('hex');
  }

  async reserveTransaction(input: ReserveRefundTransactionInput): Promise<Refund> {
    if (!input.amount || !Number.isInteger(input.amount) || input.amount <= 0) {
      throw new BadRequestException('Refund amount must be a positive integer in minor units');
    }

    return await this.prisma.$transaction(async (tx) => {
      const payments = await tx.$queryRaw<
        Array<{
          id: string;
          amount: number;
          currency: string;
          status: PaymentStatus;
          version: number;
        }>
      >`
        SELECT id, amount, currency, status, version
        FROM payments
        WHERE id = ${input.paymentId}
        FOR UPDATE
      `;

      if (!payments || payments.length === 0) {
        throw new NotFoundException(`Payment ${input.paymentId} not found`);
      }
      const payment = payments[0];

      let obligation: {
        id: string;
        paymentId: string;
        totalAmount: number;
        currency: string;
      } | null = null;

      if (input.cancellationRefundObligationId) {
        const obligations = await tx.$queryRaw<
          Array<{
            id: string;
            paymentId: string;
            totalAmount: number;
            currency: string;
          }>
        >`
          SELECT id, "paymentId", "totalAmount", currency
          FROM cancellation_refund_obligations
          WHERE id = ${input.cancellationRefundObligationId}
          FOR UPDATE
        `;

        if (!obligations || obligations.length === 0) {
          throw new NotFoundException(
            `CancellationRefundObligation ${input.cancellationRefundObligationId} not found`,
          );
        }
        obligation = obligations[0];

        if (obligation.paymentId !== payment.id) {
          throw new BadRequestException('Obligation does not belong to the specified payment');
        }
        if (obligation.currency.toUpperCase() !== input.currency.toUpperCase()) {
          throw new BadRequestException('Currency mismatch with obligation');
        }
      }

      if (payment.currency.toUpperCase() !== input.currency.toUpperCase()) {
        throw new BadRequestException('Currency mismatch with payment');
      }

      const requestHash = this.computeRequestHash(input);

      const existingKeyRecord = await tx.idempotencyKey.findUnique({
        where: { key: input.idempotencyKey },
      });

      if (existingKeyRecord) {
        if (existingKeyRecord.requestHash !== requestHash) {
          throw new BadRequestException('Idempotency key reuse with different payload');
        }

        const existingRefund = await tx.refund.findUnique({
          where: { idempotencyKeyId: existingKeyRecord.id },
        });

        if (existingRefund) {
          return existingRefund;
        }
      }

      const paymentRefunds = await tx.refund.findMany({
        where: { paymentId: payment.id },
      });
      const successfulPaymentRefunds = paymentRefunds
        .filter((r) => r.status === RefundStatus.SUCCEEDED)
        .reduce((sum, r) => sum + r.amount, 0);
      const activePaymentReservations = paymentRefunds
        .filter((r) => ACTIVE_REFUND_STATUSES.includes(r.status))
        .reduce((sum, r) => sum + r.amount, 0);
      const remainingPaymentCapacity =
        payment.amount - successfulPaymentRefunds - activePaymentReservations;

      if (input.amount > remainingPaymentCapacity) {
        throw new BadRequestException(
          `Requested refund amount (${input.amount}) exceeds remaining payment capacity (${remainingPaymentCapacity})`,
        );
      }

      if (obligation) {
        const obligationRefunds = await tx.refund.findMany({
          where: { cancellationRefundObligationId: obligation.id },
        });
        const successfulObligationRefunds = obligationRefunds
          .filter((r) => r.status === RefundStatus.SUCCEEDED)
          .reduce((sum, r) => sum + r.amount, 0);
        const activeObligationReservations = obligationRefunds
          .filter((r) => ACTIVE_REFUND_STATUSES.includes(r.status))
          .reduce((sum, r) => sum + r.amount, 0);
        const remainingObligationCapacity =
          obligation.totalAmount -
          successfulObligationRefunds -
          activeObligationReservations;

        if (input.amount > remainingObligationCapacity) {
          throw new BadRequestException(
            `Requested refund amount (${input.amount}) exceeds remaining obligation capacity (${remainingObligationCapacity})`,
          );
        }
      }

      let idempotencyKeyRecord = existingKeyRecord;
      if (!idempotencyKeyRecord) {
        let customerId = input.actorId;
        if (!customerId) {
          const p = await tx.payment.findUnique({
            where: { id: payment.id },
            include: { bookingIntent: true },
          });
          customerId = p?.bookingIntent?.userId || p?.stripeCustomerId || 'system';
        }

        idempotencyKeyRecord = await tx.idempotencyKey.create({
          data: {
            key: input.idempotencyKey,
            requestHash,
            customerId,
            requestPath: '/api/refund/reserve',
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          },
        });
      }

      const createdRefund = await tx.refund.create({
        data: {
          paymentId: input.paymentId,
          cancellationRefundObligationId: input.cancellationRefundObligationId ?? null,
          idempotencyKeyId: idempotencyKeyRecord.id,
          amount: input.amount,
          currency: input.currency.toUpperCase(),
          reason: input.reason,
          triggerType: input.triggerType,
          triggeredByUserId: input.actorId ?? null,
          status: RefundStatus.REFUND_PENDING,
        },
      });

      this.logger.log({
        message: 'Refund transaction reserved',
        refundId: createdRefund.id,
        paymentId: input.paymentId,
        amount: input.amount,
        currency: input.currency,
      });

      return createdRefund;
    });
  }
}
