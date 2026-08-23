import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  PaymentEventSource,
  PaymentStatus,
  Refund,
  RefundStatus,
  RefundTriggerType,
} from '@prisma/client';
import * as crypto from 'crypto';
import { PrismaService } from '@/prisma/prisma.service';

type RefundReservationBase = {
  paymentId: string;
  amount: number;
  currency: string;
  triggerType: RefundTriggerType;
  actorId?: string;
  idempotencyKey: string;
};

export type DirectRefundReservationInput = RefundReservationBase & {
  kind: 'DIRECT';
  reason: string;
};

export type CancellationRefundReservationInput = RefundReservationBase & {
  kind: 'CANCELLATION';
  cancellationRefundObligationId: string;
  cancellationBookingId: string;
  // Runtime validation deliberately ignores this legacy/untyped property and
  // persists its canonical discriminator instead.
  reason?: string;
};

export type ReserveRefundTransactionInput =
  | DirectRefundReservationInput
  | CancellationRefundReservationInput;

type NormalizedRefundReservationInput = RefundReservationBase & {
  kind: 'DIRECT' | 'CANCELLATION';
  cancellationRefundObligationId: string | null;
  cancellationBookingId: string | null;
  reason: string;
};

type UnsafeRefundReservationInput = RefundReservationBase & {
  kind?: unknown;
  cancellationRefundObligationId?: unknown;
  cancellationBookingId?: unknown;
  bookingId?: unknown;
  reason?: unknown;
};

const ACTIVE_REFUND_STATUSES: readonly RefundStatus[] = [
  RefundStatus.REFUND_PENDING,
  RefundStatus.REFUND_PROCESSING,
  RefundStatus.REFUND_RETRY_SCHEDULED,
] as const;

type RefundReservationCapacity = 'PAYMENT' | 'OBLIGATION';

@Injectable()
export class RefundTransactionService {
  private readonly logger = new Logger(RefundTransactionService.name);

  constructor(private readonly prisma: PrismaService) {}

  private computeRequestHash(input: NormalizedRefundReservationInput): string {
    return crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          paymentId: input.paymentId,
          kind: input.kind,
          obligationId: input.cancellationRefundObligationId,
          bookingId: input.cancellationBookingId,
          amount: input.amount,
          currency: input.currency,
          reason: input.reason,
        }),
      )
      .digest('hex');
  }

  private normalizeReservationInput(
    input: ReserveRefundTransactionInput,
  ): NormalizedRefundReservationInput {
    // TypeScript callers receive a discriminated union, but this service is also
    // reached at runtime by untyped NestJS boundaries and tests.
    const rawInput = input as unknown as UnsafeRefundReservationInput;

    if (rawInput.kind === 'DIRECT') {
      if (
        rawInput.cancellationRefundObligationId !== undefined ||
        rawInput.cancellationBookingId !== undefined ||
        rawInput.bookingId !== undefined ||
        typeof rawInput.reason !== 'string' ||
        rawInput.reason.trim().toLowerCase().startsWith('cancellation:')
      ) {
        throw new BadRequestException(
          'Direct refund requests cannot use cancellation semantics',
        );
      }

      return {
        paymentId: rawInput.paymentId,
        amount: rawInput.amount,
        currency: rawInput.currency,
        triggerType: rawInput.triggerType,
        actorId: rawInput.actorId,
        idempotencyKey: rawInput.idempotencyKey,
        kind: 'DIRECT',
        cancellationRefundObligationId: null,
        cancellationBookingId: null,
        reason: rawInput.reason,
      };
    }

    if (rawInput.kind === 'CANCELLATION') {
      if (rawInput.bookingId !== undefined) {
        throw new BadRequestException(
          'Cancellation refunds must use cancellationBookingId instead of bookingId',
        );
      }
      if (
        typeof rawInput.cancellationRefundObligationId !== 'string' ||
        rawInput.cancellationRefundObligationId.trim().length === 0
      ) {
        throw new BadRequestException(
          'Cancellation refunds require a cancellation refund obligation',
        );
      }
      if (
        typeof rawInput.cancellationBookingId !== 'string' ||
        rawInput.cancellationBookingId.trim().length === 0
      ) {
        throw new BadRequestException('Cancellation refunds require a booking identifier');
      }

      return {
        paymentId: rawInput.paymentId,
        amount: rawInput.amount,
        currency: rawInput.currency,
        triggerType: rawInput.triggerType,
        actorId: rawInput.actorId,
        idempotencyKey: rawInput.idempotencyKey,
        kind: 'CANCELLATION',
        cancellationRefundObligationId: rawInput.cancellationRefundObligationId.trim(),
        cancellationBookingId: rawInput.cancellationBookingId.trim(),
        reason: `cancellation:${rawInput.cancellationBookingId.trim()}`,
      };
    }

    throw new BadRequestException('Refund reservation kind must be DIRECT or CANCELLATION');
  }

  private logReservationTelemetry(
    outcome: 'RESERVED' | 'REJECTED',
    capacity?: RefundReservationCapacity,
  ): void {
    const event = {
      message: 'refund_reservation',
      outcome,
      ...(capacity ? { capacity } : {}),
    };

    if (outcome === 'REJECTED') {
      this.logger.warn(event);
      return;
    }

    this.logger.log(event);
  }

  async reserveTransaction(input: ReserveRefundTransactionInput): Promise<Refund> {
    if (!input.amount || !Number.isInteger(input.amount) || input.amount <= 0) {
      throw new BadRequestException('Refund amount must be a positive integer in minor units');
    }

    const normalizedInput = this.normalizeReservationInput(input);

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
        bookingId: string;
        paymentId: string;
        totalAmount: number;
        currency: string;
      } | null = null;

      if (normalizedInput.cancellationRefundObligationId) {
        const obligations = await tx.$queryRaw<
          Array<{
            id: string;
            bookingId: string;
            paymentId: string;
            totalAmount: number;
            currency: string;
          }>
        >`
          SELECT id, "bookingId", "paymentId", "totalAmount", currency
          FROM cancellation_refund_obligations
          WHERE id = ${normalizedInput.cancellationRefundObligationId}
          FOR UPDATE
        `;

        if (!obligations || obligations.length === 0) {
          throw new NotFoundException(
            `CancellationRefundObligation ${normalizedInput.cancellationRefundObligationId} not found`,
          );
        }
        obligation = obligations[0];

        if (obligation.paymentId !== payment.id) {
          throw new BadRequestException('Obligation does not belong to the specified payment');
        }
        if (obligation.bookingId !== normalizedInput.cancellationBookingId) {
          throw new BadRequestException('Obligation does not belong to the specified booking');
        }
        if (obligation.currency.toUpperCase() !== input.currency.toUpperCase()) {
          throw new BadRequestException('Currency mismatch with obligation');
        }
      }

      if (payment.currency.toUpperCase() !== input.currency.toUpperCase()) {
        throw new BadRequestException('Currency mismatch with payment');
      }

      const requestHash = this.computeRequestHash(normalizedInput);

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
        this.logReservationTelemetry('REJECTED', 'PAYMENT');
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
          this.logReservationTelemetry('REJECTED', 'OBLIGATION');
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
          cancellationRefundObligationId:
            normalizedInput.cancellationRefundObligationId,
          idempotencyKeyId: idempotencyKeyRecord.id,
          amount: input.amount,
          currency: input.currency.toUpperCase(),
          reason: normalizedInput.reason,
          triggerType: input.triggerType,
          triggeredByUserId: input.actorId ?? null,
          status: RefundStatus.REFUND_PENDING,
          idempotencyKeyCreatedAt: new Date(),
        },
      });

      if (
        payment.status !== PaymentStatus.REFUND_PENDING &&
        payment.status !== PaymentStatus.DISPUTED &&
        payment.status !== PaymentStatus.CHARGEBACK_LOST
      ) {
        await tx.payment.update({
          where: { id: payment.id },
          data: { status: PaymentStatus.REFUND_PENDING },
        });

        await tx.paymentEvent.create({
          data: {
            paymentId: payment.id,
            eventType: 'refund_initiated',
            previousStatus: payment.status,
            newStatus: PaymentStatus.REFUND_PENDING,
            amount: input.amount,
            source:
              input.triggerType === RefundTriggerType.SYSTEM_AUTOMATED
                ? PaymentEventSource.SYSTEM
                : PaymentEventSource.API,
            createdBy: input.actorId || 'system',
          },
        });
      }

      this.logReservationTelemetry('RESERVED');

      return createdRefund;
    });
  }
}
