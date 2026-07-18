import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { StripeService } from '@/common/stripe.service';
import { PaymentRefundService } from '@/payment/payment-refund.service';
import { AuditService } from '@/audit/audit.service';
import { PaymentStatus, PaymentEventSource, Prisma } from '@prisma/client';
import { canTransition, getPreDisputeStatus, resolveDisputeStatus } from './payment-state-machine';
import * as crypto from 'crypto';

@Injectable()
export class PaymentWebhookService {
  private readonly logger = new Logger(PaymentWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
    private readonly paymentRefundService: PaymentRefundService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Main entry point to process verified Stripe webhook events.
   */
  async handleWebhookEvent(event: any): Promise<boolean> {
    const startTime = Date.now();
    const eventType = event.type;
    const stripeEventId = event.id;

    this.logger.log({
      message: `Processing webhook event ${stripeEventId}`,
      eventType,
    });

    // T003: Deduplication
    const existingEvent = await this.prisma.paymentEvent.findUnique({
      where: { stripeEventId },
    });

    if (existingEvent) {
      this.logger.log({
        message: `Deduplication triggered: event ${stripeEventId} already processed. Skipping.`,
        stripeEventId,
        eventType,
      });
      return true;
    }

    try {
      // Handle charge.refunded separately (different data structure)
      if (eventType === 'charge.refunded') {
        await this.handleChargeRefunded(event);
        this.logger.log({
          message: `Webhook processed successfully`,
          eventType,
          paymentId: null,
          durationMs: Date.now() - startTime,
        });
        return true;
      }

      // Handle dispute events separately (custom preDisputeStatus logic)
      if (eventType === 'charge.dispute.created') {
        await this.handleDisputeCreated(event);
        this.logger.log({
          message: `Webhook processed successfully`,
          eventType,
          durationMs: Date.now() - startTime,
        });
        return true;
      }

      if (eventType === 'charge.dispute.closed') {
        await this.handleDisputeClosed(event);
        this.logger.log({
          message: `Webhook processed successfully`,
          eventType,
          durationMs: Date.now() - startTime,
        });
        return true;
      }

      // Identify target status based on Stripe event type
      let targetStatus: PaymentStatus;
      if (eventType === 'payment_intent.succeeded') {
        targetStatus = PaymentStatus.SUCCEEDED;
      } else if (eventType === 'payment_intent.payment_failed') {
        targetStatus = PaymentStatus.FAILED;
      } else if (eventType === 'payment_intent.canceled') {
        targetStatus = PaymentStatus.CANCELLED;
      } else {
        // Unhandled event type for this service
        this.logger.warn({
          message: `Unhandled event type: ${eventType}`,
          stripeEventId,
        });
        return true;
      }

      const stripePaymentIntentId = event.data.object.id;
      const payment = await this.prisma.payment.findUnique({
        where: { stripePaymentIntentId },
      });

      if (!payment) {
        this.logger.error({
          message: `Payment record not found for stripePaymentIntentId: ${stripePaymentIntentId}`,
          stripeEventId,
          stripePaymentIntentId,
        });
        return true;
      }

      const currentStatus = payment.status;

      // Handle identical state (no-op)
      if (currentStatus === targetStatus) {
        await this.prisma.paymentEvent.create({
          data: {
            paymentId: payment.id,
            eventType,
            previousStatus: currentStatus,
            newStatus: targetStatus,
            amount: event.data.object.amount,
            source: PaymentEventSource.WEBHOOK,
            stripeEventId,
            createdBy: 'stripe_webhook',
            metadata: event,
          },
        });

        this.logger.log({
          message: `No-op transition: payment already in target state ${targetStatus}`,
          paymentId: payment.id,
          currentStatus,
          targetStatus,
          durationMs: Date.now() - startTime,
        });
        return true;
      }

      let isPlausible = false;
      // T007: Check if transition is plausible (e.g. out-of-order) even if strictly invalid in FSM
      if (!canTransition(currentStatus, targetStatus)) {
        if (
          (targetStatus === PaymentStatus.SUCCEEDED && (currentStatus === PaymentStatus.CREATED || currentStatus === PaymentStatus.AUTHORIZED)) ||
          (targetStatus === PaymentStatus.FAILED && (currentStatus === PaymentStatus.CREATED || currentStatus === PaymentStatus.AUTHORIZED)) ||
          (targetStatus === PaymentStatus.CANCELLED && (currentStatus === PaymentStatus.CREATED || currentStatus === PaymentStatus.AUTHORIZED))
        ) {
          isPlausible = true;
        }
      }

      // If FSM rejects transition, evaluate for Tier 1 self-healing or Tier 2 drop
      if (!canTransition(currentStatus, targetStatus)) {
        if (isPlausible) {
          // T007: Tier 1 self-healing reconciliation
          this.logger.warn({
            message: `Out-of-order/invalid transition [${currentStatus} -> ${targetStatus}] detected. Initiating Tier 1 self-healing.`,
            paymentId: payment.id,
            stripePaymentIntentId,
          });

          try {
            const canonicalIntent = await this.stripeService.retrievePaymentIntent(stripePaymentIntentId);
            const canonicalStatus = canonicalIntent.status;

            // Verify canonical state matches target status
            let isCanonicalVerified = false;
            if (targetStatus === PaymentStatus.SUCCEEDED && canonicalStatus === 'succeeded') {
              isCanonicalVerified = true;
            } else if (targetStatus === PaymentStatus.CANCELLED && canonicalStatus === 'canceled') {
              isCanonicalVerified = true;
            } else if (targetStatus === PaymentStatus.FAILED && canonicalStatus === 'requires_payment_method') {
              isCanonicalVerified = true;
            }

            if (isCanonicalVerified) {
              this.logger.log({
                message: `Tier 1 self-healing: Stripe state verified as ${canonicalStatus}. Fast-forwarding local state to ${targetStatus}.`,
                paymentId: payment.id,
                stripePaymentIntentId,
              });

              await this.executeStateTransition(payment, targetStatus, event, stripeEventId);

              this.logger.log({
                message: `Webhook processed successfully (Self-Healed)`,
                eventType,
                paymentId: payment.id,
                transition: `${currentStatus} -> ${targetStatus}`,
                selfHealing: true,
                durationMs: Date.now() - startTime,
              });
              return true;
            } else {
              // Mismatch between Stripe's API state and webhook event state
              this.logger.error({
                message: `ALERT: Tier 1 self-healing failed. Stripe API state (${canonicalStatus}) mismatches webhook target (${targetStatus}). Dropping event.`,
                level: 'ALERT',
                paymentId: payment.id,
                stripePaymentIntentId,
                event,
              });
              return true;
            }
          } catch (error) {
            this.logger.error({
              message: `Tier 1 self-healing failed due to API error: ${error instanceof Error ? error.message : String(error)}`,
              paymentId: payment.id,
              error,
            });
            throw error;
          }
        } else {
          // T008: Tier 2 alert + drop (strictly irreconcilable transition)
          this.logger.error({
            message: `ALERT: Irreconcilable webhook transition requested [${currentStatus} -> ${targetStatus}]. Dropping event.`,
            level: 'ALERT',
            paymentId: payment.id,
            stripePaymentIntentId,
            event,
          });
          return true;
        }
      }

      // Normal path: transition is valid according to FSM
      await this.executeStateTransition(payment, targetStatus, event, stripeEventId);

      // T009: Structured logging
      this.logger.log({
        message: `Webhook processed successfully`,
        eventType,
        paymentId: payment.id,
        transition: `${currentStatus} -> ${targetStatus}`,
        selfHealing: false,
        durationMs: Date.now() - startTime,
      });

      return true;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        (
          (Array.isArray(error.meta?.target) && error.meta.target.includes('stripeEventId')) ||
          (typeof error.meta?.target === 'string' && error.meta.target.includes('stripeEventId'))
        )
      ) {
        this.logger.log({
          message: `Concurrent duplicate webhook event detected: event ${stripeEventId} already processed. Skipping.`,
          stripeEventId,
          eventType,
        });
        return true;
      }
      throw error;
    }
  }

  /**
   * Helper to perform database state updates and ledger entry writes.
   */
  private async executeStateTransition(
    payment: any,
    targetStatus: PaymentStatus,
    event: any,
    stripeEventId: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // 1. Update Payment status
      await tx.payment.update({
        where: { id: payment.id },
        data: { status: targetStatus },
      });

      // 2. Append PaymentEvent
      await tx.paymentEvent.create({
        data: {
          paymentId: payment.id,
          eventType: event.type,
          previousStatus: payment.status,
          newStatus: targetStatus,
          amount: event.data.object.amount,
          source: PaymentEventSource.WEBHOOK,
          stripeEventId,
          createdBy: 'stripe_webhook',
          metadata: event,
        },
      });

      // 3. Conditional target status logic (e.g. SUCCEEDED / FAILED / CANCELLED)
      if (targetStatus === PaymentStatus.SUCCEEDED) {
        // Update BookingIntent status to CONFIRMED
        await tx.bookingIntent.update({
          where: { id: payment.bookingIntentId },
          data: { status: 'CONFIRMED' },
        });

        // Create double-entry ledger rows if they don't already exist
        const existingLedger = await tx.ledgerEntry.findFirst({
          where: { paymentId: payment.id },
        });

        if (!existingLedger) {
          const transactionId = crypto.randomUUID();
          await tx.ledgerEntry.createMany({
            data: [
              {
                paymentId: payment.id,
                transactionId,
                accountId: 'CUSTOMER_RECEIVABLE',
                entryType: 'DEBIT',
                amount: payment.amount,
                currency: payment.currency,
              },
              {
                paymentId: payment.id,
                transactionId,
                accountId: 'PLATFORM_REVENUE',
                entryType: 'CREDIT',
                amount: payment.amount,
                currency: payment.currency,
              },
            ],
          });
        }
      } else if (targetStatus === PaymentStatus.FAILED || targetStatus === PaymentStatus.CANCELLED) {
        // If payment fails/cancels, we update booking intent status
        const bookingIntent = await tx.bookingIntent.findUnique({
          where: { id: payment.bookingIntentId },
        });

        if (bookingIntent) {
          const nextBookingStatus = bookingIntent.paymentAttemptCount < 2 ? 'AWAITING_PAYMENT' : 'CANCELLED';
          await tx.bookingIntent.update({
            where: { id: payment.bookingIntentId },
            data: { status: nextBookingStatus },
          });
        }
      }
    });
  }

  /**
   * Handles charge.refunded webhook events by delegating to PaymentRefundService.
   */
  private async handleChargeRefunded(event: Record<string, unknown>): Promise<void> {
    await this.paymentRefundService.handleChargeRefunded(event);
  }

  /**
   * Handles charge.dispute.created webhook events.
   * Stores pre_dispute_status and transitions Payment to DISPUTED.
   */
  private async handleDisputeCreated(event: Record<string, unknown>): Promise<void> {
    const data = event.data as Record<string, unknown>;
    const dispute = data.object as Record<string, unknown>;
    const paymentIntentId = dispute.payment_intent as string;

    if (!paymentIntentId) {
      this.logger.warn('charge.dispute.created event missing payment_intent, skipping');
      return;
    }

    const payment = await this.prisma.payment.findUnique({
      where: { stripePaymentIntentId: paymentIntentId },
    });

    if (!payment) {
      this.logger.error({
        message: `Payment not found for stripePaymentIntentId: ${paymentIntentId}`,
        eventType: 'charge.dispute.created',
      });
      return;
    }

    const currentStatus = payment.status as PaymentStatus;

    // Validate: only SUCCEEDED, PARTIALLY_REFUNDED, REFUNDED can transition to DISPUTED
    if (!canTransition(currentStatus, PaymentStatus.DISPUTED)) {
      this.logger.error({
        message: `ALERT: Cannot transition from ${currentStatus} to DISPUTED. Dropping event.`,
        level: 'ALERT',
        paymentId: payment.id,
        currentStatus,
      });
      return;
    }

    // Store pre_dispute_status before transitioning
    const preDisputeStatus = getPreDisputeStatus(currentStatus);

    await this.prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.DISPUTED,
          preDisputeStatus,
        },
      });

      await tx.paymentEvent.create({
        data: {
          paymentId: payment.id,
          eventType: 'charge.dispute.created',
          previousStatus: currentStatus,
          newStatus: PaymentStatus.DISPUTED,
          amount: dispute.amount as number,
          source: PaymentEventSource.WEBHOOK,
          stripeEventId: event.id as string,
          createdBy: 'stripe_webhook',
          metadata: event as Prisma.InputJsonValue,
        },
      });
    });

    await this.auditService.createLog(this.prisma, {
      userId: null,
      action: 'dispute_opened',
      resourceType: 'Payment',
      resourceId: payment.id,
      metadata: {
        preDisputeStatus,
        disputeAmount: dispute.amount,
        stripeEventId: event.id,
      },
    });

    this.logger.log({
      message: `Dispute opened for payment ${payment.id}`,
      paymentId: payment.id,
      preDisputeStatus,
      transition: `${currentStatus} -> DISPUTED`,
    });
  }

  /**
   * Handles charge.dispute.closed webhook events.
   * If won: restores pre_dispute_status. If lost: transitions to CHARGEBACK_LOST.
   */
  private async handleDisputeClosed(event: Record<string, unknown>): Promise<void> {
    const data = event.data as Record<string, unknown>;
    const dispute = data.object as Record<string, unknown>;
    const paymentIntentId = dispute.payment_intent as string;
    const reason = dispute.reason as string | undefined;

    if (!paymentIntentId) {
      this.logger.warn('charge.dispute.closed event missing payment_intent, skipping');
      return;
    }

    const payment = await this.prisma.payment.findUnique({
      where: { stripePaymentIntentId: paymentIntentId },
    });

    if (!payment) {
      this.logger.error({
        message: `Payment not found for stripePaymentIntentId: ${paymentIntentId}`,
        eventType: 'charge.dispute.closed',
      });
      return;
    }

    const currentStatus = payment.status as PaymentStatus;

    if (currentStatus !== PaymentStatus.DISPUTED) {
      this.logger.error({
        message: `ALERT: Dispute closed for payment not in DISPUTED state (current: ${currentStatus}). Dropping event.`,
        level: 'ALERT',
        paymentId: payment.id,
      });
      return;
    }

    // Determine outcome: Stripe sends 'won', 'lost', or 'warning_closed' (inquiry-type)
    const rawDisputeStatus = dispute.status as string;

    // warning_closed: inquiry closed without a chargeback — merchant retains funds, treat as won
    if (rawDisputeStatus !== 'won' && rawDisputeStatus !== 'lost' && rawDisputeStatus !== 'warning_closed') {
      this.logger.error({
        message: `ALERT: Unrecognised dispute status '${rawDisputeStatus}' for payment ${payment.id}. Dropping event.`,
        level: 'ALERT',
        paymentId: payment.id,
        disputeStatus: rawDisputeStatus,
      });
      return;
    }

    const outcome: 'won' | 'lost' = rawDisputeStatus === 'lost' ? 'lost' : 'won';

    // Resolve target status using state machine helper
    const preDisputeStatus = payment.preDisputeStatus as PaymentStatus | null;
    if (!preDisputeStatus) {
      this.logger.error({
        message: `ALERT: Dispute closed but pre_dispute_status is null for payment ${payment.id}. Cannot resolve.`,
        level: 'ALERT',
        paymentId: payment.id,
      });
      return;
    }

    const targetStatus = resolveDisputeStatus(outcome, preDisputeStatus);

    if (!canTransition(currentStatus, targetStatus)) {
      this.logger.error({
        message: `ALERT: Cannot transition from ${currentStatus} to ${targetStatus} for dispute resolution. Dropping event.`,
        level: 'ALERT',
        paymentId: payment.id,
        currentStatus,
        targetStatus,
      });
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: targetStatus,
          preDisputeStatus: null, // Clear pre_dispute_status after resolution
        },
      });

      await tx.paymentEvent.create({
        data: {
          paymentId: payment.id,
          eventType: 'charge.dispute.closed',
          previousStatus: currentStatus,
          newStatus: targetStatus,
          amount: dispute.amount as number,
          source: PaymentEventSource.WEBHOOK,
          stripeEventId: event.id as string,
          createdBy: 'stripe_webhook',
          metadata: event as Prisma.InputJsonValue,
        },
      });
    });

    const auditAction = outcome === 'won' ? 'dispute_won' : 'dispute_lost';

    await this.auditService.createLog(this.prisma, {
      userId: null,
      action: auditAction,
      resourceType: 'Payment',
      resourceId: payment.id,
      metadata: {
        outcome,
        preDisputeStatus,
        targetStatus,
        disputeReason: reason,
        stripeEventId: event.id,
      },
    });

    if (outcome === 'lost') {
      this.logger.error({
        message: `ALERT: Dispute LOST for payment ${payment.id}. Transitioning to CHARGEBACK_LOST.`,
        level: 'ALERT',
        paymentId: payment.id,
        preDisputeStatus,
      });
    } else {
      this.logger.log({
        message: `Dispute WON for payment ${payment.id}. Restoring to ${preDisputeStatus}.`,
        paymentId: payment.id,
        preDisputeStatus,
        transition: `${currentStatus} -> ${targetStatus}`,
      });
    }
  }
}
