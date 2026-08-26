import {
  Injectable,
  BadRequestException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { AuditService } from '@/audit/audit.service';
import {
  BookingStatus,
  LedgerEntryType,
  PaymentEventSource,
  PaymentStatus,
  Prisma,
  RefundStatus,
} from '@prisma/client';
import * as crypto from 'crypto';
import {
  RefundProvenanceSource,
  RefundSettlementInput,
  RefundSettlementResult,
} from './refund-settlement.types';

const LEDGER_ACCOUNT_PLATFORM_REVENUE = 'PLATFORM_REVENUE';
const LEDGER_ACCOUNT_CUSTOMER_RECEIVABLE = 'CUSTOMER_RECEIVABLE';

@Injectable()
export class RefundSettlementService {
  private readonly logger = new Logger(RefundSettlementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  private mapProvenanceToEventSource(source: RefundProvenanceSource): PaymentEventSource {
    switch (source) {
      case 'WEBHOOK':
        return PaymentEventSource.WEBHOOK;
      case 'CRON':
        return PaymentEventSource.CRON;
      case 'INLINE':
      case 'ADMIN':
      default:
        return PaymentEventSource.API;
    }
  }

  private deriveEventType(
    source: RefundProvenanceSource,
    reason?: string | null,
    metadata?: Record<string, unknown>,
  ): string {
    if (typeof metadata?.eventType === 'string') {
      return metadata.eventType;
    }
    switch (source) {
      case 'WEBHOOK':
        return 'charge.refunded';
      case 'CRON':
        return 'cancellation_refund_recovered';
      case 'ADMIN':
        return 'cancellation_refund_manually_resolved';
      case 'INLINE':
      default:
        return reason?.startsWith('cancellation:') ? 'cancellation_refund_succeeded' : 'refund_settled';
    }
  }

  private logSettlementTelemetry(
    outcome: 'APPLIED' | 'NO_OP' | 'CONFLICT',
    provenance: RefundProvenanceSource,
    transactionStatus: RefundStatus,
  ): void {
    const event = {
      message: 'refund_settlement',
      outcome,
      provenance,
      transactionStatus,
    };

    if (outcome === 'CONFLICT') {
      this.logger.warn(event);
      return;
    }

    this.logger.log(event);
  }

  async settleVerifiedOutcome(input: RefundSettlementInput): Promise<RefundSettlementResult> {
    return this.prisma.$transaction(async (tx) => {
      const lockedRefunds = await tx.$queryRaw<
        Array<{
          id: string;
          paymentId: string;
          cancellationRefundObligationId: string | null;
        }>
      >`
        SELECT id, "paymentId", "cancellationRefundObligationId"
        FROM refunds
        WHERE id = ${input.transactionId}
        FOR UPDATE
      `;

      if (!lockedRefunds || lockedRefunds.length === 0) {
        throw new NotFoundException(`Refund transaction ${input.transactionId} not found`);
      }

      const lockedRefundMeta = lockedRefunds[0];

      if (lockedRefundMeta.paymentId) {
        await tx.$queryRaw`
          SELECT id
          FROM payments
          WHERE id = ${lockedRefundMeta.paymentId}
          FOR UPDATE
        `;
      }

      if (lockedRefundMeta.cancellationRefundObligationId) {
        await tx.$queryRaw`
          SELECT id
          FROM cancellation_refund_obligations
          WHERE id = ${lockedRefundMeta.cancellationRefundObligationId}
          FOR UPDATE
        `;
      }

      const refund = await tx.refund.findUnique({
        where: { id: input.transactionId },
        include: {
          payment: true,
          cancellationRefundObligation: {
            include: { booking: true },
          },
        },
      });

      if (!refund) {
        throw new NotFoundException(`Refund transaction ${input.transactionId} not found`);
      }

      if (
        refund.amount !== input.money.amount ||
        refund.currency.toUpperCase() !== input.money.currency.toUpperCase()
      ) {
        this.logSettlementTelemetry(
          'CONFLICT',
          input.provenance.source,
          refund.status,
        );
        throw new BadRequestException(
          `Refund transaction facts mismatch for ${input.transactionId}: expected ${refund.amount} ${refund.currency}, got ${input.money.amount} ${input.money.currency}`,
        );
      }

      const booking = refund.cancellationRefundObligation?.booking;

      if (refund.status === RefundStatus.SUCCEEDED) {
        this.logSettlementTelemetry(
          'NO_OP',
          input.provenance.source,
          RefundStatus.SUCCEEDED,
        );
        return {
          applied: false,
          transactionStatus: 'SUCCEEDED',
          paymentStatus: refund.payment.status,
          bookingStatus: booking?.status,
        };
      }

      if (
        refund.status === RefundStatus.FAILED ||
        (refund.status === RefundStatus.REFUND_FAILED_NEEDS_ATTENTION &&
          input.outcome.status !== 'SUCCEEDED')
      ) {
        this.logSettlementTelemetry(
          'NO_OP',
          input.provenance.source,
          refund.status,
        );
        return {
          applied: false,
          transactionStatus: refund.status,
          paymentStatus: refund.payment.status,
          bookingStatus: booking?.status,
        };
      }

      if (input.outcome.status === 'SUCCEEDED') {
        await tx.refund.update({
          where: { id: refund.id },
          data: {
            status: RefundStatus.SUCCEEDED,
            stripeRefundId: input.outcome.providerReference,
            nextRetryAt: null,
            updatedAt: new Date(input.outcome.occurredAt),
          },
        });

        const transactionId = crypto.randomUUID();
        try {
          await tx.ledgerEntry.create({
            data: {
              paymentId: refund.paymentId,
              refundTransactionId: refund.id,
              transactionId,
              accountId: LEDGER_ACCOUNT_PLATFORM_REVENUE,
              entryType: LedgerEntryType.DEBIT,
              amount: refund.amount,
              currency: refund.currency,
            },
          });

          await tx.ledgerEntry.create({
            data: {
              paymentId: refund.paymentId,
              refundTransactionId: refund.id,
              transactionId,
              accountId: LEDGER_ACCOUNT_CUSTOMER_RECEIVABLE,
              entryType: LedgerEntryType.CREDIT,
              amount: refund.amount,
              currency: refund.currency,
            },
          });
        } catch (error) {
          this.logger.error({
            message: 'refund_ledger_invariant_failure',
            provenance: input.provenance.source,
            operation: 'WRITE_REVERSAL_PAIR',
          });
          throw error;
        }

        const allSucceeded = await tx.refund.findMany({
          where: {
            paymentId: refund.paymentId,
            status: RefundStatus.SUCCEEDED,
          },
          select: { amount: true },
        });

        const totalRefunded = allSucceeded.reduce((s, r) => s + r.amount, 0);
        const basePaymentStatus =
          totalRefunded >= refund.payment.amount
            ? PaymentStatus.REFUNDED
            : PaymentStatus.PARTIALLY_REFUNDED;

        let finalPaymentStatus: PaymentStatus;
        if (
          refund.payment.status === PaymentStatus.DISPUTED ||
          refund.payment.status === PaymentStatus.CHARGEBACK_LOST
        ) {
          finalPaymentStatus = refund.payment.status;
          await tx.payment.update({
            where: { id: refund.paymentId },
            data: { preDisputeStatus: basePaymentStatus },
          });
        } else {
          finalPaymentStatus = basePaymentStatus;
          await tx.payment.update({
            where: { id: refund.paymentId },
            data: { status: basePaymentStatus },
          });
        }

        await tx.paymentEvent.create({
          data: {
            paymentId: refund.paymentId,
            eventType: this.deriveEventType(input.provenance.source, refund.reason, input.provenance.metadata),
            previousStatus: refund.payment.status,
            newStatus: finalPaymentStatus,
            amount: refund.amount,
            source: this.mapProvenanceToEventSource(input.provenance.source),
            stripeEventId: input.provenance.externalEventId ?? null,
            createdBy: input.provenance.actorId ?? 'system',
            metadata: (input.provenance.metadata as Prisma.InputJsonValue) ?? undefined,
          },
        });

        let finalBookingStatus: BookingStatus | undefined = undefined;
        const obligation = refund.cancellationRefundObligation;

        if (obligation) {
          const obligationSucceeded = await tx.refund.findMany({
            where: {
              cancellationRefundObligationId: obligation.id,
              status: RefundStatus.SUCCEEDED,
            },
            select: { amount: true },
          });

          const totalObligationRefunded = obligationSucceeded.reduce((s, r) => s + r.amount, 0);

          if (obligation.totalAmount === 0) {
            finalBookingStatus = BookingStatus.CANCELLED_NO_REFUND;
          } else if (totalObligationRefunded >= obligation.totalAmount) {
            finalBookingStatus = BookingStatus.CANCELLED_AND_REFUNDED;
          } else {
            finalBookingStatus = BookingStatus.CANCELLED_PENDING_REFUND;
          }

          if (obligation.booking && obligation.booking.status !== finalBookingStatus) {
            await tx.booking.update({
              where: { id: obligation.bookingId },
              data: { status: finalBookingStatus },
            });
          }
        }

        await this.auditService.createLog(tx, {
          userId: input.provenance.actorId ?? null,
          action: 'refund_settled',
          resourceType: 'Refund',
          resourceId: refund.id,
          traceId: input.provenance.traceId,
          correlationId: input.provenance.correlationId,
          metadata: {
            paymentId: refund.paymentId,
            cancellationRefundObligationId: refund.cancellationRefundObligationId,
            amount: refund.amount,
            currency: refund.currency,
            outcome: input.outcome,
            provenance: input.provenance,
          },
        });

        this.logSettlementTelemetry(
          'APPLIED',
          input.provenance.source,
          RefundStatus.SUCCEEDED,
        );

        return {
          applied: true,
          transactionStatus: 'SUCCEEDED',
          paymentStatus: finalPaymentStatus,
          bookingStatus: finalBookingStatus,
        };
      }

      const targetStatus =
        input.outcome.errorCode === 'REFUND_FAILED_NEEDS_ATTENTION' ||
        input.outcome.errorCode === 'IDEMPOTENCY_KEY_SAFETY_WINDOW' ||
        input.outcome.errorCode?.includes('ATTENTION') ||
        input.outcome.errorCode?.includes('SAFETY_WINDOW')
          ? RefundStatus.REFUND_FAILED_NEEDS_ATTENTION
          : RefundStatus.FAILED;

      await tx.refund.update({
        where: { id: refund.id },
        data: {
          status: targetStatus,
          lastErrorCode: input.outcome.errorCode,
          lastErrorAt: new Date(input.outcome.occurredAt),
        },
      });

      let finalBookingStatus: BookingStatus | undefined = booking?.status;
      if (targetStatus === RefundStatus.REFUND_FAILED_NEEDS_ATTENTION) {
        finalBookingStatus = BookingStatus.REFUND_FAILED_NEEDS_ATTENTION;
        if (refund.cancellationRefundObligation?.bookingId) {
          await tx.booking.updateMany({
            where: { id: refund.cancellationRefundObligation.bookingId },
            data: { status: BookingStatus.REFUND_FAILED_NEEDS_ATTENTION },
          });
        }
      }

      const activeOtherRefunds = await tx.refund.findMany({
        where: {
          paymentId: refund.paymentId,
          id: { not: refund.id },
          status: {
            in: [
              RefundStatus.REFUND_PENDING,
              RefundStatus.REFUND_PROCESSING,
              RefundStatus.REFUND_RETRY_SCHEDULED,
            ],
          },
        },
      });

      const succeededRefunds = await tx.refund.findMany({
        where: {
          paymentId: refund.paymentId,
          status: RefundStatus.SUCCEEDED,
        },
        select: { amount: true },
      });

      let finalPaymentStatus: PaymentStatus = refund.payment.status;
      if (activeOtherRefunds.length === 0) {
        const restoredStatus =
          succeededRefunds.length > 0
            ? PaymentStatus.PARTIALLY_REFUNDED
            : PaymentStatus.SUCCEEDED;

        if (
          refund.payment.status === PaymentStatus.DISPUTED ||
          refund.payment.status === PaymentStatus.CHARGEBACK_LOST
        ) {
          finalPaymentStatus = refund.payment.status;
          await tx.payment.update({
            where: { id: refund.paymentId },
            data: { preDisputeStatus: restoredStatus },
          });
        } else if (refund.payment.status === PaymentStatus.REFUND_PENDING) {
          await tx.payment.update({
            where: { id: refund.paymentId },
            data: { status: restoredStatus },
          });
          finalPaymentStatus = restoredStatus;
        }
      }

      await tx.paymentEvent.create({
        data: {
          paymentId: refund.paymentId,
          eventType: 'refund_failed',
          previousStatus: refund.payment.status,
          newStatus: finalPaymentStatus,
          amount: refund.amount,
          source: this.mapProvenanceToEventSource(input.provenance.source),
          stripeEventId: input.provenance.externalEventId ?? null,
          createdBy: input.provenance.actorId ?? 'system',
          metadata: {
            errorCode: input.outcome.errorCode,
            ...(input.provenance.metadata ?? {}),
          } as Prisma.InputJsonValue,
        },
      });

      await this.auditService.createLog(tx, {
        userId: input.provenance.actorId ?? null,
        action: 'refund_failed',
        resourceType: 'Refund',
        resourceId: refund.id,
        traceId: input.provenance.traceId,
        correlationId: input.provenance.correlationId,
        metadata: {
          paymentId: refund.paymentId,
          cancellationRefundObligationId: refund.cancellationRefundObligationId,
          amount: refund.amount,
          currency: refund.currency,
          outcome: input.outcome,
          provenance: input.provenance,
        },
      });

      this.logSettlementTelemetry(
        'APPLIED',
        input.provenance.source,
        targetStatus,
      );

      return {
        applied: true,
        transactionStatus: targetStatus,
        paymentStatus: finalPaymentStatus,
        bookingStatus: finalBookingStatus,
      };
    });
  }
}
