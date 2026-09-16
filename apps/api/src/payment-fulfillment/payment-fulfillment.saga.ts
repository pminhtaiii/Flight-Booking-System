import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { BookingFailureReason, Prisma } from '@prisma/client';
import * as crypto from 'crypto';
import { PrismaService } from '@/prisma/prisma.service';
import {
  PaymentIdempotencyService,
  SagaOwnership,
} from '@/idempotency/payment-idempotency.service';
import { PaymentMethodService } from '@/payment/payment-method.service';
import { BookingLifecycleService } from '@/booking-lifecycle/booking-lifecycle.service';
import { BookingPassengerFinalValidatorService } from '@/booking-intent/booking-passenger-final-validator.service';
import { AuditService } from '@/audit/audit.service';
import { ConfirmPaymentDto } from '@/payment/dto/confirm-payment.dto';
import { enforceTransition } from '@/payment/payment-state-machine';
import { FlightSnapshot, PassengerSnapshot } from '@shared/booking-types';
import {
  PAYMENT_GATEWAY_PORT,
  FULFILLMENT_GATEWAY_PORT,
  PaymentGatewayPort,
  FulfillmentGatewayPort,
  PortInvocationControl,
  AuthorizeHoldOutcome,
  PassengerEnrichmentInput,
  PersistedOrderEvidence,
  EphemeralPassenger,
} from './ports';

function isOwnershipLost(error: unknown): boolean {
  return error instanceof ConflictException && error.message.includes('ownership');
}

@Injectable()
export class PaymentFulfillmentSaga {
  private readonly logger = new Logger(PaymentFulfillmentSaga.name);
  public timeoutMs = 25000;

  constructor(
    @Inject(PAYMENT_GATEWAY_PORT)
    private readonly paymentGateway: PaymentGatewayPort,
    @Inject(FULFILLMENT_GATEWAY_PORT)
    private readonly fulfillmentGateway: FulfillmentGatewayPort,
    private readonly idempotency: PaymentIdempotencyService,
    private readonly paymentMethodService: PaymentMethodService,
    private readonly bookingLifecycleService: BookingLifecycleService,
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    @Optional()
    private readonly bookingPassengerFinalValidator?: BookingPassengerFinalValidatorService,
  ) {}

  /**
   * Confirm Payment: Entry point with Tier 2 (25s) handoff and background execution
   */
  async confirmPayment(
    dto: ConfirmPaymentDto,
    idempotencyKey: string,
    userId: string,
    traceContext?: { traceId?: string; correlationId?: string },
  ): Promise<unknown> {
    const requestHash = this.idempotency.computeHash(dto);
    const idempotency = await this.idempotency.acquireOrReplay(
      idempotencyKey,
      requestHash,
      userId,
      '/api/bookings/payment/confirm',
    );

    if (idempotency.status === 'replay') {
      try {
        return JSON.parse(idempotency.responseBody);
      } catch {
        return idempotency.responseBody;
      }
    }

    const ownership: SagaOwnership = {
      key: idempotencyKey,
      userId,
      requestPath: '/api/bookings/payment/confirm',
      requestHash,
      lockedAt: idempotency.lockedAt,
    };

    let isFinished = false;
    const confirmPromise = (async () => {
      try {
        const result = await this.executeConfirmPayment(
          dto,
          idempotencyKey,
          userId,
          ownership,
          traceContext,
        );
        isFinished = true;
        return result;
      } catch (error) {
        isFinished = true;
        throw error;
      }
    })();

    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<{ isTimeout: true }>((resolve) => {
      timer = setTimeout(() => resolve({ isTimeout: true }), this.timeoutMs);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
    });

    try {
      const raceResult = await Promise.race([confirmPromise, timeoutPromise]);

      if (
        raceResult &&
        typeof raceResult === 'object' &&
        'isTimeout' in raceResult &&
        (raceResult as { isTimeout: boolean }).isTimeout &&
        !isFinished
      ) {
        this.logger.log('confirmPayment hit Tier 2 timeout (25s). Handoff to async polling.');

        confirmPromise.catch((err: unknown) => {
          this.logger.error(
            `Background confirmPayment execution failed for payment ${dto.paymentId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
            err instanceof Error ? err.stack : undefined,
          );
          this.handleBackgroundError(
            dto.paymentId,
            idempotencyKey,
            userId,
            ownership,
            err,
          ).catch((bgErr: unknown) => {
            this.logger.error(
              `Failed to execute background error recovery: ${
                bgErr instanceof Error ? bgErr.message : String(bgErr)
              }`,
              bgErr instanceof Error ? bgErr.stack : undefined,
            );
          });
        });

        return {
          success: true,
          status: 'PENDING',
          message: 'Booking is being confirmed. Please poll status.',
          pollUrl: `/api/bookings/payment/${dto.paymentId}/status`,
        };
      }

      if (timer) {
        clearTimeout(timer);
      }
      return raceResult;
    } catch (error) {
      if (timer) {
        clearTimeout(timer);
      }
      throw error;
    }
  }

  /**
   * Core Saga Orchestration: 4-Stage Sequential Checkpointed Pipeline
   */
  async executeConfirmPayment(
    dto: ConfirmPaymentDto,
    idempotencyKey: string,
    userId: string,
    ownership?: SagaOwnership,
    traceContext?: { traceId?: string; correlationId?: string },
  ): Promise<unknown> {
    if (!ownership) {
      const requestHash = this.idempotency.computeHash(dto);
      const idempotency = await this.idempotency.acquireOrReplay(
        idempotencyKey,
        requestHash,
        userId,
        '/api/bookings/payment/confirm',
      );

      if (idempotency.status === 'replay') {
        try {
          return JSON.parse(idempotency.responseBody);
        } catch {
          return idempotency.responseBody;
        }
      }

      ownership = {
        key: idempotencyKey,
        userId,
        requestPath: '/api/bookings/payment/confirm',
        requestHash,
        lockedAt: idempotency.lockedAt,
      };
    }

    const currentOwnership = ownership;
    const control: PortInvocationControl = {
      beforeInvoke: () => this.idempotency.assertOwned(currentOwnership),
    };

    try {
      // 1. Query payment
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

      if (dto.bookingId && typeof this.prisma.booking?.findUnique === 'function') {
        const requestedBooking = await this.prisma.booking.findUnique({
          where: { id: dto.bookingId },
        });
        if (requestedBooking && requestedBooking.userId !== userId) {
          throw new ForbiddenException('You do not own this booking');
        }
      }

      // 2. Create canonical booking in PROCESSING state
      const canonicalBooking = await this.bookingLifecycleService.createBooking(
        userId,
        dto.bookingId,
        payment.bookingIntentId,
        payment.id,
      );

      if (canonicalBooking.userId !== userId) {
        throw new ForbiddenException('You do not own this booking');
      }

      // 3. Resume from recovery point
      let recoveryPoint = await this.idempotency.getResumePoint(idempotencyKey);
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
            throw new InternalServerErrorException(
              'Duffel order details not found in payment history.',
            );
          }

          const successResponse = {
            success: true,
            paymentId: payment.id,
            status: 'SUCCEEDED',
            bookingReference: (duffelOrder.bookingReference || duffelOrder.booking_reference) as string,
            duffelOrderId: duffelOrder.id as string,
          };

          await this.idempotency.completeSagaKeyAtomic(currentOwnership, HttpStatus.OK, successResponse);
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

          await this.idempotency.completeSagaKeyAtomic(
            currentOwnership,
            HttpStatus.BAD_GATEWAY,
            failureResponse,
          );
          return failureResponse;
        }
      }

      // Stage 1: Authorization Validation
      if (recoveryPoint === 'started') {
        const authOutcome = await this.paymentGateway.authorizeHold(
          payment.stripePaymentIntentId,
          control,
        );

        if (authOutcome.status === 'authorized') {
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
        } else if (authOutcome.status !== 'captured') {
          throw new BadRequestException(
            `Stripe PaymentIntent is in invalid status: ${authOutcome.rawStatus || authOutcome.status}`,
          );
        }

        await this.idempotency.advanceSagaCheckpoint(currentOwnership, 'stripe_authorized');
        recoveryPoint = 'stripe_authorized';
      }

      // Stage 2: Fulfillment Order Booking
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
        const services = Array.from(servicesMap.entries()).map(([serviceId, quantity]) => ({
          serviceId,
          quantity,
        }));

        let passengersToOrder: EphemeralPassenger[];
        if (this.bookingPassengerFinalValidator) {
          try {
            const ephemeralPassengers =
              this.bookingPassengerFinalValidator.validateAndMapPassengers(bookingIntent, {
                traceId: traceContext?.traceId,
                correlationId: traceContext?.correlationId,
              });
            passengersToOrder = ephemeralPassengers;

            await this.auditService.createLog(this.prisma, {
              userId,
              action: 'final_passenger_validation_succeeded',
              resourceType: 'BookingIntent',
              resourceId: bookingIntent.id,
              metadata: {
                paymentId: payment.id,
                passengerCount: bookingIntent.passengers.length,
              },
              traceId: traceContext?.traceId,
              correlationId: traceContext?.correlationId,
            });
          } catch (validationError: unknown) {
            if (isOwnershipLost(validationError)) {
              throw validationError;
            }

            const error = validationError as Error;
            const responseObj =
              validationError instanceof HttpException
                ? (validationError.getResponse() as Record<string, unknown> | string)
                : null;
            const reasonCode =
              typeof responseObj === 'object' && responseObj !== null && 'code' in responseObj
                ? (responseObj as { code: string }).code
                : 'FINAL_PASSENGER_VALIDATION_FAILED';
            const status =
              validationError instanceof HttpException
                ? validationError.getStatus()
                : HttpStatus.UNPROCESSABLE_ENTITY;

            this.logger.error(
              `Final passenger validation failed for booking intent ${bookingIntent.id}: ${error.message}`,
              error.stack,
            );

            await this.auditService.createLog(this.prisma, {
              userId,
              action: 'final_passenger_validation_failed',
              resourceType: 'BookingIntent',
              resourceId: bookingIntent.id,
              metadata: {
                reasonCode,
                intentId: bookingIntent.id,
                paymentId: payment.id,
                passengerCount: bookingIntent.passengers.length,
              },
              traceId: traceContext?.traceId,
              correlationId: traceContext?.correlationId,
            });

            // Void / cancel Stripe authorization hold via paymentGateway
            try {
              await this.paymentGateway.voidHold(payment.stripePaymentIntentId, control);
            } catch (voidError: unknown) {
              if (isOwnershipLost(voidError)) {
                throw voidError;
              }
              const err = voidError as Error;
              this.logger.error(
                `paymentGateway voidHold failed after passenger validation error: ${err.message}`,
                err.stack,
              );
            }

            // Update Payment, BookingIntent, and Booking status atomically
            enforceTransition(payment.status, 'CANCELLED');
            const nextBookingStatus =
              bookingIntent.paymentAttemptCount < 2 ? 'AWAITING_PAYMENT' : 'CANCELLED';
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
              await this.bookingLifecycleService.updateToFailed(
                canonicalBooking.id,
                BookingFailureReason.SYSTEM_ERROR,
                undefined,
                undefined,
                undefined,
                tx,
              );
            });

            const failureResponse = {
              success: false,
              error: `Passenger validation failed: ${
                typeof responseObj === 'object' && responseObj !== null && 'message' in responseObj
                  ? responseObj.message
                  : error.message || 'Validation failed'
              }. Payment hold released.`,
              code: reasonCode,
              bookingStatus: nextBookingStatus,
            };
            await this.idempotency.completeSagaKeyAtomic(currentOwnership, status, failureResponse);

            throw new HttpException(failureResponse, status);
          }
        } else {
          passengersToOrder = bookingIntent.passengers.map((p) => {
            const mapped: EphemeralPassenger = {
              id: p.id,
              givenName: p.givenName,
              familyName: p.familyName,
              type: p.type ? String(p.type).toLowerCase() : undefined,
              gender: p.gender ?? undefined,
              dateOfBirth: p.dateOfBirth,
              duffelPassengerId: p.duffelPassengerId ?? undefined,
              middleName: p.middleName ?? undefined,
              title: p.title ?? undefined,
              email: p.email ?? undefined,
              phoneNumber: p.phoneNumber ?? undefined,
              phoneCountryCode: p.phoneCountryCode ?? undefined,
              documentType: p.documentType ?? undefined,
              issuingCountry: p.issuingCountry ?? undefined,
            };
            return mapped;
          });
        }

        let orderOutcome;
        try {
          const recheckedPayment = await this.prisma.payment.findUnique({
            where: { id: payment.id },
            include: {
              bookingIntent: true,
              ancillarySelection: {
                include: {
                  seatSelections: true,
                  baggageSelections: true,
                },
              },
            },
          });
          if (!recheckedPayment) {
            throw new InternalServerErrorException(
              'Payment-bound ancillary selection could not be recovered',
            );
          }
          const orderPayment = recheckedPayment;
          const hasAncillaryBinding = payment.ancillarySelectionId !== null;
          const hasExactBoundSelection =
            orderPayment.ancillarySelectionId === payment.ancillarySelectionId &&
            orderPayment.ancillarySelectionVersion === payment.ancillarySelectionVersion &&
            (hasAncillaryBinding
              ? orderPayment.ancillarySelection?.id === payment.ancillarySelectionId &&
                orderPayment.ancillarySelection.version === payment.ancillarySelectionVersion &&
                orderPayment.ancillarySelection.status === 'PAYMENT_BOUND'
              : orderPayment.ancillarySelection === null);
          if (!hasExactBoundSelection) {
            throw new InternalServerErrorException(
              'Payment-bound ancillary selection could not be recovered',
            );
          }

          orderOutcome = await this.fulfillmentGateway.createOrder(
            {
              offerId: bookingIntent.duffelOfferId,
              passengers: passengersToOrder,
              services: services.length > 0 ? services : undefined,
              metadata: { bookingIntentId: bookingIntent.id, paymentId: payment.id },
              idempotencyKey,
            },
            control,
          );
        } catch (fulfillmentError: unknown) {
          if (isOwnershipLost(fulfillmentError)) {
            throw fulfillmentError;
          }

          const error = fulfillmentError as Error;
          this.logger.error(`Fulfillment booking failed: ${error.message}`, error.stack);

          // Cancel/Void Stripe authorization hold
          try {
            await this.paymentGateway.voidHold(payment.stripePaymentIntentId, control);
          } catch (voidError: unknown) {
            if (isOwnershipLost(voidError)) {
              throw voidError;
            }
            const err = voidError as Error;
            this.logger.error(`paymentGateway voidHold failed: ${err.message}`, err.stack);
          }

          // Update Payment, BookingIntent, and Booking status atomically
          enforceTransition(payment.status, 'CANCELLED');
          const nextBookingStatus =
            bookingIntent.paymentAttemptCount < 2 ? 'AWAITING_PAYMENT' : 'CANCELLED';
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
            await this.bookingLifecycleService.updateToFailed(
              canonicalBooking.id,
              BookingFailureReason.SYSTEM_ERROR,
              undefined,
              undefined,
              undefined,
              tx,
            );
          });

          const failureResponse = {
            success: false,
            error: `Duffel booking failed: ${error.message || 'Unknown error'}. Payment hold released.`,
            bookingStatus: nextBookingStatus,
          };
          await this.idempotency.completeSagaKeyAtomic(
            currentOwnership,
            HttpStatus.BAD_GATEWAY,
            failureResponse,
          );

          throw new HttpException(failureResponse, HttpStatus.BAD_GATEWAY);
        }

        // Fulfillment order succeeded. Log payment event with evidence.
        await this.prisma.paymentEvent.create({
          data: {
            paymentId: payment.id,
            eventType: 'duffel_order_created',
            previousStatus: 'AUTHORIZED',
            newStatus: 'AUTHORIZED',
            amount: payment.amount,
            source: 'API',
            metadata: orderOutcome.evidence as Prisma.InputJsonValue,
            createdBy: userId,
          },
        });

        await this.idempotency.advanceSagaCheckpoint(currentOwnership, 'duffel_order_created');
        recoveryPoint = 'duffel_order_created';
      }

      // Stage 3: Payment Capture
      if (recoveryPoint === 'duffel_order_created') {
        try {
          await this.paymentGateway.capturePayment(
            payment.stripePaymentIntentId,
            `${idempotencyKey}-stripe-capture`,
            control,
          );
        } catch (captureError: unknown) {
          if (isOwnershipLost(captureError)) {
            throw captureError;
          }

          const error = captureError as Error;
          this.logger.error(`Payment capture failed: ${error.message}`, error.stack);

          let reconcileOutcome: AuthorizeHoldOutcome;
          try {
            reconcileOutcome = await this.paymentGateway.authorizeHold(
              payment.stripePaymentIntentId,
              control,
            );
          } catch (reconciliationError: unknown) {
            if (isOwnershipLost(reconciliationError)) {
              throw reconciliationError;
            }
            const reconciliationMessage =
              reconciliationError instanceof Error
                ? reconciliationError.message
                : String(reconciliationError);
            this.logger.error(
              `Payment capture outcome remains unknown for payment ${payment.id}: ${reconciliationMessage}`,
            );
            throw new HttpException(
              {
                success: false,
                error: 'Stripe capture outcome is unknown. Retry payment confirmation.',
                bookingStatus: 'PROCESSING',
              },
              HttpStatus.BAD_GATEWAY,
            );
          }

          if (
            reconcileOutcome.status !== 'captured' &&
            reconcileOutcome.status !== 'authorized' &&
            reconcileOutcome.status !== 'voided'
          ) {
            throw new HttpException(
              {
                success: false,
                error: `Stripe capture outcome is not final (${
                  reconcileOutcome.rawStatus || reconcileOutcome.status
                }). Retry payment confirmation.`,
                bookingStatus: 'PROCESSING',
              },
              HttpStatus.BAD_GATEWAY,
            );
          }

          if (reconcileOutcome.status !== 'captured') {
            // Authoritative noncapture: compensate order and hold
            const duffelEvent = await this.prisma.paymentEvent.findFirst({
              where: {
                paymentId: payment.id,
                eventType: 'duffel_order_created',
              },
              orderBy: { createdAt: 'desc' },
            });
            const rawOrder = duffelEvent?.metadata as Record<string, unknown> | null;
            const duffelOrderId = rawOrder?.id as string | undefined;

            if (duffelOrderId) {
              try {
                await this.fulfillmentGateway.cancelOrder(duffelOrderId, control);
                this.logger.log(
                  `Successfully cancelled fulfillment order ${duffelOrderId} as compensation.`,
                );
              } catch (cancelError: unknown) {
                if (isOwnershipLost(cancelError)) {
                  throw cancelError;
                }
                const err = cancelError as Error;
                this.logger.error(
                  `Fulfillment order cancellation failed during compensation: ${err.message}`,
                  err.stack,
                );
              }
            }

            try {
              await this.paymentGateway.voidHold(payment.stripePaymentIntentId, control);
            } catch (voidError: unknown) {
              if (isOwnershipLost(voidError)) {
                throw voidError;
              }
              const err = voidError as Error;
              this.logger.error(
                `Payment gateway voidHold failed during compensation: ${err.message}`,
                err.stack,
              );
            }

            const bookingIntent = await this.prisma.bookingIntent.findUnique({
              where: { id: payment.bookingIntentId },
            });
            const nextBookingStatus =
              (bookingIntent?.paymentAttemptCount || 0) < 2 ? 'AWAITING_PAYMENT' : 'CANCELLED';

            let flightSnap: FlightSnapshot | undefined;
            let passSnap: PassengerSnapshot | undefined;
            let departAt: Date | undefined;

            if (duffelOrderId && rawOrder) {
              try {
                const fullBookingIntent = await this.prisma.bookingIntent.findUnique({
                  where: { id: payment.bookingIntentId },
                  include: { passengers: true, user: true },
                });
                const passengerEnrichment: PassengerEnrichmentInput[] = (
                  fullBookingIntent?.passengers || []
                ).map((p) => ({
                  id: p.id,
                  firstName: p.givenName,
                  lastName: p.familyName,
                  title: p.title ?? undefined,
                  gender: p.gender ?? undefined,
                  dateOfBirth: p.dateOfBirth
                    ? p.dateOfBirth instanceof Date
                      ? p.dateOfBirth.toISOString().split('T')[0]
                      : String(p.dateOfBirth).split('T')[0]
                    : undefined,
                  passengerType: p.type ? String(p.type).toLowerCase() : undefined,
                  email: p.email ?? undefined,
                  phoneNumber: p.phoneNumber ?? undefined,
                }));
                const contactEmail = fullBookingIntent?.user?.email || '';

                const snaps = await this.fulfillmentGateway.retrieveOrderSnapshot(
                  duffelOrderId,
                  rawOrder as PersistedOrderEvidence,
                  passengerEnrichment,
                  contactEmail,
                  control,
                );
                flightSnap = snaps.flightSnapshot;
                passSnap = snaps.passengerSnapshot;
                departAt = snaps.departureAt;
              } catch (e: unknown) {
                if (isOwnershipLost(e)) {
                  throw e;
                }
                const err = e as Error;
                this.logger.warn(
                  `Failed to recover order snapshots for booking ${canonicalBooking.id}: ${err.message}`,
                  err.stack,
                );
              }
            }

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
              await this.bookingLifecycleService.updateToFailed(
                canonicalBooking.id,
                BookingFailureReason.CAPTURE_FAILED,
                flightSnap,
                passSnap,
                departAt,
                tx,
              );
            });

            const failureResponse = {
              success: false,
              error: `Stripe capture failed: ${
                error.message || 'Unknown error'
              }. Duffel order cancelled and hold released.`,
              bookingStatus: nextBookingStatus,
            };
            await this.idempotency.completeSagaKeyAtomic(
              currentOwnership,
              HttpStatus.BAD_GATEWAY,
              failureResponse,
            );

            throw new HttpException(failureResponse, HttpStatus.BAD_GATEWAY);
          }
        }

        await this.idempotency.advanceSagaCheckpoint(currentOwnership, 'captured');
        recoveryPoint = 'captured';
      }

      // Stage 4: Post-Capture Updates
      if (recoveryPoint === 'captured') {
        const duffelEvent = await this.prisma.paymentEvent.findFirst({
          where: {
            paymentId: payment.id,
            eventType: 'duffel_order_created',
          },
          orderBy: { createdAt: 'desc' },
        });

        const rawOrder = duffelEvent?.metadata as Record<string, unknown> | null;
        if (!rawOrder || !rawOrder.id) {
          throw new InternalServerErrorException(
            'Duffel order details not found in payment history.',
          );
        }

        const fullBookingIntent = await this.prisma.bookingIntent.findUnique({
          where: { id: payment.bookingIntentId },
          include: { passengers: true, user: true },
        });

        const passengerEnrichment: PassengerEnrichmentInput[] = (
          fullBookingIntent?.passengers || []
        ).map((p) => ({
          id: p.id,
          firstName: p.givenName,
          lastName: p.familyName,
          title: p.title ?? undefined,
          gender: p.gender ?? undefined,
          dateOfBirth: p.dateOfBirth
            ? p.dateOfBirth instanceof Date
              ? p.dateOfBirth.toISOString().split('T')[0]
              : String(p.dateOfBirth).split('T')[0]
            : undefined,
          passengerType: p.type ? String(p.type).toLowerCase() : undefined,
          email: p.email ?? undefined,
          phoneNumber: p.phoneNumber ?? undefined,
        }));
        const contactEmail = fullBookingIntent?.user?.email || '';

        const snapshotOutcome = await this.fulfillmentGateway.retrieveOrderSnapshot(
          rawOrder.id as string,
          rawOrder as PersistedOrderEvidence,
          passengerEnrichment,
          contactEmail,
          control,
        );

        const transactionId = crypto.randomUUID();
        if (payment.status !== 'SUCCEEDED') {
          enforceTransition(payment.status, 'SUCCEEDED');

          await this.prisma.$transaction(async (tx) => {
            await tx.payment.update({
              where: { id: payment.id },
              data: { status: 'SUCCEEDED' },
            });

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

            await tx.bookingIntent.update({
              where: { id: payment.bookingIntentId },
              data: { status: 'CONFIRMED' },
            });

            const pnr = (rawOrder.bookingReference || rawOrder.booking_reference) as string;
            await this.bookingLifecycleService.updateToConfirmed(
              canonicalBooking.id,
              pnr,
              rawOrder.id as string,
              snapshotOutcome.flightSnapshot,
              snapshotOutcome.passengerSnapshot,
              tx,
            );

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

          const pnr = (rawOrder.bookingReference || rawOrder.booking_reference) as string;
          await this.auditService.createLog(this.prisma, {
            userId,
            action: 'booking_confirmed',
            resourceType: 'BookingIntent',
            resourceId: payment.bookingIntentId,
            metadata: {
              pnr,
              duffelOrderId: rawOrder.id as string,
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
          } catch (methodError: unknown) {
            this.logger.warn(
              `Unable to save payment method for payment ${payment.id}: ${
                methodError instanceof Error ? methodError.message : String(methodError)
              }`,
            );
          }
        }

        const bookingReference = (rawOrder.bookingReference ||
          rawOrder.booking_reference) as string;
        const successResponse = {
          success: true,
          paymentId: payment.id,
          status: 'SUCCEEDED',
          bookingReference,
          duffelOrderId: rawOrder.id as string,
        };

        await this.idempotency.completeSagaKeyAtomic(
          currentOwnership,
          HttpStatus.OK,
          successResponse,
        );

        return successResponse;
      }
    } catch (error) {
      this.logger.error(
        `Error in executeConfirmPayment: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  /**
   * Cleans up state and resolves background errors following Tier 2 handoff
   */
  async handleBackgroundError(
    paymentId: string,
    idempotencyKey: string,
    userId: string,
    ownership: SagaOwnership,
    error: unknown,
  ): Promise<void> {
    try {
      if (isOwnershipLost(error)) {
        this.logger.warn(
          `Ownership lost in handleBackgroundError for key ${idempotencyKey}; aborting background recovery.`,
        );
        return;
      }

      const payment = await this.prisma.payment.findUnique({
        where: { id: paymentId },
        include: {
          ancillarySelection: {
            include: {
              seatSelections: true,
              baggageSelections: true,
            },
          },
        },
      });

      if (
        !payment ||
        payment.status === 'SUCCEEDED' ||
        payment.status === 'CANCELLED' ||
        payment.status === 'FAILED' ||
        payment.status === 'EXPIRED'
      ) {
        return;
      }

      const control: PortInvocationControl = {
        beforeInvoke: () => this.idempotency.assertOwned(ownership),
      };

      let authOutcome: AuthorizeHoldOutcome;
      try {
        authOutcome = await this.paymentGateway.authorizeHold(
          payment.stripePaymentIntentId,
          control,
        );
      } catch (gatewayErr: unknown) {
        if (isOwnershipLost(gatewayErr)) {
          this.logger.warn(
            `Ownership lost in handleBackgroundError for key ${idempotencyKey}`,
          );
          return;
        }
        this.logger.warn(
          `Failed to retrieve Payment status for payment ${paymentId}: ${
            gatewayErr instanceof Error ? gatewayErr.message : String(gatewayErr)
          }`,
        );
        return;
      }

      const finalStatuses = ['captured', 'authorized', 'voided'];
      if (!authOutcome || !finalStatuses.includes(authOutcome.status)) {
        this.logger.warn(
          `Payment intent for payment ${paymentId} is in non-final status: ${authOutcome?.status}. Warning & returning early.`,
        );
        return;
      }

      if (authOutcome.status === 'captured') {
        const recoveryPoint = await this.idempotency.getResumePoint(idempotencyKey);
        if (recoveryPoint !== 'captured' && recoveryPoint !== 'completed') {
          try {
            await this.idempotency.advanceSagaCheckpoint(ownership, 'captured');
          } catch (updateErr: unknown) {
            if (isOwnershipLost(updateErr)) return;
            this.logger.error(
              `Failed to advance recovery point to 'captured' for payment ${paymentId}: ${
                updateErr instanceof Error ? updateErr.message : String(updateErr)
              }`,
            );
          }
        }

        this.logger.error(
          `CRITICAL: Background confirmation failed after Stripe capture for payment ${paymentId}. Customer has been charged. Retries will attempt to resume post-capture updates.`,
          error instanceof Error ? error.stack : undefined,
        );
        return;
      }

      const duffelEvent = await this.prisma.paymentEvent.findFirst({
        where: {
          paymentId,
          eventType: 'duffel_order_created',
        },
        orderBy: { createdAt: 'desc' },
      });

      if (authOutcome.status === 'authorized' || authOutcome.status === 'voided') {
        if (duffelEvent) {
          const duffelOrder = duffelEvent.metadata as Record<string, unknown> | null;
          const duffelOrderId = duffelOrder?.id as string | undefined;
          if (duffelOrderId) {
            try {
              await this.fulfillmentGateway.cancelOrder(duffelOrderId, control);
            } catch (cancelError: unknown) {
              if (isOwnershipLost(cancelError)) return;
              const err = cancelError as Error;
              this.logger.error(`Background cancelOrder failed: ${err.message}`);
            }
          }
        }

        if (authOutcome.status === 'authorized') {
          try {
            await this.paymentGateway.voidHold(payment.stripePaymentIntentId, control);
          } catch (voidError: unknown) {
            if (isOwnershipLost(voidError)) return;
            const err = voidError as Error;
            this.logger.error(`Background voidHold failed: ${err.message}`);
          }
        }
      }

      const bookingIntent = await this.prisma.bookingIntent.findUnique({
        where: { id: payment.bookingIntentId },
        include: { passengers: true, user: true },
      });
      const nextBookingStatus =
        (bookingIntent?.paymentAttemptCount || 0) < 2 ? 'AWAITING_PAYMENT' : 'CANCELLED';

      const booking = await this.prisma.booking.findFirst({
        where: { paymentId: payment.id },
      });

      let flightSnap: FlightSnapshot | undefined;
      let passSnap: PassengerSnapshot | undefined;
      let departAt: Date | undefined;
      if (booking && duffelEvent) {
        try {
          const rawOrder = duffelEvent.metadata as Record<string, unknown>;
          if (rawOrder && rawOrder.id) {
            const passengerEnrichment: PassengerEnrichmentInput[] = (
              bookingIntent?.passengers || []
            ).map((p) => ({
              id: p.id,
              firstName: p.givenName,
              lastName: p.familyName,
              title: p.title ?? undefined,
              gender: p.gender ?? undefined,
              dateOfBirth: p.dateOfBirth
                ? p.dateOfBirth instanceof Date
                  ? p.dateOfBirth.toISOString().split('T')[0]
                  : String(p.dateOfBirth).split('T')[0]
                : undefined,
              passengerType: p.type ? String(p.type).toLowerCase() : undefined,
              email: p.email ?? undefined,
              phoneNumber: p.phoneNumber ?? undefined,
            }));
            const contactEmail = bookingIntent?.user?.email || '';

            const snaps = await this.fulfillmentGateway.retrieveOrderSnapshot(
              rawOrder.id as string,
              rawOrder as PersistedOrderEvidence,
              passengerEnrichment,
              contactEmail,
              control,
            );
            flightSnap = snaps.flightSnapshot;
            passSnap = snaps.passengerSnapshot;
            departAt = snaps.departureAt;
          }
        } catch (e: unknown) {
          if (isOwnershipLost(e)) return;
          const err = e as Error;
          this.logger.warn(
            `Failed to recover Duffel order snapshots in background handler: ${err.message}`,
            err.stack,
          );
        }
      }

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
          await this.bookingLifecycleService.updateToFailed(
            booking.id,
            BookingFailureReason.SYSTEM_ERROR,
            flightSnap,
            passSnap,
            departAt,
            tx,
          );
        }
      });

      const errObj = error as Error;
      await this.idempotency.completeSagaKeyAtomic(ownership, HttpStatus.BAD_GATEWAY, {
        success: false,
        error: `Background processing failed: ${errObj.message || 'Unknown error'}. Hold released.`,
        bookingStatus: nextBookingStatus,
      });
    } catch (err: unknown) {
      if (isOwnershipLost(err)) return;
      const errorObj = err as Error;
      this.logger.error(
        `Error in handleBackgroundError: ${errorObj.message}`,
        errorObj.stack,
      );
    }
  }
}
