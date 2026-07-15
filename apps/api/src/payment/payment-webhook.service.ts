import { Injectable, Logger, BadRequestException, NotFoundException, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { StripeService } from '@/common/stripe.service';
import { PaymentLedgerService } from './payment-ledger.service';
import { AuditService } from '@/audit/audit.service';
import { enforceTransition, canTransition, resolveDisputeStatus } from './payment-state-machine';
import { PaymentStatus, RefundStatus, RefundTriggerType } from '@prisma/client';
import Stripe from 'stripe';
import { PaymentMethodService } from './payment-method.service';
import { PaymentRefundService } from './payment-refund.service';

@Injectable()
export class PaymentWebhookService {
  private readonly logger = new Logger(PaymentWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
    private readonly ledgerService: PaymentLedgerService,
    private readonly auditService: AuditService,
    private readonly paymentMethodService: PaymentMethodService,
    @Inject(forwardRef(() => PaymentRefundService))
    private readonly paymentRefundService: PaymentRefundService
  ) {}

  /**
   * Processes verified Stripe webhook events.
   */
  async handleWebhookEvent(event: Stripe.Event): Promise<void> {
    const eventId = event.id;
    const eventType = event.type;

    this.logger.log(`Received Stripe Webhook: eventId=${eventId}, type=${eventType}`);

    // Deduplication check: check if this stripeEventId has already been recorded
    const existingEvent = await this.prisma.paymentEvent.findUnique({
      where: { stripeEventId: eventId },
    });

    if (existingEvent) {
      this.logger.log(`Duplicate webhook event detected: stripeEventId=${eventId}. Skipping.`);
      return;
    }

    let stripePaymentIntentId: string | null = null;
    if (eventType.startsWith('charge.dispute.')) {
      const dispute = event.data.object as Stripe.Dispute;
      stripePaymentIntentId = typeof dispute.payment_intent === 'string'
        ? dispute.payment_intent
        : (dispute.payment_intent as any)?.id || null;
    } else if (eventType.startsWith('charge.')) {
      const charge = event.data.object as Stripe.Charge;
      stripePaymentIntentId = typeof charge.payment_intent === 'string'
        ? charge.payment_intent
        : charge.payment_intent?.id || null;
    } else {
      const paymentIntent = event.data.object as Stripe.PaymentIntent;
      stripePaymentIntentId = paymentIntent?.id || null;
    }

    if (!stripePaymentIntentId) {
      this.logger.warn(`Webhook event ${eventId} does not contain a valid Stripe ID or PaymentIntent`);
      return;
    }

    // Retrieve corresponding Payment from local DB
    const payment = await this.prisma.payment.findFirst({
      where: { stripePaymentIntentId },
      include: { bookingIntent: true },
    });

    if (!payment) {
      const alertMsg = `[ALERT] Webhook received for untracked Stripe PaymentIntent ID: ${stripePaymentIntentId}`;
      this.logger.error(alertMsg);
      console.error(alertMsg);
      return;
    }

    // Route based on event type
    switch (eventType) {
      case 'payment_intent.succeeded':
        await this.handlePaymentIntentSucceeded(event, payment, event.data.object as Stripe.PaymentIntent);
        break;

      case 'payment_intent.payment_failed':
        await this.handlePaymentIntentFailed(event, payment, event.data.object as Stripe.PaymentIntent);
        break;

      case 'payment_intent.canceled':
        await this.handlePaymentIntentCanceled(event, payment, event.data.object as Stripe.PaymentIntent);
        break;

      case 'charge.refunded':
        await this.handleChargeRefunded(event, payment);
        break;

      case 'charge.dispute.created':
        await this.handleDisputeCreated(event, payment, event.data.object as Stripe.Dispute);
        break;

      case 'charge.dispute.closed':
        await this.handleDisputeClosed(event, payment, event.data.object as Stripe.Dispute);
        break;

      default:
        this.logger.debug(`Unhandled Stripe event type: ${eventType}`);
        break;
    }
  }

  /**
   * Handles payment_intent.succeeded
   */
  private async handlePaymentIntentSucceeded(
    event: Stripe.Event,
    payment: any,
    paymentIntent: Stripe.PaymentIntent
  ): Promise<void> {
    // Handle duplicate capture detection
    const isCompleted = payment.bookingIntent.status === 'COMPLETED';
    const otherSucceeded = await this.prisma.payment.findFirst({
      where: {
        bookingIntentId: payment.bookingIntentId,
        id: { not: payment.id },
        status: PaymentStatus.SUCCEEDED,
      },
    });

    if (isCompleted || otherSucceeded) {
      this.logger.warn(
        `Duplicate capture detected for payment ${payment.id}. BookingIntent is ${payment.bookingIntent.status}, otherSucceeded payment found: ${!!otherSucceeded}. Transitioning to SUCCEEDED first, then triggering automated refund.`
      );
      try {
        await this.prisma.$transaction(async (tx) => {
          const livePayment = await tx.payment.findUnique({ where: { id: payment.id } });

          if (!livePayment) {
            throw new NotFoundException(`Payment ${payment.id} not found during duplicate-payment handling`);
          }

          // Update Payment status to SUCCEEDED
          await tx.payment.update({
            where: { id: payment.id, version: livePayment.version },
            data: {
              status: PaymentStatus.SUCCEEDED,
              version: { increment: 1 },
            },
          });

          // Record capture ledger entries so it balances out when refunded
          await this.ledgerService.recordCaptureLedger(
            payment.id,
            payment.amount,
            payment.currency,
            tx
          );

          // Create PaymentEvent for SUCCEEDED
          await tx.paymentEvent.create({
            data: {
              paymentId: payment.id,
              stripeEventId: event.id,
              eventType: event.type,
              previousStatus: livePayment.status,
              newStatus: PaymentStatus.SUCCEEDED,
              amount: payment.amount,
              source: 'WEBHOOK',
              createdBy: 'STRIPE_WEBHOOK',
            },
          });
        });

        // Trigger automated refund on the now-SUCCEEDED payment
        await this.paymentRefundService.initiateRefund(
          payment.id,
          payment.amount,
          'Duplicate payment detected',
          RefundTriggerType.SYSTEM_AUTOMATED
        );
      } catch (err: any) {
        this.logger.error(`Failed to handle duplicate payment success/refund for ${payment.id}: ${err.message}`, err.stack);
      }
      return;
    }

    const nextStatus = PaymentStatus.SUCCEEDED;

    // Check if already SUCCEEDED (API confirmation finished first)
    if (payment.status === PaymentStatus.SUCCEEDED) {
      this.logger.log(`Payment ${payment.id} is already SUCCEEDED. Recording event.`);
      await this.prisma.paymentEvent.create({
        data: {
          paymentId: payment.id,
          stripeEventId: event.id,
          eventType: event.type,
          previousStatus: payment.status,
          newStatus: PaymentStatus.SUCCEEDED,
          amount: payment.amount,
          source: 'WEBHOOK',
          createdBy: 'STRIPE_WEBHOOK',
        },
      });
      return;
    }

    // FSM transition check
    if (canTransition(payment.status, nextStatus)) {
      await this.executeSuccessTransition(event, payment, nextStatus);
    } else if (payment.status === PaymentStatus.CREATED) {
      // Tier 1: Out-of-order webhook (received succeeded when status is CREATED)
      // Call Stripe API to retrieve PaymentIntent and verify status
      this.logger.log(`Out-of-order succeeded event for Payment ${payment.id} (current status: CREATED). Verifying via Stripe retrieve...`);
      const stripeIntentVerified = await this.stripeService.retrievePaymentIntent(payment.stripePaymentIntentId);

      if (stripeIntentVerified.status === 'succeeded') {
        this.logger.log(`Stripe status verified. Fast-forwarding state to SUCCEEDED (Tier 1 self-healing)...`);
        await this.executeSuccessTransition(event, payment, nextStatus);
      } else {
        this.logger.warn(`Stripe retrieve verification failed for Payment ${payment.id}: Stripe status is ${stripeIntentVerified.status}`);
      }
    } else {
      // Tier 2: Irreconcilable states (REFUNDED, FAILED, CANCELLED, etc.) -> Drop & Alert
      const alertMsg = `[ALERT] Irreconcilable webhook event received: eventId=${event.id}, type=${event.type}, paymentId=${payment.id}, current DB status=${payment.status}. Dropping event.`;
      this.logger.error(alertMsg);
      console.error(alertMsg);
    }
  }

  /**
   * Performs the database mutations for a successful payment transition.
   */
  private async executeSuccessTransition(
    event: Stripe.Event,
    payment: any,
    nextStatus: PaymentStatus
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const livePayment = await tx.payment.findUnique({ where: { id: payment.id } });

      if (!livePayment) {
        throw new NotFoundException(`Payment ${payment.id} not found during webhook processing`);
      }

      // Idempotency guard: already transitioned (API pipeline won the race)
      if (livePayment.status === nextStatus) {
        await tx.paymentEvent.create({
          data: {
            paymentId: payment.id,
            stripeEventId: event.id,
            eventType: event.type,
            previousStatus: livePayment.status,
            newStatus: nextStatus,
            amount: payment.amount,
            source: 'WEBHOOK',
            createdBy: 'STRIPE_WEBHOOK',
          },
        });
        return;
      }

      enforceTransition(livePayment.status, nextStatus);

      // 1. Update Payment status
      await tx.payment.update({
        where: { id: payment.id, version: livePayment.version },
        data: { status: nextStatus, version: { increment: 1 } },
      });

      // 2. Update BookingIntent status to COMPLETED
      await tx.bookingIntent.update({
        where: { id: payment.bookingIntentId },
        data: { status: 'COMPLETED' },
      });

      // 3. Record ledger entries
      await this.ledgerService.recordCaptureLedger(
        payment.id,
        payment.amount,
        payment.currency,
        tx
      );

      // 4. Create PaymentEvent
      await tx.paymentEvent.create({
        data: {
          paymentId: payment.id,
          stripeEventId: event.id,
          eventType: event.type,
          previousStatus: payment.status,
          newStatus: nextStatus,
          amount: payment.amount,
          source: 'WEBHOOK',
          createdBy: 'STRIPE_WEBHOOK',
        },
      });

      // 5. Create Audit Log
      await this.auditService.createLog(tx, {
        userId: payment.bookingIntent.userId,
        action: 'booking_confirmed',
        resourceType: 'Payment',
        resourceId: payment.id,
        metadata: {
          paymentId: payment.id,
          bookingIntentId: payment.bookingIntentId,
          stripeEventId: event.id,
          source: 'WEBHOOK',
        },
      });
    });

    // Sync payment method if saveCard was requested
    await this.paymentMethodService.syncPaymentMethod(payment.id);

    this.logger.log(`Successfully completed webhook transition to SUCCEEDED for Payment ${payment.id}`);
  }

  /**
   * Handles payment_intent.payment_failed
   */
  private async handlePaymentIntentFailed(
    event: Stripe.Event,
    payment: any,
    paymentIntent: Stripe.PaymentIntent
  ): Promise<void> {
    const nextStatus = PaymentStatus.FAILED;

    if (payment.status === PaymentStatus.FAILED) {
      this.logger.log(`Payment ${payment.id} is already FAILED. Skipping.`);
      return;
    }

    try {
      const nextIntentStatus =
        payment.bookingIntent.paymentAttemptCount >= 2 ? 'PAYMENT_EXHAUSTED' : 'AWAITING_PAYMENT';

      await this.prisma.$transaction(async (tx) => {
        const livePayment = await tx.payment.findUnique({ where: { id: payment.id } });

        if (!livePayment) {
          throw new NotFoundException(`Payment ${payment.id} not found during webhook processing`);
        }

        if (livePayment.status === nextStatus) return;

        enforceTransition(livePayment.status, nextStatus);

        // 1. Update Payment status
        await tx.payment.update({
          where: { id: payment.id, version: livePayment.version },
          data: {
            status: nextStatus,
            version: { increment: 1 },
          },
        });

        // 2. Update BookingIntent status
        await tx.bookingIntent.update({
          where: { id: payment.bookingIntentId },
          data: { status: nextIntentStatus as any },
        });

        // 3. Create PaymentEvent
        await tx.paymentEvent.create({
          data: {
            paymentId: payment.id,
            stripeEventId: event.id,
            eventType: event.type,
            previousStatus: payment.status,
            newStatus: nextStatus,
            amount: payment.amount,
            source: 'WEBHOOK',
            createdBy: 'STRIPE_WEBHOOK',
          },
        });

        // 4. Audit Log
        await this.auditService.createLog(tx, {
          userId: payment.bookingIntent.userId,
          action: 'payment_failed',
          resourceType: 'Payment',
          resourceId: payment.id,
          metadata: {
            paymentId: payment.id,
            bookingIntentId: payment.bookingIntentId,
            stripeEventId: event.id,
          },
        });
      });

      this.logger.log(`Successfully transitioned Payment ${payment.id} to FAILED via webhook`);
    } catch (err: any) {
      this.logger.error(`Failed to transition Payment ${payment.id} to FAILED: ${err.message}`, err.stack);
    }
  }

  /**
   * Handles payment_intent.canceled
   */
  private async handlePaymentIntentCanceled(
    event: Stripe.Event,
    payment: any,
    paymentIntent: Stripe.PaymentIntent
  ): Promise<void> {
    const nextStatus = PaymentStatus.CANCELLED;

    if (payment.status === PaymentStatus.CANCELLED) {
      this.logger.log(`Payment ${payment.id} is already CANCELLED. Skipping.`);
      return;
    }

    try {
      const nextIntentStatus =
        payment.bookingIntent.paymentAttemptCount >= 2 ? 'PAYMENT_EXHAUSTED' : 'AWAITING_PAYMENT';

      await this.prisma.$transaction(async (tx) => {
        const livePayment = await tx.payment.findUnique({ where: { id: payment.id } });

        if (!livePayment) {
          throw new NotFoundException(`Payment ${payment.id} not found during webhook processing`);
        }

        if (livePayment.status === nextStatus) return;

        enforceTransition(livePayment.status, nextStatus);

        // 1. Update Payment status
        await tx.payment.update({
          where: { id: payment.id, version: livePayment.version },
          data: {
            status: nextStatus,
            version: { increment: 1 },
          },
        });

        // 2. Update BookingIntent status
        await tx.bookingIntent.update({
          where: { id: payment.bookingIntentId },
          data: { status: nextIntentStatus as any },
        });

        // 3. Create PaymentEvent
        await tx.paymentEvent.create({
          data: {
            paymentId: payment.id,
            stripeEventId: event.id,
            eventType: event.type,
            previousStatus: payment.status,
            newStatus: nextStatus,
            amount: payment.amount,
            source: 'WEBHOOK',
            createdBy: 'STRIPE_WEBHOOK',
          },
        });

        // 4. Audit Log
        await this.auditService.createLog(tx, {
          userId: payment.bookingIntent.userId,
          action: 'payment_canceled',
          resourceType: 'Payment',
          resourceId: payment.id,
          metadata: {
            paymentId: payment.id,
            bookingIntentId: payment.bookingIntentId,
            stripeEventId: event.id,
          },
        });
      });

      this.logger.log(`Successfully transitioned Payment ${payment.id} to CANCELLED via webhook`);
    } catch (err: any) {
      this.logger.error(`Failed to transition Payment ${payment.id} to CANCELLED: ${err.message}`, err.stack);
    }
  }

  /**
   * Handles charge.refunded
   */
  private async handleChargeRefunded(event: Stripe.Event, payment: any): Promise<void> {
    const charge = event.data.object as Stripe.Charge;
    const refunds = charge.refunds?.data || [];
    const stripeRefundIds = refunds.map((r) => r.id);

    // Find the corresponding Refund record that is currently REFUND_PENDING
    let localRefund = await this.prisma.refund.findFirst({
      where: {
        paymentId: payment.id,
        stripeRefundId: { in: stripeRefundIds },
        status: RefundStatus.REFUND_PENDING,
      },
    });

    if (!localRefund) {
      // Fallback: If no match found by Stripe ID (e.g. webhook race), check for a pending local refund with null Stripe ID
      // matching the refund amount.
      const stripeRefundAmount = refunds[0]?.amount; // Stripe amount is in cents
      if (stripeRefundAmount) {
        localRefund = await this.prisma.refund.findFirst({
          where: {
            paymentId: payment.id,
            stripeRefundId: null,
            amount: stripeRefundAmount,
            status: RefundStatus.REFUND_PENDING,
          },
        });

        if (localRefund) {
          this.logger.log(`Found matching pending refund via fallback (matching amount: ${stripeRefundAmount}). Updating stripeRefundId.`);
          // Back-fill the Stripe refund ID to ensure consistency
          await this.prisma.refund.update({
            where: { id: localRefund.id },
            data: { stripeRefundId: refunds[0].id },
          });
        }
      }
    }

    if (!localRefund) {
      this.logger.warn(`No pending local Refund record found matching Stripe refund IDs: ${stripeRefundIds.join(', ')}`);
      return;
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        // Fetch the fresh payment record to get live status and version
        const livePayment = await tx.payment.findUnique({
          where: { id: payment.id },
        });

        if (!livePayment) {
          throw new NotFoundException(`Payment ${payment.id} not found during webhook processing`);
        }

        // 1. Update Refund status to SUCCEEDED
        await tx.refund.update({
          where: { id: localRefund.id },
          data: { status: RefundStatus.SUCCEEDED },
        });

        // Calculate remaining refundable balance
        const allSucceededRefunds = await tx.refund.findMany({
          where: {
            paymentId: payment.id,
            status: RefundStatus.SUCCEEDED,
          },
        });
        const totalRefunded = allSucceededRefunds.reduce((sum, r) => sum + r.amount, 0);
        const remainingBalance = payment.amount - totalRefunded;

        // Transition Payment status to REFUNDED (if remaining balance is 0) or PARTIALLY_REFUNDED (if > 0)
        const nextPaymentStatus = remainingBalance === 0 ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED;

        // Enforce transition using live payment status
        enforceTransition(livePayment.status, nextPaymentStatus);

        // Update Payment status using live version for optimistic locking
        await tx.payment.update({
          where: { id: payment.id, version: livePayment.version },
          data: {
            status: nextPaymentStatus,
            version: { increment: 1 },
          },
        });

        // 2. Call ledgerService.recordRefundLedger to write reversing entries
        await this.ledgerService.recordRefundLedger(
          payment.id,
          localRefund.amount,
          payment.currency,
          tx
        );

        // 3. Create PaymentEvent
        await tx.paymentEvent.create({
          data: {
            paymentId: payment.id,
            stripeEventId: event.id,
            eventType: event.type,
            previousStatus: livePayment.status,
            newStatus: nextPaymentStatus,
            amount: localRefund.amount,
            source: 'WEBHOOK',
            createdBy: 'STRIPE_WEBHOOK',
          },
        });

        // 4. Audit Log
        await this.auditService.createLog(tx, {
          userId: payment.bookingIntent.userId,
          action: 'refund_completed',
          resourceType: 'Payment',
          resourceId: payment.id,
          metadata: {
            paymentId: payment.id,
            refundId: localRefund.id,
            stripeEventId: event.id,
            remainingBalance,
          },
        });
      });

      this.logger.log(`Successfully completed webhook transition for Refund ${localRefund.id} (Payment ${payment.id})`);
    } catch (err: any) {
      this.logger.error(`Failed to handle charge.refunded for Payment ${payment.id}: ${err.message}`, err.stack);
      throw err;
    }
  }

  /**
   * Handles charge.dispute.created
   */
  private async handleDisputeCreated(
    event: Stripe.Event,
    payment: any,
    dispute: Stripe.Dispute
  ): Promise<void> {
    const nextStatus = PaymentStatus.DISPUTED;

    if (payment.status === PaymentStatus.DISPUTED) {
      this.logger.log(`Payment ${payment.id} is already DISPUTED. Skipping.`);
      return;
    }

    if (!canTransition(payment.status, nextStatus)) {
      const alertMsg = `[ALERT] Cannot transition payment ${payment.id} from status ${payment.status} to ${nextStatus}. Dropping dispute event.`;
      this.logger.warn(alertMsg);
      console.warn(alertMsg);
      return;
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        const livePayment = await tx.payment.findUnique({ where: { id: payment.id } });

        if (!livePayment) {
          throw new NotFoundException(`Payment ${payment.id} not found during webhook processing`);
        }

        if (livePayment.status === nextStatus) return;

        enforceTransition(livePayment.status, nextStatus);

        // 1. Update Payment status to DISPUTED and store preDisputeStatus
        await tx.payment.update({
          where: { id: payment.id, version: livePayment.version },
          data: {
            status: nextStatus,
            preDisputeStatus: livePayment.status,
            version: { increment: 1 },
          },
        });

        // 2. Create PaymentEvent
        await tx.paymentEvent.create({
          data: {
            paymentId: payment.id,
            stripeEventId: event.id,
            eventType: event.type,
            previousStatus: payment.status,
            newStatus: nextStatus,
            amount: payment.amount,
            source: 'WEBHOOK',
            createdBy: 'STRIPE_WEBHOOK',
          },
        });

        // 3. Audit Log
        await this.auditService.createLog(tx, {
          userId: payment.bookingIntent.userId,
          action: 'dispute_opened',
          resourceType: 'Payment',
          resourceId: payment.id,
          metadata: {
            paymentId: payment.id,
            stripeEventId: event.id,
            disputeId: dispute.id,
          },
        });
      });

      this.logger.log(`Successfully transitioned Payment ${payment.id} to DISPUTED via webhook`);
    } catch (err: any) {
      this.logger.error(`Failed to handle charge.dispute.created for Payment ${payment.id}: ${err.message}`, err.stack);
      throw err;
    }
  }

  /**
   * Handles charge.dispute.closed
   */
  private async handleDisputeClosed(
    event: Stripe.Event,
    payment: any,
    dispute: Stripe.Dispute
  ): Promise<void> {
    if (payment.status !== PaymentStatus.DISPUTED) {
      this.logger.warn(`Dispute closed webhook received but payment ${payment.id} is in status ${payment.status} (expected DISPUTED). Skipping.`);
      return;
    }

    const preDisputeStatus = payment.preDisputeStatus as PaymentStatus;
    if (!preDisputeStatus) {
      const alertMsg = `[ALERT] Dispute closed webhook received for payment ${payment.id} but preDisputeStatus is missing.`;
      this.logger.error(alertMsg);
      console.error(alertMsg);
      return;
    }

    const outcome = dispute.status === 'won' ? 'won' : 'lost';
    const nextStatus = resolveDisputeStatus(outcome, preDisputeStatus);

    if (outcome === 'lost') {
      const alertMsg = `[ALERT] Payment dispute lost for paymentId=${payment.id}, stripePaymentIntentId=${payment.stripePaymentIntentId}. Dispute status: ${dispute.status}`;
      this.logger.warn(alertMsg);
      console.warn(alertMsg);
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        const livePayment = await tx.payment.findUnique({ where: { id: payment.id } });

        if (!livePayment) {
          throw new NotFoundException(`Payment ${payment.id} not found during webhook processing`);
        }

        if (livePayment.status === nextStatus) return;

        // 1. Update Payment status
        await tx.payment.update({
          where: { id: payment.id, version: livePayment.version },
          data: {
            status: nextStatus,
            version: { increment: 1 },
          },
        });

        // 2. Create PaymentEvent
        await tx.paymentEvent.create({
          data: {
            paymentId: payment.id,
            stripeEventId: event.id,
            eventType: event.type,
            previousStatus: payment.status,
            newStatus: nextStatus,
            amount: payment.amount,
            source: 'WEBHOOK',
            createdBy: 'STRIPE_WEBHOOK',
          },
        });

        // 3. Audit Log
        await this.auditService.createLog(tx, {
          userId: payment.bookingIntent.userId,
          action: outcome === 'won' ? 'dispute_won' : 'dispute_lost',
          resourceType: 'Payment',
          resourceId: payment.id,
          metadata: {
            paymentId: payment.id,
            stripeEventId: event.id,
            disputeId: dispute.id,
            disputeStatus: dispute.status,
          },
        });
      });

      this.logger.log(`Successfully completed webhook transition for dispute closed to ${nextStatus} for Payment ${payment.id}`);
    } catch (err: any) {
      this.logger.error(`Failed to handle charge.dispute.closed for Payment ${payment.id}: ${err.message}`, err.stack);
      throw err;
    }
  }
}
