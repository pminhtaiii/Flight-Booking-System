import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  HttpStatus,
  HttpException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { StripeService } from '@/common/stripe.service';
import { PaymentIdempotencyService } from '@/payment/payment-idempotency.service';
import { DuffelService } from '@/duffel/duffel.service';
import { AuditService } from '@/audit/audit.service';
import { PaymentMethodService } from '@/payment/payment-method.service';
import { CreatePaymentDto } from '@/payment/dto/create-payment.dto';
import { ConfirmPaymentDto } from '@/payment/dto/confirm-payment.dto';
import { PaymentResponseDto } from '@/payment/dto/payment-response.dto';
import { enforceTransition } from '@/payment/payment-state-machine';
import * as crypto from 'crypto';
import { Prisma, BookingFailureReason } from '@prisma/client';

import { BookingService } from '@/booking/booking.service';
import { forwardRef, Inject } from '@nestjs/common';
import { AncillaryPaymentValidationService } from './ancillary-payment-validation.service';

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
    private readonly idempotencyService: PaymentIdempotencyService,
    private readonly duffelService: DuffelService,
    private readonly auditService: AuditService,
    private readonly paymentMethodService: PaymentMethodService,
    @Inject(forwardRef(() => BookingService))
    private readonly bookingService: BookingService,
    private readonly ancillaryPaymentValidationService: AncillaryPaymentValidationService,
  ) {}

  /**
   * Core Payment Pipeline: Create & Authorize
   */
  async createPayment(
    dto: CreatePaymentDto,
    idempotencyKey: string,
    userId: string,
    ipAddress: string,
  ): Promise<PaymentResponseDto> {
    try {
      // 1. Check/acquire the request idempotency key
      const requestHash = this.idempotencyService.computeHash(dto);
      const idempotency = await this.idempotencyService.acquireOrReplay(
        idempotencyKey,
        requestHash,
        userId,
        '/api/bookings/payment/create',
      );

      if (idempotency.status === 'replay') {
        return JSON.parse(idempotency.responseBody);
      }

      // 2. Lock & update BookingIntent paymentAttemptCount inside transaction
      const intent = await this.prisma.bookingIntent.findUnique({
        where: { id: dto.bookingIntentId },
        select: {
          id: true,
          status: true,
          paymentAttemptCount: true,
          confirmedPrice: true,
          currency: true,
          userId: true,
          currentAncillarySelectionId: true,
          ancillaryVersion: true,
        },
      });

      if (!intent) {
        throw new NotFoundException('Booking intent not found');
      }

      if (intent.userId !== userId) {
        throw new ForbiddenException('You do not own this booking intent');
      }

      if (intent.status !== 'PENDING' && intent.status !== 'AWAITING_PAYMENT') {
        throw new BadRequestException('Booking intent is not in an allowed status for payment');
      }

      if (intent.paymentAttemptCount >= 2) {
        throw new BadRequestException('Payment attempts exhausted');
      }

      const targetAncillarySelectionId = dto.ancillarySelectionId || intent.currentAncillarySelectionId;
      const targetAncillarySelectionVersion = dto.ancillarySelectionVersion ?? intent.ancillaryVersion;

      let validated: Awaited<ReturnType<AncillaryPaymentValidationService['validateForPayment']>> | null = null;
      let amountInCents: number;

      if (
        targetAncillarySelectionId &&
        targetAncillarySelectionVersion !== null &&
        targetAncillarySelectionVersion !== undefined &&
        targetAncillarySelectionVersion > 0
      ) {
        validated = await this.ancillaryPaymentValidationService.validateForPayment({
          userId,
          bookingIntentId: dto.bookingIntentId,
          ancillarySelectionId: targetAncillarySelectionId,
          ancillarySelectionVersion: targetAncillarySelectionVersion,
        });
        amountInCents = Math.round(Number(validated.grandTotal) * 100);
      } else {
        amountInCents = Math.round(Number(intent.confirmedPrice) * 100);
      }

      const result = await this.prisma.$transaction(async (tx) => {
        interface RawBookingIntent {
          id: string;
          status: string;
          paymentAttemptCount: number;
          confirmedPrice: number;
          currency: string;
          userId: string;
          currentAncillarySelectionId: string | null;
          ancillaryVersion: number;
        }

        const intents = await tx.$queryRaw<RawBookingIntent[]>`
          SELECT id, status, "paymentAttemptCount", "confirmedPrice", currency, "userId", "currentAncillarySelectionId", "ancillaryVersion"
          FROM booking_intents
          WHERE id = ${dto.bookingIntentId}
          FOR UPDATE
        `;

        if (intents.length === 0) {
          throw new NotFoundException('Booking intent not found');
        }

        const txIntent = intents[0];
        if (txIntent.userId !== userId) {
          throw new ForbiddenException('You do not own this booking intent');
        }

        if (txIntent.status !== 'PENDING' && txIntent.status !== 'AWAITING_PAYMENT') {
          throw new BadRequestException('Booking intent is not in an allowed status for payment');
        }

        const existingPayment = await tx.payment.findFirst({
          where: {
            idempotencyKey: {
              key: idempotencyKey,
            },
          },
        });

        if (existingPayment) {
          return {
            confirmedPrice: Number(txIntent.confirmedPrice),
            currency: txIntent.currency,
            attemptNumber: existingPayment.attemptNumber,
          };
        }

        if (txIntent.paymentAttemptCount >= 2) {
          throw new BadRequestException('Payment attempts exhausted');
        }

        const nextAttemptCount = txIntent.paymentAttemptCount + 1;
        await tx.$executeRaw`
          UPDATE booking_intents
          SET "paymentAttemptCount" = ${nextAttemptCount}, status = 'AWAITING_PAYMENT'
          WHERE id = ${dto.bookingIntentId}
        `;

        if (validated) {
          if (
            txIntent.currentAncillarySelectionId !== validated.selectionId ||
            txIntent.ancillaryVersion !== validated.selectionVersion
          ) {
            throw new ConflictException({
              code: 'ANCILLARY_VERSION_CONFLICT',
              intentId: dto.bookingIntentId,
              currentVersion: txIntent.ancillaryVersion,
              message: 'Ancillary selection was updated after validation. Please revalidate before payment.',
            });
          }
        }

        return {
          confirmedPrice: Number(txIntent.confirmedPrice),
          currency: txIntent.currency,
          attemptNumber: nextAttemptCount,
        };
      });

      // 3. Lazy create Stripe Customer
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, stripeCustomerId: true },
      });

      if (!user) {
        throw new NotFoundException('User not found');
      }

      let stripeCustomerId = user.stripeCustomerId;
      if (!stripeCustomerId) {
        const customer = await this.stripeService.createCustomer(
          user.email,
          undefined,
          `customer-create:${userId}`,
        );
        stripeCustomerId = customer.id;

        const updateResult = await this.prisma.user.updateMany({
          where: {
            id: userId,
            stripeCustomerId: null,
          },
          data: {
            stripeCustomerId,
          },
        });

        if (updateResult.count === 0) {
          const refreshedUser = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { stripeCustomerId: true },
          });
          stripeCustomerId = refreshedUser?.stripeCustomerId || stripeCustomerId;
        }
      }

      // 4. Create Stripe PaymentIntent
      const paymentIntent = await this.stripeService.createPaymentIntent(
        amountInCents,
        result.currency,
        stripeCustomerId,
        { bookingIntentId: dto.bookingIntentId },
        `${idempotencyKey}-stripe-intent`,
        dto.paymentMethodId,
        dto.saveCard ? 'off_session' : undefined,
      );

      // 5. Create Payment record in DB
      const keyRecord = await this.prisma.idempotencyKey.findUnique({
        where: { key: idempotencyKey },
        select: { id: true },
      });
      if (!keyRecord) {
        throw new InternalServerErrorException('Idempotency key record not found');
      }

      let payment = await this.prisma.payment.findFirst({
        where: {
          idempotencyKeyId: keyRecord.id,
        },
      });

      if (!payment) {
        payment = await this.prisma.$transaction(async (tx) => {
          const createdPayment = await tx.payment.create({
            data: {
              bookingIntentId: dto.bookingIntentId,
              attemptNumber: result.attemptNumber,
              idempotencyKeyId: keyRecord.id,
              stripePaymentIntentId: paymentIntent.id,
              stripeCustomerId,
              amount: amountInCents,
              currency: result.currency.toLowerCase(),
              status: 'CREATED',
              ancillarySelectionId: validated?.selectionId ?? null,
              ancillarySelectionVersion: validated?.selectionVersion ?? null,
            },
          });

          if (validated) {
            await tx.ancillarySelection.updateMany({
              where: {
                id: validated.selectionId,
                bookingIntentId: dto.bookingIntentId,
                version: validated.selectionVersion,
              },
              data: { status: 'PAYMENT_BOUND' },
            });
          }

          return createdPayment;
        });
      }

      // 6. Log event and audit
      await this.prisma.paymentEvent.create({
        data: {
          paymentId: payment.id,
          eventType: 'payment_created',
          previousStatus: 'CREATED',
          newStatus: 'CREATED',
          amount: amountInCents,
          source: 'API',
          createdBy: userId,
        },
      });

      await this.auditService.createLog(this.prisma, {
        userId,
        action: 'payment_created',
        resourceType: 'Payment',
        resourceId: payment.id,
        ipAddress,
        metadata: {
          bookingIntentId: dto.bookingIntentId,
          amount: amountInCents,
          attemptNumber: result.attemptNumber,
        },
      });

      // 7. Update recovery point and complete idempotency key
      await this.idempotencyService.updateRecoveryPoint(idempotencyKey, 'started');

      const responseBody = {
        paymentId: payment.id,
        clientSecret: paymentIntent.client_secret || '',
        status: payment.status,
      };

      await this.idempotencyService.completeKey(idempotencyKey, HttpStatus.CREATED, responseBody);

      return responseBody;
    } catch (error) {
      this.logger.error(`Error in createPayment: ${error instanceof Error ? error.message : String(error)}`, error instanceof Error ? error.stack : undefined);
      throw error;
    }
  }

  /**
   * Core Payment Pipeline: Confirm & Capture (with Tiered Timeout Escalation)
   */
  async confirmPayment(
    dto: ConfirmPaymentDto,
    idempotencyKey: string,
    userId: string,
  ): Promise<unknown> {
    let isFinished = false;
    const confirmPromise = (async () => {
      try {
        const result = await this.executeConfirmPayment(dto, idempotencyKey, userId);
        isFinished = true;
        return result;
      } catch (error) {
        isFinished = true;
        throw error;
      }
    })();

    const timeoutPromise = new Promise<{ isTimeout: true }>((resolve) => {
      setTimeout(() => resolve({ isTimeout: true }), 25000);
    });

    const result = await Promise.race([confirmPromise, timeoutPromise]);

    if (
      result &&
      typeof result === 'object' &&
      'isTimeout' in result &&
      (result as { isTimeout: boolean }).isTimeout &&
      !isFinished
    ) {
      this.logger.log(`confirmPayment hit Tier 2 timeout (25s). Handoff to async polling.`);
      
      confirmPromise.catch((err) => {
        this.logger.error(
          `Background confirmPayment execution failed for payment ${dto.paymentId}: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err.stack : undefined
        );
        this.handleBackgroundError(dto.paymentId, idempotencyKey, userId, err).catch((dbErr) => {
          this.logger.error(`Failed to execute background error recovery: ${dbErr.message}`, dbErr.stack);
        });
      });

      return {
        status: 'PENDING',
        message: 'Booking is being confirmed. Please poll status.',
        pollUrl: `/api/bookings/payment/${dto.paymentId}/status`,
      };
    }

    return result;
  }

  async executeConfirmPayment(
    dto: ConfirmPaymentDto,
    idempotencyKey: string,
    userId: string,
  ): Promise<unknown> {
    try {
      // 1. Check/acquire the request idempotency key
      const requestHash = this.idempotencyService.computeHash(dto);
      const idempotency = await this.idempotencyService.acquireOrReplay(
        idempotencyKey,
        requestHash,
        userId,
        '/api/bookings/payment/confirm',
      );

      if (idempotency.status === 'replay') {
        return JSON.parse(idempotency.responseBody);
      }

      // 2. Query payment
      let payment = await this.prisma.payment.findUnique({
        where: { id: dto.paymentId },
        include: {
          bookingIntent: true,
          ancillarySelection: {
            include: {
              seatSelections: true,
              baggageSelections: {
                include: {
                  segments: true,
                },
              },
            },
          },
        },
      });

      if (!payment) {
        throw new NotFoundException('Payment record not found');
      }

      if (payment.bookingIntent.userId !== userId) {
        throw new ForbiddenException('You do not own this payment');
      }

      // 3. Create canonical booking in PROCESSING state
      const canonicalBooking = await this.bookingService.createBooking(
        userId,
        dto.bookingId,
        payment.bookingIntentId,
        payment.id
      );

      if (canonicalBooking.userId !== userId) {
         throw new ForbiddenException('You do not own this booking');
      }

      // 4. Resume from recovery point
      let recoveryPoint = await this.idempotencyService.getResumePoint(idempotencyKey);
      if (!recoveryPoint) {
        recoveryPoint = 'started';
      }

      if (recoveryPoint === 'completed') {
        if (payment.status === 'SUCCEEDED') {
          const duffelEvent = await this.prisma.paymentEvent.findFirst({
            where: {
              paymentId: payment.id,
              eventType: 'duffel_order_created',
            },
            orderBy: { createdAt: 'desc' },
          });

          const duffelOrder = duffelEvent?.metadata as Record<string, unknown> | null;
          if (!duffelOrder) {
            throw new InternalServerErrorException('Duffel order details not found in payment history.');
          }

          const successResponse = {
            success: true,
            paymentId: payment.id,
            status: 'SUCCEEDED',
            bookingReference: duffelOrder.booking_reference as string,
            duffelOrderId: duffelOrder.id as string,
          };

          await this.idempotencyService.completeKey(idempotencyKey, HttpStatus.OK, successResponse);
          return successResponse;
        } else {
          const duffelEvent = await this.prisma.paymentEvent.findFirst({
            where: {
              paymentId: payment.id,
              eventType: 'duffel_order_created',
            },
            orderBy: { createdAt: 'desc' },
          });

          const errorMsg = duffelEvent
            ? 'Stripe capture failed or background processing failed. Duffel order cancelled and hold released.'
            : 'Duffel booking failed. Payment hold released.';

          const bookingIntent = await this.prisma.bookingIntent.findUnique({
            where: { id: payment.bookingIntentId },
          });

          const failureResponse = {
            success: false,
            error: errorMsg,
            bookingStatus: bookingIntent?.status || 'CANCELLED',
          };

          await this.idempotencyService.completeKey(idempotencyKey, HttpStatus.BAD_GATEWAY, failureResponse);
          return failureResponse;
        }
      }

      // Step 1: Authorization Validation
      if (recoveryPoint === 'started') {
        const paymentIntent = await this.stripeService.retrievePaymentIntent(payment.stripePaymentIntentId);
        
        if (paymentIntent.status === 'requires_capture') {
          if (payment.status === 'CREATED') {
            enforceTransition(payment.status, 'AUTHORIZED');
            const pId = payment.id;
            const pStatus = payment.status;
            const pAmount = payment.amount;
            await this.prisma.$transaction(async (tx) => {
              await tx.payment.update({
                where: { id: pId },
                data: { status: 'AUTHORIZED' },
              });
              await tx.paymentEvent.create({
                data: {
                  paymentId: pId,
                  eventType: 'payment_authorized',
                  previousStatus: pStatus,
                  newStatus: 'AUTHORIZED',
                  amount: pAmount,
                  source: 'API',
                  createdBy: userId,
                },
              });
            });

            payment = { ...payment, status: 'AUTHORIZED' };

            await this.auditService.createLog(this.prisma, {
              userId,
              action: 'payment_authorized',
              resourceType: 'Payment',
              resourceId: payment.id,
              metadata: { stripePaymentIntentId: payment.stripePaymentIntentId },
            });
          }
        } else if (paymentIntent.status !== 'succeeded') {
          throw new BadRequestException(`Stripe PaymentIntent is in invalid status: ${paymentIntent.status}`);
        }

        await this.idempotencyService.updateRecoveryPoint(idempotencyKey, 'stripe_authorized');
        recoveryPoint = 'stripe_authorized';
      }

      // Step 2: Duffel Order Booking
      if (recoveryPoint === 'stripe_authorized') {
        const bookingIntent = await this.prisma.bookingIntent.findUnique({
          where: { id: payment.bookingIntentId },
          include: { passengers: true },
        });

        if (!bookingIntent) {
          throw new NotFoundException('Booking intent not found');
        }

        const servicesMap = new Map<string, number>();
        if (payment.ancillarySelection) {
          for (const seat of payment.ancillarySelection.seatSelections) {
            servicesMap.set(seat.serviceId, (servicesMap.get(seat.serviceId) ?? 0) + 1);
          }
          for (const baggage of payment.ancillarySelection.baggageSelections) {
            servicesMap.set(
              baggage.serviceId,
              (servicesMap.get(baggage.serviceId) ?? 0) + baggage.quantity,
            );
          }
        }
        const services: Array<{ id: string; quantity: number }> = Array.from(
          servicesMap.entries(),
        ).map(([id, quantity]) => ({ id, quantity }));

        let duffelOrder: unknown;
        try {
          duffelOrder = await this.duffelService.createOrder(
            bookingIntent.duffelOfferId,
            bookingIntent.passengers,
            services.length > 0 ? services : undefined,
            { bookingIntentId: bookingIntent.id, paymentId: payment.id },
            idempotencyKey,
          );
        } catch (duffelError: unknown) {
          const error = duffelError as Error & { status?: number };
          this.logger.error(`Duffel booking failed: ${error.message}`, error.stack);

          // Cancel/Void Stripe authorization hold
          try {
            await this.stripeService.cancelPaymentIntent(payment.stripePaymentIntentId);
          } catch (stripeCancelError: unknown) {
            const stripeError = stripeCancelError as Error;
            this.logger.error(`Stripe cancelPaymentIntent failed: ${stripeError.message}`, stripeError.stack);
          }

          // Update Payment, BookingIntent, and Booking status atomically
          enforceTransition(payment.status, 'CANCELLED');
          const nextBookingStatus = bookingIntent.paymentAttemptCount < 2 ? 'AWAITING_PAYMENT' : 'CANCELLED';
          await this.prisma.$transaction(async (tx) => {
            await tx.payment.update({
              where: { id: payment.id },
              data: { status: 'CANCELLED' },
            });
            await tx.paymentEvent.create({
              data: {
                paymentId: payment.id,
                eventType: 'payment_cancelled',
                previousStatus: payment.status,
                newStatus: 'CANCELLED',
                amount: payment.amount,
                source: 'API',
                createdBy: userId,
              },
            });
            await tx.bookingIntent.update({
              where: { id: bookingIntent.id },
              data: { status: nextBookingStatus },
            });
            await this.bookingService.updateToFailed(
              canonicalBooking.id,
              BookingFailureReason.SYSTEM_ERROR,
              undefined,
              undefined,
              undefined,
              tx
            );
          });

          // Update recovery point to completed and complete idempotency key
          await this.idempotencyService.updateRecoveryPoint(idempotencyKey, 'completed');
          const failureResponse = {
            success: false,
            error: `Duffel booking failed: ${error.message || 'Unknown error'}. Payment hold released.`,
            bookingStatus: nextBookingStatus,
          };
          await this.idempotencyService.completeKey(idempotencyKey, HttpStatus.BAD_GATEWAY, failureResponse);

          throw new HttpException(failureResponse, HttpStatus.BAD_GATEWAY);
        }

        // Duffel order succeeded. Log it.
        await this.prisma.paymentEvent.create({
          data: {
            paymentId: payment.id,
            eventType: 'duffel_order_created',
            previousStatus: 'AUTHORIZED',
            newStatus: 'AUTHORIZED',
            amount: payment.amount,
            source: 'API',
            metadata: duffelOrder as Prisma.InputJsonValue,
            createdBy: userId,
          },
        });

        await this.idempotencyService.updateRecoveryPoint(idempotencyKey, 'duffel_order_created');
        recoveryPoint = 'duffel_order_created';
      }

      // Step 3: Stripe Capture
      if (recoveryPoint === 'duffel_order_created') {
        try {
          await this.stripeService.capturePaymentIntent(
            payment.stripePaymentIntentId,
            undefined,
            `${idempotencyKey}-stripe-capture`,
          );
        } catch (captureError: unknown) {
          const error = captureError as Error;
          this.logger.error(`Stripe capture failed: ${error.message}`, error.stack);

          // Duffel order cancellation compensation
          let duffelOrderId: string | undefined;
          try {
            const duffelEvent = await this.prisma.paymentEvent.findFirst({
              where: {
                paymentId: payment.id,
                eventType: 'duffel_order_created',
              },
              orderBy: { createdAt: 'desc' },
            });
            const duffelOrder = duffelEvent?.metadata as Record<string, unknown> | null;
            duffelOrderId = duffelOrder?.id as string | undefined;

            if (duffelOrderId) {
              await this.duffelService.cancelOrder(duffelOrderId);
              this.logger.log(`Successfully cancelled Duffel order ${duffelOrderId} as compensation.`);
            }
          } catch (cancelError: unknown) {
            const err = cancelError as Error;
            this.logger.error(`Duffel order cancellation failed during compensation: ${err.message}`, err.stack);
          }

          // Release the Stripe authorization hold (cancel intent)
          try {
            await this.stripeService.cancelPaymentIntent(payment.stripePaymentIntentId);
          } catch (stripeCancelError: unknown) {
            const stripeError = stripeCancelError as Error;
            this.logger.error(`Stripe cancelPaymentIntent failed during compensation: ${stripeError.message}`, stripeError.stack);
          }

          // Update BookingIntent status
          const bookingIntent = await this.prisma.bookingIntent.findUnique({
            where: { id: payment.bookingIntentId },
          });
          const nextBookingStatus = (bookingIntent?.paymentAttemptCount || 0) < 2 ? 'AWAITING_PAYMENT' : 'CANCELLED';

          let flightSnap: FlightSnapshot | undefined;
          let passSnap: PassengerSnapshot | undefined;
          let departAt: Date | undefined;
          try {
            const duffelEvent = await this.prisma.paymentEvent.findFirst({
              where: {
                paymentId: payment.id,
                eventType: 'duffel_order_created',
              },
              orderBy: { createdAt: 'desc' },
            });
            const dOrder = duffelEvent?.metadata as any;
            if (dOrder) {
              const snaps = this.duffelService.mapDuffelOrderToSnapshots(dOrder);
              flightSnap = snaps.flightSnapshot;
              passSnap = snaps.passengerSnapshot;
              if (flightSnap?.segments?.[0]?.departureAt) {
                departAt = new Date(flightSnap.segments[0].departureAt);
              }
            }
          } catch (e: any) {
            this.logger.warn(`Failed to recover Duffel order snapshots for booking ${canonicalBooking.id}: ${e.message}`, e.stack);
          }

          // Update Payment status, BookingIntent, and Booking status to FAILED atomically
          enforceTransition(payment.status, 'CANCELLED');
          await this.prisma.$transaction(async (tx) => {
            await tx.payment.update({
              where: { id: payment.id },
              data: { status: 'CANCELLED' },
            });
            await tx.paymentEvent.create({
              data: {
                paymentId: payment.id,
                eventType: 'payment_cancelled',
                previousStatus: payment.status,
                newStatus: 'CANCELLED',
                amount: payment.amount,
                source: 'API',
                createdBy: userId,
              },
            });
            await tx.bookingIntent.update({
              where: { id: payment.bookingIntentId },
              data: { status: nextBookingStatus },
            });
            await this.bookingService.updateToFailed(
              canonicalBooking.id,
              BookingFailureReason.CAPTURE_FAILED,
              flightSnap,
              passSnap,
              departAt,
              tx
            );
          });

          // Update recovery point to completed and complete idempotency key
          await this.idempotencyService.updateRecoveryPoint(idempotencyKey, 'completed');
          const failureResponse = {
            success: false,
            error: `Stripe capture failed: ${error.message || 'Unknown error'}. Duffel order cancelled and hold released.`,
            bookingStatus: nextBookingStatus,
          };
          await this.idempotencyService.completeKey(idempotencyKey, HttpStatus.BAD_GATEWAY, failureResponse);

          throw new HttpException(failureResponse, HttpStatus.BAD_GATEWAY);
        }

        await this.idempotencyService.updateRecoveryPoint(idempotencyKey, 'captured');
        recoveryPoint = 'captured';
      }

      // Step 4: Post-Capture Updates
      if (recoveryPoint === 'captured') {
        const duffelEvent = await this.prisma.paymentEvent.findFirst({
          where: {
            paymentId: payment.id,
            eventType: 'duffel_order_created',
          },
          orderBy: { createdAt: 'desc' },
        });

        const duffelOrder = duffelEvent?.metadata as Record<string, unknown> | null;
        if (!duffelOrder) {
          throw new InternalServerErrorException('Duffel order details not found in payment history.');
        }

        const transactionId = crypto.randomUUID();
        if (payment.status !== 'SUCCEEDED') {
          enforceTransition(payment.status, 'SUCCEEDED');

          await this.prisma.$transaction(async (tx) => {
            // Update Payment status to SUCCEEDED
            await tx.payment.update({
              where: { id: payment.id },
              data: { status: 'SUCCEEDED' },
            });

            // Log FSM transition to SUCCEEDED
            await tx.paymentEvent.create({
              data: {
                paymentId: payment.id,
                eventType: 'payment_captured',
                previousStatus: payment.status === 'AUTHORIZED' ? 'AUTHORIZED' : payment.status,
                newStatus: 'SUCCEEDED',
                amount: payment.amount,
                source: 'API',
                createdBy: userId,
              },
            });

            // Update BookingIntent status to CONFIRMED
            await tx.bookingIntent.update({
              where: { id: payment.bookingIntentId },
              data: { status: 'CONFIRMED' },
            });

            const { flightSnapshot, passengerSnapshot } = this.duffelService.mapDuffelOrderToSnapshots(duffelOrder);
            await this.bookingService.updateToConfirmed(
              canonicalBooking.id,
              duffelOrder.booking_reference as string,
              duffelOrder.id as string,
              flightSnapshot as any,
              passengerSnapshot as any,
              tx
            );

            // Create double-entry ledger rows
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
          });

          // Log audit events
          await this.auditService.createLog(this.prisma, {
            userId,
            action: 'payment_captured',
            resourceType: 'Payment',
            resourceId: payment.id,
            metadata: {
              transactionId,
              amount: payment.amount,
              currency: payment.currency,
            },
          });

          await this.auditService.createLog(this.prisma, {
            userId,
            action: 'booking_confirmed',
            resourceType: 'BookingIntent',
            resourceId: payment.bookingIntentId,
            metadata: {
              pnr: duffelOrder.booking_reference as string,
              duffelOrderId: duffelOrder.id as string,
            },
          });
        }

        if (payment.stripeCustomerId) {
          try {
            await this.paymentMethodService.saveMethod(
              userId,
              payment.stripeCustomerId,
              payment.stripePaymentIntentId,
            );
          } catch (error: unknown) {
            this.logger.warn(
              `Unable to save payment method for payment ${payment.id}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        await this.idempotencyService.updateRecoveryPoint(idempotencyKey, 'completed');

        const successResponse = {
          success: true,
          paymentId: payment.id,
          status: 'SUCCEEDED',
          bookingReference: duffelOrder.booking_reference as string,
          duffelOrderId: duffelOrder.id as string,
        };

        await this.idempotencyService.completeKey(idempotencyKey, HttpStatus.OK, successResponse);

        return successResponse;
      }
    } catch (error) {
      this.logger.error(`Error in confirmPayment: ${error instanceof Error ? error.message : String(error)}`, error instanceof Error ? error.stack : undefined);
      throw error;
    }
  }

  /**
   * Retrieve payment and booking status
   */
  async getPaymentStatus(paymentId: string, userId: string): Promise<unknown> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { bookingIntent: true },
    });

    if (!payment) {
      throw new NotFoundException('Payment not found');
    }

    if (payment.bookingIntent.userId !== userId) {
      throw new ForbiddenException('You do not own this payment');
    }

    return {
      paymentId: payment.id,
      status: payment.status,
      amount: payment.amount,
      currency: payment.currency,
      bookingIntentStatus: payment.bookingIntent.status,
      attemptNumber: payment.attemptNumber,
    };
  }



  /**
   * Cleans up state and resolves background errors to prevent unhandled rejections
   */
  private async handleBackgroundError(
    paymentId: string,
    idempotencyKey: string,
    userId: string,
    error: unknown,
  ): Promise<void> {
    try {
      const payment = await this.prisma.payment.findUnique({
        where: { id: paymentId },
      });

      if (!payment || payment.status === 'SUCCEEDED' || payment.status === 'CANCELLED' || payment.status === 'FAILED' || payment.status === 'EXPIRED') {
        return;
      }

      let isStripeCaptured = false;
      try {
        const paymentIntent = await this.stripeService.retrievePaymentIntent(payment.stripePaymentIntentId);
        if (paymentIntent?.status === 'succeeded') {
          isStripeCaptured = true;
        }
      } catch (stripeErr: unknown) {
        this.logger.error(
          `Failed to retrieve Stripe PaymentIntent for payment ${paymentId}: ${stripeErr instanceof Error ? stripeErr.message : String(stripeErr)}`
        );
      }

      const recoveryPoint = await this.idempotencyService.getResumePoint(idempotencyKey);
      if (recoveryPoint === 'captured' || recoveryPoint === 'completed' || isStripeCaptured) {
        if (isStripeCaptured && recoveryPoint !== 'captured' && recoveryPoint !== 'completed') {
          try {
            await this.idempotencyService.updateRecoveryPoint(idempotencyKey, 'captured');
          } catch (updateErr: unknown) {
            this.logger.error(
              `Failed to update recovery point to 'captured' for payment ${paymentId}: ${updateErr instanceof Error ? updateErr.message : String(updateErr)}`
            );
          }
        }

        this.logger.error(
          `CRITICAL: Background confirmation failed after Stripe capture for payment ${paymentId}. Customer has been charged. Recovery point is '${recoveryPoint}'. Retries will attempt to resume post-capture updates.`,
          error instanceof Error ? error.stack : undefined
        );
        return;
      }

      // Check if Duffel order was created
      const duffelEvent = await this.prisma.paymentEvent.findFirst({
        where: {
          paymentId,
          eventType: 'duffel_order_created',
        },
        orderBy: { createdAt: 'desc' },
      });

      if (duffelEvent) {
        const duffelOrder = duffelEvent.metadata as Record<string, unknown> | null;
        const duffelOrderId = duffelOrder?.id as string | undefined;
        if (duffelOrderId) {
          try {
            await this.duffelService.cancelOrder(duffelOrderId);
          } catch (cancelError: unknown) {
            const err = cancelError as Error;
            this.logger.error(`Background cancelOrder failed: ${err.message}`);
          }
        }
      }

      // Release hold if authorized
      try {
        await this.stripeService.cancelPaymentIntent(payment.stripePaymentIntentId);
      } catch (stripeError: unknown) {
        const err = stripeError as Error;
        this.logger.error(`Background cancelPaymentIntent failed: ${err.message}`);
      }

      // 1. Fetch BookingIntent and calculate next status
      const bookingIntent = await this.prisma.bookingIntent.findUnique({
        where: { id: payment.bookingIntentId },
      });
      const nextBookingStatus = (bookingIntent?.paymentAttemptCount || 0) < 2 ? 'AWAITING_PAYMENT' : 'CANCELLED';

      // 2. Fetch canonical booking
      const booking = await this.prisma.booking.findFirst({
        where: { paymentId: payment.id }
      });

      // 3. Try to extract snapshots if duffelEvent is present
      let flightSnap: FlightSnapshot | undefined;
      let passSnap: PassengerSnapshot | undefined;
      let departAt: Date | undefined;
      if (booking) {
        try {
          if (duffelEvent) {
            const dOrder = duffelEvent.metadata as any;
            if (dOrder) {
              const snaps = this.duffelService.mapDuffelOrderToSnapshots(dOrder);
              flightSnap = snaps.flightSnapshot;
              passSnap = snaps.passengerSnapshot;
              if (flightSnap?.segments?.[0]?.departureAt) {
                departAt = new Date(flightSnap.segments[0].departureAt);
              }
            }
          }
        } catch (e: any) {
          this.logger.warn(`Failed to recover Duffel order snapshots in background handler: ${e.message}`, e.stack);
        }
      }

      // 4. Update Payment, BookingIntent, and Booking status atomically inside transaction
      enforceTransition(payment.status, 'CANCELLED');
      await this.prisma.$transaction(async (tx) => {
        await tx.payment.update({
          where: { id: paymentId },
          data: { status: 'CANCELLED' },
        });
        await tx.paymentEvent.create({
          data: {
            paymentId,
            eventType: 'payment_cancelled',
            previousStatus: payment.status,
            newStatus: 'CANCELLED',
            amount: payment.amount,
            source: 'API',
            createdBy: userId,
          },
        });
        await tx.bookingIntent.update({
          where: { id: payment.bookingIntentId },
          data: { status: nextBookingStatus },
        });
        if (booking) {
          await this.bookingService.updateToFailed(
            booking.id,
            BookingFailureReason.SYSTEM_ERROR,
            flightSnap,
            passSnap,
            departAt,
            tx
          );
        }
      });

      const errObj = error as Error;
      // Complete idempotency key
      await this.idempotencyService.updateRecoveryPoint(idempotencyKey, 'completed');
      await this.idempotencyService.completeKey(idempotencyKey, HttpStatus.BAD_GATEWAY, {
        success: false,
        error: `Background processing failed: ${errObj.message || 'Unknown error'}. Hold released.`,
        bookingStatus: nextBookingStatus,
      });
    } catch (err: unknown) {
      const errorObj = err as Error;
      this.logger.error(`Error in handleBackgroundError: ${errorObj.message}`, errorObj.stack);
    }
  }
}
