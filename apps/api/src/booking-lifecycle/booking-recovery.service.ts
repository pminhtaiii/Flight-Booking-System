import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BookingStatus, RefundStatus, RefundTriggerType } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { StripeService } from '@/common/stripe.service';
import { DuffelService } from '@/duffel/duffel.service';
import { RefundTransactionService } from '@/refund/refund-transaction.service';
import { RefundSettlementService } from '@/refund-settlement/refund-settlement.service';
import { BookingAgentProjectionService } from '@/agent-gateway/booking-agent-projection.service';
import { BookingLifecycleService } from './booking-lifecycle.service';
import { BookingWithRelations } from './booking-lifecycle.types';

function enrichRedactedDuffelOrder(duffelOrder: any, dbPassengers: any[], userEmail: string): any {
  if (!duffelOrder) return duffelOrder;
  const copy = JSON.parse(JSON.stringify(duffelOrder));
  if (Array.isArray(copy.passengers)) {
    copy.passengers.forEach((p: any, i: number) => {
      const dbPass =
        dbPassengers.find((dbp: any) => dbp.duffelPassengerId === p.id) || dbPassengers[i];
      if (dbPass) {
        if (!p.given_name || p.given_name === 'REDACTED') {
          p.given_name = dbPass.givenName;
        }
        if (!p.family_name || p.family_name === 'REDACTED') {
          p.family_name = dbPass.familyName;
        }
        if (dbPass.dateOfBirth && (!p.born_on || p.born_on === 'REDACTED')) {
          const d = new Date(dbPass.dateOfBirth);
          if (!isNaN(d.getTime())) {
            p.born_on = d.toISOString().split('T')[0];
          }
        }
      }
      if (!p.email || p.email === 'REDACTED') {
        p.email = userEmail;
      }
    });
  }
  return copy;
}

@Injectable()
export class BookingRecoveryService {
  private readonly logger = new Logger(BookingRecoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
    private readonly duffelService: DuffelService,
    private readonly refundTransactionService: RefundTransactionService,
    private readonly refundSettlementService: RefundSettlementService,
    private readonly bookingLifecycleService: BookingLifecycleService,
    @Optional() private readonly bookingAgentProjectionService?: BookingAgentProjectionService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async sweepStaleBookings(): Promise<void> {
    this.logger.log('Running stale PROCESSING bookings sweeper');
    const staleThreshold = new Date(Date.now() - 15 * 60 * 1000);
    const staleBookings = await this.prisma.booking.findMany({
      where: {
        status: BookingStatus.PROCESSING,
        createdAt: { lte: staleThreshold },
      },
      include: {
        payment: {
          include: {
            ancillarySelection: {
              include: {
                seatSelections: true,
                baggageSelections: true,
              },
            },
          },
        },
        bookingIntent: {
          include: {
            passengers: true,
          },
        },
        activeDisruptionRevision: {
          include: {
            segments: { orderBy: { globalOrder: 'asc' } },
            notificationOutbox: true,
          },
        },
        itineraryRevisions: {
          orderBy: { version: 'desc' },
          take: 1,
          include: { segments: { orderBy: { globalOrder: 'asc' } } },
        },
      },
    });

    for (const booking of staleBookings) {
      try {
        await this.reconcileBookingIfStale(booking as unknown as BookingWithRelations);
      } catch (e: any) {
        this.logger.error(`Failed to reconcile stale booking ${booking.id}: ${e.message}`, e.stack);
      }
    }
  }

  @Cron(CronExpression.EVERY_30_MINUTES)
  async sweepUncompletedBookings(): Promise<void> {
    this.logger.log('Running CONFIRMED -> COMPLETED bookings sweeper');
    const pastBookings = await this.prisma.booking.findMany({
      where: {
        status: BookingStatus.CONFIRMED,
        departureAt: { lte: new Date() },
      },
      include: {
        payment: {
          include: {
            ancillarySelection: {
              include: {
                seatSelections: true,
                baggageSelections: true,
              },
            },
          },
        },
        bookingIntent: {
          include: {
            passengers: true,
          },
        },
        activeDisruptionRevision: {
          include: {
            segments: { orderBy: { globalOrder: 'asc' } },
            notificationOutbox: true,
          },
        },
        itineraryRevisions: {
          orderBy: { version: 'desc' },
          take: 1,
          include: { segments: { orderBy: { globalOrder: 'asc' } } },
        },
      },
    });

    for (const booking of pastBookings) {
      try {
        await this.bookingLifecycleService.checkAndCompleteBooking(
          booking as unknown as BookingWithRelations,
        );
      } catch (e: any) {
        this.logger.error(`Failed to complete booking ${booking.id}: ${e.message}`, e.stack);
      }
    }
  }

  async reconcileBookingIfStale(booking: BookingWithRelations): Promise<BookingWithRelations> {
    if (booking.status !== BookingStatus.PROCESSING) return booking;

    const staleThreshold = new Date(Date.now() - 15 * 60 * 1000);
    if (booking.createdAt > staleThreshold) {
      return booking;
    }

    try {
      const withTimeout = <T>(promise: Promise<T>, ms = 3000): Promise<T> => {
        let timeoutHandle: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error('Timeout')), ms);
        });
        return Promise.race([promise, timeoutPromise]).finally(() => {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
        });
      };

      if (!booking.payment?.stripePaymentIntentId) {
        const res = await this.prisma.booking.updateMany({
          where: { id: booking.id, status: BookingStatus.PROCESSING },
          data: { status: BookingStatus.FAILED, failureReason: 'BOOKING_TIMEOUT' },
        });
        if (res.count > 0) {
          booking.status = BookingStatus.FAILED;
          booking.failureReason = 'BOOKING_TIMEOUT';
          await this.bookingAgentProjectionService?.updateProjectionStatus(
            booking.id,
            BookingStatus.FAILED,
          );
        }
        return booking;
      }

      const intent = await withTimeout(
        this.stripeService.retrievePaymentIntent(booking.payment.stripePaymentIntentId),
      );
      if (intent.status !== 'succeeded') {
        try {
          const duffelEvent = await this.prisma.paymentEvent.findFirst({
            where: { paymentId: booking.payment.id, eventType: 'duffel_order_created' },
            orderBy: { createdAt: 'desc' },
          });
          const duffelOrder = duffelEvent?.metadata as Record<string, unknown> | null;
          if (duffelOrder && typeof duffelOrder.id === 'string') {
            await this.duffelService.cancelOrder(duffelOrder.id);
            this.logger.log(
              `Successfully cancelled orphaned Duffel order ${duffelOrder.id} during stale booking sweep.`,
            );
          }
        } catch (cancelError: unknown) {
          const err = cancelError instanceof Error ? cancelError : new Error(String(cancelError));
          this.logger.error(
            `Duffel order cancellation failed during stale booking sweep: ${err.message}`,
            err.stack,
          );
        }

        // Release the Stripe authorization hold (cancel intent)
        try {
          await this.stripeService.cancelPaymentIntent(booking.payment.stripePaymentIntentId);
          this.logger.log(
            `Successfully cancelled Stripe PaymentIntent ${booking.payment.stripePaymentIntentId} during stale booking sweep.`,
          );
        } catch (stripeCancelError: unknown) {
          const err = stripeCancelError instanceof Error ? stripeCancelError : new Error(String(stripeCancelError));
          this.logger.error(
            `Stripe cancelPaymentIntent failed during stale booking sweep: ${err.message}`,
            err.stack,
          );
        }

        const res = await this.prisma.booking.updateMany({
          where: { id: booking.id, status: BookingStatus.PROCESSING },
          data: { status: BookingStatus.FAILED, failureReason: 'CAPTURE_FAILED' },
        });
        if (res.count > 0) {
          booking.status = BookingStatus.FAILED;
          booking.failureReason = 'CAPTURE_FAILED';
          // Advance Payment to CANCELLED so downstream guards don't attempt a second cancellation.
          await this.prisma.payment.updateMany({
            where: { id: booking.payment.id, status: { notIn: ['CANCELLED', 'REFUNDED'] } },
            data: { status: 'CANCELLED' },
          });
          await this.bookingAgentProjectionService?.updateProjectionStatus(
            booking.id,
            BookingStatus.FAILED,
          );
        }
        return booking;
      }

      const duffelEvent = await this.prisma.paymentEvent.findFirst({
        where: { paymentId: booking.payment.id, eventType: 'duffel_order_created' },
        orderBy: { createdAt: 'desc' },
      });

      const rawOrder = duffelEvent?.metadata as any;
      if (rawOrder && rawOrder.id) {
        const bookingIntent = await this.prisma.bookingIntent.findUnique({
          where: { id: booking.bookingIntentId },
          include: { passengers: true, user: true },
        });
        const order =
          bookingIntent && bookingIntent.user
            ? enrichRedactedDuffelOrder(rawOrder, bookingIntent.passengers, bookingIntent.user.email)
            : rawOrder;

        const { flightSnapshot, passengerSnapshot } =
          this.duffelService.mapDuffelOrderToSnapshots(order);
        const departureAt = flightSnapshot.segments?.[0]?.departureAt
          ? new Date(flightSnapshot.segments[0].departureAt)
          : null;

        const res = await this.prisma.booking.updateMany({
          where: { id: booking.id, status: BookingStatus.PROCESSING },
          data: {
            status: BookingStatus.CONFIRMED,
            pnrReference: order.booking_reference || null,
            duffelOrderId: order.id,
            flightSnapshot: flightSnapshot as any,
            passengerSnapshot: passengerSnapshot as any,
            departureAt: departureAt,
          },
        });
        if (res.count > 0) {
          booking.status = BookingStatus.CONFIRMED;
          booking.pnrReference = order.booking_reference || null;
          booking.duffelOrderId = order.id;
          booking.flightSnapshot = flightSnapshot as any;
          booking.passengerSnapshot = passengerSnapshot as any;
          booking.departureAt = departureAt;
          // Advance Payment to SUCCEEDED to match the captured Stripe intent.
          await this.prisma.payment.updateMany({
            where: {
              id: booking.payment.id,
              status: { notIn: ['SUCCEEDED', 'REFUNDED', 'CANCELLED'] },
            },
            data: { status: 'SUCCEEDED' },
          });
          await this.bookingAgentProjectionService?.createOrUpdateProjection(booking.id);
        }
      } else {
        const res = await this.prisma.booking.updateMany({
          where: { id: booking.id, status: BookingStatus.PROCESSING },
          data: { status: BookingStatus.FAILED, failureReason: 'SYSTEM_ERROR' },
        });
        if (res.count > 0) {
          booking.status = BookingStatus.FAILED;
          booking.failureReason = 'SYSTEM_ERROR';
          await this.bookingAgentProjectionService?.updateProjectionStatus(
            booking.id,
            BookingStatus.FAILED,
          );

          try {
            await withTimeout(
              this.triggerAutomatedRefund(
                booking.payment.id,
                'Stale processing booking timeout without duffel order',
              ),
            );
          } catch (e: unknown) {
            const err = e instanceof Error ? e : new Error(String(e));
            this.logger.error(
              `CRITICAL: Automated refund failed during stale booking reconciliation for payment ${booking.payment.id}: ${err.message}`,
              err.stack,
            );
          }
        }
      }
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      this.logger.error(
        `Error during stale booking reconciliation for ${booking.id}: ${err.message}`,
        err.stack,
      );
      throw e;
    }
    return booking;
  }

  private async triggerAutomatedRefund(paymentId: string, reason: string): Promise<void> {
    const idempotencyKey = `refund:${paymentId}:${reason}:1`;

    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });

    if (!payment) {
      this.logger.warn(`Payment ${paymentId} not found for automated refund`);
      return;
    }

    const succeededRefunds = await this.prisma.refund.findMany({
      where: { paymentId, status: RefundStatus.SUCCEEDED },
      select: { amount: true },
    });

    const totalRefunded = succeededRefunds.reduce((sum, r) => sum + r.amount, 0);
    const refundableAmount = payment.amount - totalRefunded;

    if (refundableAmount <= 0) {
      this.logger.warn(`No refundable amount remaining for payment ${paymentId}`);
      return;
    }

    const refund = await this.refundTransactionService.reserveTransaction({
      kind: 'DIRECT',
      paymentId,
      amount: refundableAmount,
      currency: payment.currency,
      reason,
      triggerType: RefundTriggerType.SYSTEM_AUTOMATED,
      idempotencyKey,
    });

    if (refund.status === RefundStatus.SUCCEEDED) {
      return;
    }

    let stripeRefund: { id: string };
    try {
      stripeRefund = await this.stripeService.createRefund(
        payment.stripePaymentIntentId,
        refundableAmount,
        reason,
        `${idempotencyKey}-stripe-refund`,
      );
    } catch (stripeError) {
      const safeErrorCode = this.toSafeStripeErrorCode(stripeError);
      await this.refundSettlementService.settleVerifiedOutcome({
        transactionId: refund.id,
        money: { amount: refundableAmount, currency: payment.currency },
        outcome: {
          status: 'FAILED',
          errorCode: safeErrorCode,
          occurredAt: new Date().toISOString(),
        },
        provenance: {
          source: 'INLINE',
        },
      });
      throw stripeError;
    }

    await this.refundSettlementService.settleVerifiedOutcome({
      transactionId: refund.id,
      money: { amount: refundableAmount, currency: payment.currency },
      outcome: {
        status: 'SUCCEEDED',
        providerReference: stripeRefund.id,
        occurredAt: new Date().toISOString(),
      },
      provenance: {
        source: 'INLINE',
      },
    });
  }

  private toSafeStripeErrorCode(error: unknown): string {
    if (typeof error !== 'object' || error === null) return 'STRIPE_UNKNOWN_ERROR';
    const candidate = error as { statusCode?: unknown; code?: unknown };
    if (typeof candidate.code === 'string' && /^[A-Z0-9_:-]{1,80}$/.test(candidate.code))
      return candidate.code;
    if (typeof candidate.statusCode === 'number') return `HTTP_${candidate.statusCode}`;
    return 'STRIPE_UNKNOWN_ERROR';
  }
}
