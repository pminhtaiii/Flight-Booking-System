import {
  Injectable,
  ConflictException,
  NotFoundException,
  ForbiddenException,
  GoneException,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { StripeService } from '@/common/stripe.service';
import { DuffelService } from '@/duffel/duffel.service';
import { PaymentIdempotencyService } from './payment-idempotency.service';
import { PaymentLedgerService } from './payment-ledger.service';
import { AuditService } from '@/audit/audit.service';
import { EncryptionService } from '@/common/encryption.service';
import { enforceTransition } from './payment-state-machine';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { ConfirmPaymentDto } from './dto/confirm-payment.dto';
import {
  CreatePaymentResponseDto,
  ConfirmPaymentResponseDto,
  AsyncConfirmPaymentResponseDto,
} from './dto/payment-response.dto';
import { PaymentStatus, Prisma } from '@prisma/client';
import { PaymentMethodService } from './payment-method.service';

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
    private readonly duffelService: DuffelService,
    private readonly idempotencyService: PaymentIdempotencyService,
    private readonly ledgerService: PaymentLedgerService,
    private readonly auditService: AuditService,
    private readonly encryptionService: EncryptionService,
    private readonly paymentMethodService: PaymentMethodService
  ) {}

  /**
   * Creates a new PaymentIntent and records the Payment in the DB.
   */
  async createPayment(
    userId: string,
    dto: CreatePaymentDto,
    idempotencyKey: string
  ): Promise<CreatePaymentResponseDto> {
    const requestHash = this.idempotencyService.computeHash(dto);
    const result = await this.idempotencyService.acquireOrReplay({
      key: idempotencyKey,
      requestHash,
      customerId: userId,
      requestPath: '/api/payments/create',
      requestParams: dto,
    });

    if (result.status === 'replay') {
      return result.responseBody as CreatePaymentResponseDto;
    }

    const { bookingIntentId } = dto;

    try {
      const paymentRes = await this.prisma.$transaction(async (tx) => {
        // Pessimistic lock on BookingIntent
        const intents = await tx.$queryRaw<any[]>`
          SELECT * FROM booking_intents WHERE id = ${bookingIntentId} FOR UPDATE
        `;
        const intent = intents[0];

        if (!intent) {
          throw new NotFoundException({
            code: 'INTENT_NOT_FOUND',
            message: 'Booking intent not found',
          });
        }

        if (intent.userId !== userId) {
          throw new ForbiddenException({
            code: 'FORBIDDEN',
            message: 'Booking intent belongs to another user',
          });
        }

        if (intent.status === 'EXPIRED') {
          throw new GoneException({
            code: 'INTENT_EXPIRED',
            message: 'Booking intent expired',
          });
        }

        if (intent.paymentAttemptCount >= 2) {
          throw new HttpException(
            {
              code: 'ATTEMPTS_EXHAUSTED',
              message: 'Payment attempts exhausted (max 2)',
            },
            HttpStatus.TOO_MANY_REQUESTS
          );
        }

        // Pessimistic lock: Check if there's already an active payment in progress
        const activePayment = await tx.payment.findFirst({
          where: {
            bookingIntentId,
            status: {
              in: [
                PaymentStatus.CREATED,
                PaymentStatus.AUTHORIZED,
                PaymentStatus.SUCCEEDED,
                PaymentStatus.REFUND_PENDING,
                PaymentStatus.PARTIALLY_REFUNDED,
                PaymentStatus.REFUNDED,
                PaymentStatus.DISPUTED,
              ],
            },
          },
        });

        if (activePayment) {
          throw new ConflictException({
            code: 'PAYMENT_IN_PROGRESS',
            message: 'Booking intent already has an active payment in progress',
          });
        }

        const attemptNumber = intent.paymentAttemptCount + 1;
        const updatedIntent = await tx.bookingIntent.update({
          where: { id: bookingIntentId },
          data: {
            paymentAttemptCount: attemptNumber,
            status: 'AWAITING_PAYMENT',
          },
        });

        return { attemptNumber, updatedIntent };
      });

      // Get the user's stripeCustomerId
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, stripeCustomerId: true },
      });

      if (!user) {
        throw new NotFoundException({
          code: 'USER_NOT_FOUND',
          message: 'User not found',
        });
      }

      let stripeCustomerId = user.stripeCustomerId;

      // Lazy create Stripe Customer if it doesn't exist
      if (!stripeCustomerId) {
        const stripeCustomer = await this.stripeService.createCustomer({
          email: user.email,
          idempotencyKey: `customer-create:${user.id}`,
        });
        stripeCustomerId = stripeCustomer.id;

        await this.prisma.user.update({
          where: { id: user.id },
          data: { stripeCustomerId },
        });
      }

      // Check if a saved payment method is being used
      let stripePaymentMethodId: string | undefined = undefined;
      if (dto.paymentMethodId) {
        const savedMethod = await this.prisma.paymentMethod.findUnique({
          where: { id: dto.paymentMethodId },
        });

        if (!savedMethod || savedMethod.userId !== userId || savedMethod.status !== 'ACTIVE') {
          throw new NotFoundException({
            code: 'PAYMENT_METHOD_NOT_FOUND',
            message: 'Saved payment method not found or inactive',
          });
        }
        stripePaymentMethodId = savedMethod.stripePaymentMethodId;
      }

      const amountCents = Math.round(Number(paymentRes.updatedIntent.confirmedPrice) * 100);
      const currency = paymentRes.updatedIntent.currency.toLowerCase();

      // Call Stripe to create PaymentIntent (capture_method: 'manual')
      const stripeIntent = await this.stripeService.createPaymentIntent({
        amount: amountCents,
        currency,
        idempotencyKey: `payment-create:${bookingIntentId}:${paymentRes.attemptNumber}`,
        setupFutureUsage: dto.saveCard ? 'off_session' : undefined,
        paymentMethodId: stripePaymentMethodId,
        customerId: stripeCustomerId,
      });

      // Write Payment & Event
      const payment = await this.prisma.$transaction(async (tx) => {
        const createdPayment = await tx.payment.create({
          data: {
            bookingIntentId,
            attemptNumber: paymentRes.attemptNumber,
            stripePaymentIntentId: stripeIntent.id,
            stripeCustomerId: stripeIntent.customer as string | null,
            amount: amountCents,
            currency,
            status: PaymentStatus.CREATED,
            idempotencyKeyId: result.idempotencyKey.id,
          },
        });

        await tx.paymentEvent.create({
          data: {
            paymentId: createdPayment.id,
            eventType: 'payment_intent.created',
            previousStatus: PaymentStatus.CREATED,
            newStatus: PaymentStatus.CREATED,
            amount: amountCents,
            source: 'API',
            createdBy: userId,
          },
        });

        // Audit Log
        await this.auditService.createLog(tx, {
          userId,
          action: 'payment_created',
          resourceType: 'Payment',
          resourceId: createdPayment.id,
          metadata: {
            paymentId: createdPayment.id,
            bookingIntentId,
            amount: amountCents,
            attemptNumber: paymentRes.attemptNumber,
          },
        });

        return createdPayment;
      });

      const response: CreatePaymentResponseDto = {
        paymentId: payment.id,
        stripeClientSecret: stripeIntent.client_secret,
        attemptNumber: payment.attemptNumber,
        amount: payment.amount,
        currency: payment.currency,
        status: payment.status,
        requiresAction: stripeIntent.status === 'requires_action',
      };

      await this.idempotencyService.completeKey(idempotencyKey, HttpStatus.CREATED, response, result.leaseToken!);
      return response;
    } catch (error) {
      if (result.status === 'acquired') {
        await this.idempotencyService.releaseLock(idempotencyKey, result.leaseToken!);
      }
      if (error instanceof HttpException && error.getStatus() === HttpStatus.TOO_MANY_REQUESTS) {
        const response = error.getResponse() as any;
        if (response && response.code === 'ATTEMPTS_EXHAUSTED') {
          try {
            await this.prisma.bookingIntent.update({
              where: { id: bookingIntentId },
              data: { status: 'PAYMENT_EXHAUSTED' },
            });
          } catch (updateError: any) {
            this.logger.error(`Failed to update booking intent status to PAYMENT_EXHAUSTED: ${updateError?.message || updateError}`);
          }
        }
      }
      throw error;
    }
  }

  /**
   * Confirms payment and triggers the authorize -> Duffel -> capture pipeline.
   */
  async confirmPayment(
    userId: string,
    dto: ConfirmPaymentDto,
    idempotencyKey: string
  ): Promise<ConfirmPaymentResponseDto | AsyncConfirmPaymentResponseDto> {
    const requestHash = this.idempotencyService.computeHash(dto);
    const result = await this.idempotencyService.acquireOrReplay({
      key: idempotencyKey,
      requestHash,
      customerId: userId,
      requestPath: '/api/payments/confirm',
      requestParams: dto,
    });

    if (result.status === 'replay') {
      return result.responseBody as ConfirmPaymentResponseDto | AsyncConfirmPaymentResponseDto;
    }

    const { paymentId } = dto;
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        bookingIntent: {
          include: {
            passengers: true,
            user: true,
          },
        },
      },
    });

    if (!payment) {
      if (result.status === 'acquired') {
        await this.idempotencyService.releaseLock(idempotencyKey, result.leaseToken!);
      }
      throw new NotFoundException({
        code: 'PAYMENT_NOT_FOUND',
        message: 'Payment not found',
      });
    }

    if (payment.bookingIntent.userId !== userId) {
      if (result.status === 'acquired') {
        await this.idempotencyService.releaseLock(idempotencyKey, result.leaseToken!);
      }
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Access denied',
      });
    }

    const recoveryPoint = result.idempotencyKey.recoveryPoint;

    // Use a 25-second timeout threshold for synchronous response, else yield 202
    const timeoutPromise = new Promise<{ isTimeout: true }>((resolve) => {
      setTimeout(() => resolve({ isTimeout: true }), 25000);
    });

    const pipelinePromise = this.runConfirmPipeline(
      payment,
      recoveryPoint,
      idempotencyKey,
      userId,
      result.leaseToken!
    );

    try {
      const raceResult = await Promise.race([pipelinePromise, timeoutPromise]);

      if ('isTimeout' in raceResult) {
        // Asynchronous handoff: do not release lock, background pipeline will finish it
        // Attach background handlers to ensure key completion or lock release
        pipelinePromise
          .then(async (val) => {
            await this.idempotencyService.completeKey(
              idempotencyKey,
              HttpStatus.OK,
              val,
              result.leaseToken!
            );
          })
          .catch(async (err) => {
            this.logger.error(`Background payment confirm pipeline failed for key ${idempotencyKey}: ${err.message}`, err.stack);
            if (result.status === 'acquired') {
              await this.idempotencyService.releaseLock(idempotencyKey, result.leaseToken!);
            }
          });

        const response: AsyncConfirmPaymentResponseDto = {
          paymentId: payment.id,
          status: PaymentStatus.AUTHORIZED,
          message: 'Payment authorized. Booking confirmation in progress.',
          pollUrl: `/api/payments/${payment.id}/status`,
        };
        return response;
      }

      await this.idempotencyService.completeKey(idempotencyKey, HttpStatus.OK, raceResult, result.leaseToken!);
      return raceResult;
    } catch (error) {
      if (result.status === 'acquired') {
        await this.idempotencyService.releaseLock(idempotencyKey, result.leaseToken!);
      }
      throw error;
    }
  }

  /**
   * Retrieves payment status.
   */
  async getPaymentStatus(userId: string, paymentId: string): Promise<any> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { bookingIntent: true },
    });

    if (!payment) {
      throw new NotFoundException({
        code: 'PAYMENT_NOT_FOUND',
        message: 'Payment not found',
      });
    }

    if (payment.bookingIntent.userId !== userId) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Access denied',
      });
    }

    let pnrReference: string | undefined = undefined;
    if (payment.status === PaymentStatus.SUCCEEDED) {
      const confirmEvent = await this.prisma.paymentEvent.findFirst({
        where: {
          paymentId: payment.id,
          eventType: 'booking_confirmed',
        },
      });
      if (confirmEvent && confirmEvent.metadata) {
        pnrReference = (confirmEvent.metadata as any).pnrReference;
      }
    }

    return {
      paymentId: payment.id,
      status: payment.status,
      bookingIntentStatus: payment.bookingIntent.status,
      amount: payment.amount,
      currency: payment.currency,
      pnrReference,
      updatedAt: payment.updatedAt.toISOString(),
    };
  }

  /**
   * Core pipeline execution. Supports crash recovery via recoveryPoints.
   */
  private async runConfirmPipeline(
      payment: any,
      startRecoveryPoint: string,
      idempotencyKey: string,
      userId: string,
      leaseToken: string
    ): Promise<ConfirmPaymentResponseDto> {
    let currentPoint = startRecoveryPoint;
    let paymentStatus = payment.status;
    let pnrReference: string | undefined = undefined;

    // Self-heal: If we are resuming from a recovery point after 'started',
    // but the payment status in the database is still CREATED,
    // we must transition it to AUTHORIZED first to preserve FSM flow and logging.
    if (paymentStatus === PaymentStatus.CREATED && currentPoint !== 'started') {
      await this.prisma.$transaction(async (tx) => {
        await tx.payment.update({
          where: { id: payment.id },
          data: { status: PaymentStatus.AUTHORIZED, version: { increment: 1 } },
        });

        await tx.paymentEvent.create({
          data: {
            paymentId: payment.id,
            eventType: 'payment_intent.authorized',
            previousStatus: PaymentStatus.CREATED,
            newStatus: PaymentStatus.AUTHORIZED,
            amount: payment.amount,
            source: 'API',
            createdBy: userId,
          },
        });
      });
      paymentStatus = PaymentStatus.AUTHORIZED;
    }

    // Decrypt passenger sensitive details (passport etc)
    const decryptedPassengers = payment.bookingIntent.passengers.map((p: any) => {
      const copy = { ...p };
      if (p.passportNumber) {
        copy.passportNumber = this.encryptionService.decrypt(p.passportNumber);
      }
      if (p.passportExpiry) {
        copy.passportExpiry = this.encryptionService.decrypt(p.passportExpiry);
      }
      return copy;
    });

    // Step 1: Stripe Authorize verification
    if (currentPoint === 'started') {
      const stripeIntent = await this.stripeService.retrievePaymentIntent(
        payment.stripePaymentIntentId
      );

      if (stripeIntent.status === 'requires_capture') {
        if (payment.status !== PaymentStatus.AUTHORIZED) {
          enforceTransition(payment.status, PaymentStatus.AUTHORIZED);

          await this.prisma.$transaction(async (tx) => {
            await tx.payment.update({
              where: { id: payment.id, version: payment.version },
              data: { status: PaymentStatus.AUTHORIZED, version: { increment: 1 } },
            });

            await tx.paymentEvent.create({
              data: {
                paymentId: payment.id,
                eventType: 'payment_intent.authorized',
                previousStatus: payment.status,
                newStatus: PaymentStatus.AUTHORIZED,
                amount: payment.amount,
                source: 'API',
                createdBy: userId,
              },
            });
          });
        }

        paymentStatus = PaymentStatus.AUTHORIZED;
        currentPoint = 'stripe_authorized';
        await this.idempotencyService.updateRecoveryPoint(idempotencyKey, currentPoint, leaseToken);
      } else {
        enforceTransition(payment.status, PaymentStatus.FAILED);
        await this.prisma.$transaction(async (tx) => {
          await tx.payment.update({
            where: { id: payment.id, version: payment.version },
            data: { status: PaymentStatus.FAILED, version: { increment: 1 } },
          });

          await tx.paymentEvent.create({
            data: {
              paymentId: payment.id,
              eventType: 'payment_intent.failed',
              previousStatus: payment.status,
              newStatus: PaymentStatus.FAILED,
              amount: payment.amount,
              source: 'API',
              createdBy: userId,
            },
          });
        });

        throw new HttpException(
          {
            code: 'PAYMENT_DECLINED',
            message: 'Card declined / authorization failed',
          },
          HttpStatus.PAYMENT_REQUIRED
        );
      }
    }

    // Step 2: Create Duffel Order (PNR)
    if (currentPoint === 'stripe_authorized') {
      try {
        const order = await this.duffelService.createOrder({
          duffelOfferId: payment.bookingIntent.duffelOfferId,
          passengers: decryptedPassengers,
          userEmail: payment.bookingIntent.user?.email || 'usera@example.com',
          rawOfferSnapshot: payment.bookingIntent.rawOfferSnapshot,
        });

        pnrReference = order.booking_reference;
        currentPoint = 'duffel_order_created';

        await this.prisma.paymentEvent.create({
          data: {
            paymentId: payment.id,
            eventType: 'duffel_order_created',
            previousStatus: paymentStatus,
            newStatus: paymentStatus,
            amount: payment.amount,
            source: 'API',
            createdBy: userId,
            metadata: { pnrReference } as any,
          },
        });

        await this.idempotencyService.updateRecoveryPoint(idempotencyKey, currentPoint, leaseToken);
      } catch (error: any) {
        this.logger.error(`Duffel PNR creation failed: ${error.message}`, error.stack);

        // Cancel/void Stripe authorization to protect client funds
        await this.stripeService.cancelPaymentIntent(
          payment.stripePaymentIntentId,
          `void-duffel-fail-${payment.id}`
        );

        enforceTransition(paymentStatus, PaymentStatus.CANCELLED);
        const nextIntentStatus =
          payment.bookingIntent.paymentAttemptCount >= 2 ? 'PAYMENT_EXHAUSTED' : 'AWAITING_PAYMENT';

        await this.prisma.$transaction(async (tx) => {
          await tx.payment.update({
            where: { id: payment.id },
            data: { status: PaymentStatus.CANCELLED },
          });

          await tx.bookingIntent.update({
            where: { id: payment.bookingIntentId },
            data: { status: nextIntentStatus },
          });

          await tx.paymentEvent.create({
            data: {
              paymentId: payment.id,
              eventType: 'payment_intent.canceled',
              previousStatus: paymentStatus,
              newStatus: PaymentStatus.CANCELLED,
              amount: payment.amount,
              source: 'API',
              createdBy: userId,
            },
          });
        });

        throw new HttpException(
          {
            code: 'UPSTREAM_BOOKING_FAILED',
            message: 'Duffel booking failed. Card hold has been voided.',
          },
          HttpStatus.BAD_GATEWAY
        );
      }
    }

    // Step 3: Capture Payment
    if (currentPoint === 'duffel_order_created') {
      const stripeCaptured = await this.stripeService.capturePaymentIntent(
        payment.stripePaymentIntentId,
        `capture-${payment.id}`
      );

      if (stripeCaptured.status === 'succeeded') {
        currentPoint = 'captured';
        await this.idempotencyService.updateRecoveryPoint(idempotencyKey, currentPoint, leaseToken);
      } else {
        throw new HttpException(
          {
            code: 'CAPTURE_FAILED',
            message: 'Stripe capture failed',
          },
          HttpStatus.INTERNAL_SERVER_ERROR
        );
      }
    }

    // Step 4: Ledger entries, BookingIntent status COMPLETED, Audit Logs
    if (currentPoint === 'captured') {
      // If pnrReference is not yet set (crash during capture phase), fetch it from event
      if (!pnrReference) {
        const orderCreatedEvent = await this.prisma.paymentEvent.findFirst({
          where: {
            paymentId: payment.id,
            eventType: 'duffel_order_created',
          },
        });
        if (orderCreatedEvent && orderCreatedEvent.metadata) {
          pnrReference = (orderCreatedEvent.metadata as any).pnrReference;
        }
      }

      await this.prisma.$transaction(async (tx) => {
        enforceTransition(paymentStatus, PaymentStatus.SUCCEEDED);

        await tx.payment.update({
          where: { id: payment.id },
          data: { status: PaymentStatus.SUCCEEDED },
        });

        await tx.bookingIntent.update({
          where: { id: payment.bookingIntentId },
          data: { status: 'COMPLETED' },
        });

        // Record double-entry Ledger
        await this.ledgerService.recordCaptureLedger(
          payment.id,
          payment.amount,
          payment.currency,
          tx
        );

        // Record Audit Event
        await tx.paymentEvent.create({
          data: {
            paymentId: payment.id,
            eventType: 'booking_confirmed',
            previousStatus: PaymentStatus.AUTHORIZED,
            newStatus: PaymentStatus.SUCCEEDED,
            amount: payment.amount,
            source: 'API',
            createdBy: userId,
            metadata: { pnrReference } as any,
          },
        });

        // Audit Log
        await this.auditService.createLog(tx, {
          userId,
          action: 'booking_confirmed',
          resourceType: 'Payment',
          resourceId: payment.id,
          metadata: {
            paymentId: payment.id,
            bookingIntentId: payment.bookingIntentId,
            pnrReference,
          },
        });
      });

      // Synchronize/save the payment method if needed
      await this.paymentMethodService.syncPaymentMethod(payment.id);

      currentPoint = 'completed';
      paymentStatus = PaymentStatus.SUCCEEDED;
    }

    // If PNR reference is still not set (resuming from completed), look it up
    if (!pnrReference) {
      const confirmEvent = await this.prisma.paymentEvent.findFirst({
        where: {
          paymentId: payment.id,
          eventType: 'booking_confirmed',
        },
      });
      if (confirmEvent && confirmEvent.metadata) {
        pnrReference = (confirmEvent.metadata as any).pnrReference;
      }
    }

    return {
      paymentId: payment.id,
      status: paymentStatus,
      bookingIntentStatus: 'COMPLETED',
      pnrReference,
    };
  }
}
