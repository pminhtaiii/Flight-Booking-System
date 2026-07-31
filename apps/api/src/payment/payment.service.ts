import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  GoneException,
  InternalServerErrorException,
  HttpStatus,
  HttpException,
  Optional,
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
import { Prisma, BookingFailureReason, AncillarySelectionStatus } from '@prisma/client';

import { BookingService } from '@/booking/booking.service';
import { forwardRef, Inject } from '@nestjs/common';
import { FlightSnapshot, PassengerSnapshot } from '@shared/booking-types';
import { AncillaryPaymentValidationService } from '@/payment/ancillary-payment-validation.service';
import type { ValidatedAncillaryPayment } from '@/payment/ancillary-payment-validation.service';

function majorUnitsToMinorBigInt(amount: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount);
  if (!match) {
    throw new BadRequestException('Invalid authoritative payment amount');
  }

  const fractional = (match[2] ?? '').padEnd(2, '0');
  return BigInt(match[1]) * 100n + BigInt(fractional || '0');
}

function majorUnitsToMinor(amount: string): number {
  const minor = majorUnitsToMinorBigInt(amount);
  if (minor > 2_147_483_647n) {
    throw new BadRequestException('Authoritative payment amount is too large');
  }

  return parseInt(minor.toString(), 10);
}

function authoritativeAmountsEqual(
  persisted: Prisma.Decimal | string | null,
  validated: string,
): boolean {
  if (persisted === null) {
    return false;
  }

  try {
    return majorUnitsToMinorBigInt(String(persisted)) === majorUnitsToMinorBigInt(validated);
  } catch {
    return false;
  }
}

function canonicalOrderServices(selection: {
  seatSelections: Array<{ serviceId: string }>;
  baggageSelections: Array<{ serviceId: string; quantity: number }>;
}): Array<{ id: string; quantity: number }> {
  const quantities = new Map<string, number>();

  for (const seat of selection.seatSelections) {
    quantities.set(seat.serviceId, (quantities.get(seat.serviceId) ?? 0) + 1);
  }
  for (const baggage of selection.baggageSelections) {
    quantities.set(
      baggage.serviceId,
      (quantities.get(baggage.serviceId) ?? 0) + baggage.quantity,
    );
  }

  return [...quantities.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, quantity]) => ({ id, quantity }));
}

type PaymentReservation = {
  bookingIntentId: string;
  ancillarySelectionId: string;
  ancillarySelectionVersion: number;
  attemptNumber: number;
  amount: number;
  currency: string;
  validatedAncillary: ValidatedAncillaryPayment;
  intentExpiresAt: string;
  offerExpiresAt: string | null;
  validatedAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidatedService(
  value: unknown,
): value is { serviceId: string; quantity: number } {
  return (
    isRecord(value) &&
    typeof value.serviceId === 'string' &&
    typeof value.quantity === 'number'
  );
}

function readPaymentReservation(
  value: unknown,
  dto: CreatePaymentDto,
): PaymentReservation | undefined {
  if (!isRecord(value) || !isRecord(value.paymentReservation)) {
    return undefined;
  }
  const reservation = value.paymentReservation;
  const validated = reservation.validatedAncillary;
  if (
    typeof reservation.bookingIntentId !== 'string' ||
    reservation.bookingIntentId !== dto.bookingIntentId ||
    typeof reservation.ancillarySelectionId !== 'string' ||
    reservation.ancillarySelectionId !== dto.ancillarySelectionId ||
    typeof reservation.ancillarySelectionVersion !== 'number' ||
    reservation.ancillarySelectionVersion !== dto.ancillarySelectionVersion ||
    typeof reservation.attemptNumber !== 'number' ||
    typeof reservation.amount !== 'number' ||
    typeof reservation.currency !== 'string' ||
    typeof reservation.intentExpiresAt !== 'string' ||
    (reservation.offerExpiresAt !== null && typeof reservation.offerExpiresAt !== 'string') ||
    typeof reservation.validatedAt !== 'string' ||
    !isRecord(validated) ||
    typeof validated.selectionId !== 'string' ||
    validated.selectionId !== dto.ancillarySelectionId ||
    typeof validated.selectionVersion !== 'number' ||
    validated.selectionVersion !== dto.ancillarySelectionVersion ||
    typeof validated.baseAmount !== 'string' ||
    typeof validated.grandTotal !== 'string' ||
    typeof validated.currency !== 'string' ||
    !Array.isArray(validated.services) ||
    !validated.services.every(isValidatedService)
  ) {
    return undefined;
  }

  return {
    bookingIntentId: reservation.bookingIntentId,
    ancillarySelectionId: reservation.ancillarySelectionId,
    ancillarySelectionVersion: reservation.ancillarySelectionVersion,
    attemptNumber: reservation.attemptNumber,
    amount: reservation.amount,
    currency: reservation.currency,
    intentExpiresAt: reservation.intentExpiresAt,
    offerExpiresAt: reservation.offerExpiresAt,
    validatedAt: reservation.validatedAt,
    validatedAncillary: {
      selectionId: validated.selectionId,
      selectionVersion: validated.selectionVersion,
      baseAmount: validated.baseAmount,
      grandTotal: validated.grandTotal,
      currency: validated.currency,
      services: validated.services.map((service) => ({
        serviceId: service.serviceId,
        quantity: service.quantity,
      })),
    },
  };
}

function redactDuffelOrder(duffelOrder: any): any {
  if (!duffelOrder) return duffelOrder;
  const copy = JSON.parse(JSON.stringify(duffelOrder));
  if (Array.isArray(copy.passengers)) {
    for (const p of copy.passengers) {
      if (p.email !== undefined) p.email = 'REDACTED';
      if (p.phone_number !== undefined) p.phone_number = 'REDACTED';
      if (p.born_on !== undefined) p.born_on = 'REDACTED';
      if (p.given_name !== undefined) p.given_name = 'REDACTED';
      if (p.family_name !== undefined) p.family_name = 'REDACTED';
    }
  }
  return copy;
}

function enrichRedactedDuffelOrder(duffelOrder: any, dbPassengers: any[], userEmail: string): any {
  if (!duffelOrder) return duffelOrder;
  const copy = JSON.parse(JSON.stringify(duffelOrder));
  if (Array.isArray(copy.passengers)) {
    copy.passengers.forEach((p: any, i: number) => {
      const dbPass = dbPassengers.find((dbp: any) => dbp.duffelPassengerId === p.id) || dbPassengers[i];
      if (dbPass) {
        p.given_name = dbPass.givenName;
        p.family_name = dbPass.familyName;
        if (dbPass.dateOfBirth) {
          const d = new Date(dbPass.dateOfBirth);
          if (!isNaN(d.getTime())) {
            p.born_on = d.toISOString().split('T')[0];
          }
        }
      }
      p.email = userEmail;
    });
  }
  return copy;
}

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
    private readonly ancillaryPaymentValidation?: AncillaryPaymentValidationService,
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
    let paymentIntent: Awaited<ReturnType<StripeService['createPaymentIntent']>> | undefined = undefined;
    let paymentRecord: unknown = null;
    try {
      const requestHash = this.idempotencyService.computeHash(dto);
      const requestPath = '/api/bookings/payment/create';
      let validatedAncillary: ValidatedAncillaryPayment | undefined;
      let recoveredReservation: PaymentReservation | undefined;
      let reuseAttemptNumber: number | undefined;
      let boundPaymentReplay = false;
      if (
        dto.ancillarySelectionId !== undefined ||
        dto.ancillarySelectionVersion !== undefined
      ) {
        if (
          dto.ancillarySelectionId === undefined ||
          dto.ancillarySelectionVersion === undefined
        ) {
          throw new BadRequestException(
            'Ancillary selection ID and version must be provided together',
          );
        }
        if (!this.ancillaryPaymentValidation) {
          throw new InternalServerErrorException(
            'Ancillary payment validation is unavailable',
          );
        }
        const boundPayment = await this.prisma.payment?.findFirst({
          where: {
            bookingIntentId: dto.bookingIntentId,
            ancillarySelectionId: dto.ancillarySelectionId,
            ancillarySelectionVersion: dto.ancillarySelectionVersion,
            idempotencyKey: {
              key: idempotencyKey,
              customerId: userId,
            },
          },
          select: {
            bookingIntentId: true,
            ancillarySelectionId: true,
            ancillarySelectionVersion: true,
          },
        });
        boundPaymentReplay =
          boundPayment?.bookingIntentId === dto.bookingIntentId &&
          boundPayment.ancillarySelectionId === dto.ancillarySelectionId &&
          boundPayment.ancillarySelectionVersion === dto.ancillarySelectionVersion;
        if (!boundPaymentReplay) {
          const existingKey = await this.prisma.idempotencyKey?.findUnique({
            where: { key: idempotencyKey },
          });
          if (
            existingKey?.requestHash === requestHash &&
            existingKey.customerId === userId &&
            existingKey.requestPath === requestPath
          ) {
            recoveredReservation = readPaymentReservation(existingKey.requestParams, dto);
          }
          if (recoveredReservation) {
            const nowTime = Date.now();
            const validatedTime = new Date(recoveredReservation.validatedAt).getTime();
            const intentExpiresTime = new Date(recoveredReservation.intentExpiresAt).getTime();
            const offerExpiresTime = recoveredReservation.offerExpiresAt ? new Date(recoveredReservation.offerExpiresAt).getTime() : null;

            const isStale = (nowTime - validatedTime > 60_000) ||
                            (intentExpiresTime <= nowTime) ||
                            (offerExpiresTime !== null && offerExpiresTime <= nowTime);

            if (isStale) {
              reuseAttemptNumber = recoveredReservation.attemptNumber;
              recoveredReservation = undefined;
            }
          }
          if (!recoveredReservation) {
            validatedAncillary = await this.ancillaryPaymentValidation.validateForPayment({
              userId,
              bookingIntentId: dto.bookingIntentId,
              ancillarySelectionId: dto.ancillarySelectionId,
              ancillarySelectionVersion: dto.ancillarySelectionVersion,
            });
          }
        }
      }

      // 1. Check/acquire the request idempotency key
      const idempotency = await this.idempotencyService.acquireOrReplay(
        idempotencyKey,
        requestHash,
        userId,
        requestPath,
      );

      if (idempotency.status === 'replay') {
        return JSON.parse(idempotency.responseBody);
      }

      if (recoveredReservation) {
        const acquiredKey = await this.prisma.idempotencyKey.findUnique({
          where: { key: idempotencyKey },
        });
        if (
          acquiredKey?.requestHash !== requestHash ||
          acquiredKey.customerId !== userId ||
          acquiredKey.requestPath !== requestPath
        ) {
          throw new ConflictException('Payment reservation is no longer available');
        }
        recoveredReservation = readPaymentReservation(acquiredKey.requestParams, dto);
        if (!recoveredReservation) {
          throw new ConflictException('Payment reservation is no longer available');
        }
        validatedAncillary = recoveredReservation.validatedAncillary;
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
        validated = await this.ancillaryPaymentValidation.validateForPayment({
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
          confirmedPrice: Prisma.Decimal | string;
          currency: string;
          userId: string;
          currentAncillarySelectionId: string | null;
          ancillaryVersion: number;
          intentExpiresAt: Date;
          offerExpiresAt: Date | null;
        }

        const intents = await tx.$queryRaw<RawBookingIntent[]>`
          SELECT id, status, "paymentAttemptCount", "confirmedPrice", currency, "userId",
                 "currentAncillarySelectionId", "ancillaryVersion", "intentExpiresAt", "offerExpiresAt"
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

        const now = new Date();
        if (intent.intentExpiresAt && new Date(intent.intentExpiresAt) <= now) {
          throw new GoneException('Booking intent has expired');
        }
        if (intent.offerExpiresAt && new Date(intent.offerExpiresAt) <= now) {
          throw new GoneException('Offer has expired');
        }

        if (!dto.ancillarySelectionId && intent.currentAncillarySelectionId) {
          const seatCount = await tx.seatSelection.count({
            where: { ancillarySelectionId: intent.currentAncillarySelectionId },
          });
          const baggageCount = await tx.baggageSelection.count({
            where: { ancillarySelectionId: intent.currentAncillarySelectionId },
          });
          if (seatCount > 0 || baggageCount > 0) {
            throw new BadRequestException('Ancillary selections exist but were not included in the payment request');
          }
        }

        if (
          (validatedAncillary &&
            intent.status !== 'PENDING' &&
            !(recoveredReservation && intent.status === 'AWAITING_PAYMENT')) ||
          (!validatedAncillary &&
            intent.status !== 'PENDING' &&
            intent.status !== 'AWAITING_PAYMENT')
        ) {
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
            amount: existingPayment.amount,
            currency: existingPayment.currency.toUpperCase(),
            attemptNumber: existingPayment.attemptNumber,
            payment: existingPayment,
          };
        }

        if (!recoveredReservation && intent.paymentAttemptCount >= 2) {
          throw new BadRequestException('Payment attempts exhausted');
        }

        const nextAttemptCount =
          recoveredReservation?.attemptNumber ?? reuseAttemptNumber ?? intent.paymentAttemptCount + 1;
        const amount =
          recoveredReservation?.amount ??
          (validatedAncillary
            ? majorUnitsToMinor(validatedAncillary.grandTotal)
            : majorUnitsToMinor(String(intent.confirmedPrice)));
        const currency =
          recoveredReservation?.currency ?? validatedAncillary?.currency ?? intent.currency;
        if (validatedAncillary) {
          if (
            intent.currentAncillarySelectionId !== validatedAncillary.selectionId ||
            intent.ancillaryVersion !== validatedAncillary.selectionVersion
          ) {
            throw new ConflictException({
              code: 'ANCILLARY_VERSION_CONFLICT',
              intentId: dto.bookingIntentId,
              currentVersion: intent.ancillaryVersion,
            });
          }
          if (intent.currency.toUpperCase() !== validatedAncillary.currency.toUpperCase()) {
            throw new BadRequestException({
              code: 'ANCILLARY_CURRENCY_MISMATCH',
              intentId: dto.bookingIntentId,
            });
          }
          interface RawAncillarySelection {
            id: string;
            status: string;
            currency: string;
            validatedBaseAmount: Prisma.Decimal | string | null;
            validatedGrandTotal: Prisma.Decimal | string | null;
            validationLeaseToken: string | null;
            validationLeaseExpiresAt: Date | null;
            validatedAt: Date | null;
          }
          const selections = await tx.$queryRaw<RawAncillarySelection[]>`
            SELECT id, status, currency, "validatedBaseAmount", "validatedGrandTotal",
                   "validationLeaseToken", "validationLeaseExpiresAt", "validatedAt"
            FROM ancillary_selections
            WHERE id = ${validatedAncillary.selectionId}
              AND "bookingIntentId" = ${dto.bookingIntentId}
              AND version = ${validatedAncillary.selectionVersion}
            FOR UPDATE
          `;
          const selection = selections[0];
          const validatedAtTime = selection?.validatedAt ? new Date(selection.validatedAt).getTime() : 0;
          if (
            selections.length !== 1 ||
            selection.status !== 'VALIDATED' ||
            (Date.now() - validatedAtTime) > 60_000 ||
            selection.currency.toUpperCase() !== validatedAncillary.currency.toUpperCase() ||
            !authoritativeAmountsEqual(
              selection.validatedBaseAmount,
              validatedAncillary.baseAmount,
            ) ||
            !authoritativeAmountsEqual(
              selection.validatedGrandTotal,
              validatedAncillary.grandTotal,
            ) ||
            selection.validationLeaseToken !== null ||
            selection.validationLeaseExpiresAt !== null
          ) {
            throw new ConflictException({
              code: 'ANCILLARY_VERSION_CONFLICT',
              intentId: dto.bookingIntentId,
              currentVersion: intent.ancillaryVersion,
            });
          }

          if (!recoveredReservation) {
            const reservation: PaymentReservation = {
              bookingIntentId: dto.bookingIntentId,
              ancillarySelectionId: validatedAncillary.selectionId,
              ancillarySelectionVersion: validatedAncillary.selectionVersion,
              attemptNumber: nextAttemptCount,
              amount,
              currency,
              validatedAncillary,
              intentExpiresAt: intent.intentExpiresAt ? new Date(intent.intentExpiresAt).toISOString() : new Date(Date.now() + 600000).toISOString(),
              offerExpiresAt: intent.offerExpiresAt ? new Date(intent.offerExpiresAt).toISOString() : null,
              validatedAt: selection.validatedAt ? new Date(selection.validatedAt).toISOString() : new Date().toISOString(),
            };
            const reserved = await tx.$executeRaw`
              WITH reserved_key AS (
                UPDATE idempotency_keys
                SET "requestParams" = jsonb_build_object(
                  'paymentReservation',
                  ${reservation}::jsonb
                )
                WHERE "key" = ${idempotencyKey}
                  AND "requestHash" = ${requestHash}
                  AND "customerId" = ${userId}
                  AND "requestPath" = ${requestPath}
                  AND "lockedAt" = ${idempotency.lockedAt}
                RETURNING id
              )
              UPDATE booking_intents
              SET "paymentAttemptCount" = ${nextAttemptCount}, status = 'AWAITING_PAYMENT'
              WHERE id = ${dto.bookingIntentId}
                AND EXISTS (SELECT 1 FROM reserved_key)
            `;
            if (reserved !== 1) {
              throw new ConflictException('Payment reservation ownership was lost');
            }
          }
        } else {
          if (!recoveredReservation) {
            await tx.$executeRaw`
              UPDATE booking_intents
              SET "paymentAttemptCount" = ${nextAttemptCount}, status = 'AWAITING_PAYMENT'
              WHERE id = ${dto.bookingIntentId}
            `;
          }
        }

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
          amount,
          currency,
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
      const amountInCents = result.amount;
      const stripeMetadata: Record<string, string> = validatedAncillary || boundPaymentReplay
        ? {
            bookingIntentId: dto.bookingIntentId,
            ancillarySelectionId:
              validatedAncillary?.selectionId ?? dto.ancillarySelectionId!,
            ancillarySelectionVersion: String(
              validatedAncillary?.selectionVersion ?? dto.ancillarySelectionVersion,
            ),
          }
        : { bookingIntentId: dto.bookingIntentId };
      const paymentIntent = await this.stripeService.createPaymentIntent(
        amountInCents,
        result.currency,
        stripeCustomerId,
        stripeMetadata,
        `${idempotencyKey}-stripe-intent`,
        dto.paymentMethodId,
        dto.saveCard ? 'off_session' : undefined,
      );

      // 5. Create Payment record in DB
      let payment;
      if (validatedAncillary) {
        payment = await this.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`
            SELECT id
            FROM booking_intents
            WHERE id = ${dto.bookingIntentId}
            FOR UPDATE
          `;
          const existingPayment = await tx.payment.findFirst({
            where: {
              idempotencyKey: { key: idempotencyKey },
            },
          });
          if (existingPayment) {
            return existingPayment;
          }

          const bound = await tx.ancillarySelection.updateMany({
            where: {
              id: validatedAncillary.selectionId,
              bookingIntentId: dto.bookingIntentId,
              version: validatedAncillary.selectionVersion,
              status: 'VALIDATED',
              currency: validatedAncillary.currency,
              validatedBaseAmount: validatedAncillary.baseAmount,
              validatedGrandTotal: validatedAncillary.grandTotal,
            },
            data: { status: 'PAYMENT_BOUND' },
          });
          if (bound.count !== 1) {
            throw new ConflictException({
              code: 'ANCILLARY_VERSION_CONFLICT',
              intentId: dto.bookingIntentId,
              currentVersion: validatedAncillary.selectionVersion,
            });
          }

          const keyRecord = await tx.idempotencyKey.findUnique({
            where: { key: idempotencyKey },
            select: { id: true },
          });
          if (!keyRecord) {
            throw new InternalServerErrorException('Idempotency key record not found');
          }

          const created = await tx.payment.create({
            data: {
              bookingIntentId: dto.bookingIntentId,
              ancillarySelectionId: validatedAncillary.selectionId,
              ancillarySelectionVersion: validatedAncillary.selectionVersion,
              attemptNumber: result.attemptNumber,
              idempotencyKeyId: keyRecord.id,
              stripePaymentIntentId: paymentIntent.id,
              stripeCustomerId,
              amount: amountInCents,
              currency: result.currency.toLowerCase(),
              status: 'CREATED',
            },
          });

          const eventTx = tx.paymentEvent ? tx : this.prisma;
          await eventTx.paymentEvent.create({
            data: {
              paymentId: created.id,
              eventType: 'payment_created',
              previousStatus: 'CREATED',
              newStatus: 'CREATED',
              amount: amountInCents,
              source: 'API',
              createdBy: userId,
              metadata: {
                bookingIntentId: dto.bookingIntentId,
                ancillarySelectionId: validatedAncillary.selectionId,
                ancillarySelectionVersion: validatedAncillary.selectionVersion,
                serviceCount: validatedAncillary.services.length,
                serviceQuantity: validatedAncillary.services.reduce(
                  (total, service) => total + service.quantity,
                  0,
                ),
                baseAmount: validatedAncillary.baseAmount,
                grandTotal: validatedAncillary.grandTotal,
                currency: validatedAncillary.currency,
              },
            },
          });

          await this.auditService.createLog(tx, {
            userId,
            action: 'payment_created',
            resourceType: 'Payment',
            resourceId: created.id,
            ipAddress,
            metadata: {
              bookingIntentId: dto.bookingIntentId,
              amount: amountInCents,
              attemptNumber: result.attemptNumber,
              ancillarySelectionId: validatedAncillary.selectionId,
              ancillarySelectionVersion: validatedAncillary.selectionVersion,
              serviceCount: validatedAncillary.services.length,
              serviceQuantity: validatedAncillary.services.reduce(
                (total, service) => total + service.quantity,
                0,
              ),
              baseAmount: validatedAncillary.baseAmount,
              grandTotal: validatedAncillary.grandTotal,
              currency: validatedAncillary.currency,
            },
          });

          return created;
        });
      } else if ('payment' in result && result.payment) {
        payment = result.payment;
      } else {
        payment = await this.prisma.$transaction(async (tx) => {
          const keyRecord = await tx.idempotencyKey.findUnique({
            where: { key: idempotencyKey },
            select: { id: true },
          });
          if (!keyRecord) {
            throw new InternalServerErrorException('Idempotency key record not found');
          }

          const existingPayment = await tx.payment.findFirst({
            where: {
              idempotencyKeyId: keyRecord.id,
            },
          });

          if (existingPayment) {
            return existingPayment;
          }

          const created = await tx.payment.create({
            data: {
              bookingIntentId: dto.bookingIntentId,
              attemptNumber: result.attemptNumber,
              idempotencyKeyId: keyRecord.id,
              stripePaymentIntentId: paymentIntent.id,
              stripeCustomerId,
              amount: amountInCents,
              currency: result.currency.toLowerCase(),
              status: 'CREATED',
            },
          });

          const eventTx = tx.paymentEvent ? tx : this.prisma;
          await eventTx.paymentEvent.create({
            data: {
              paymentId: created.id,
              eventType: 'payment_created',
              previousStatus: 'CREATED',
              newStatus: 'CREATED',
              amount: amountInCents,
              source: 'API',
              createdBy: userId,
            },
          });

          await this.auditService.createLog(tx, {
            userId,
            action: 'payment_created',
            resourceType: 'Payment',
            resourceId: created.id,
            ipAddress,
            metadata: {
              bookingIntentId: dto.bookingIntentId,
              amount: amountInCents,
              attemptNumber: result.attemptNumber,
            },
          });

          return created;
        });
      }

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
      if (paymentIntent?.id && !paymentRecord) {
        try {
          await this.stripeService.cancelPaymentIntent(paymentIntent.id);
        } catch (cancelErr) {
          this.logger.error(
            `Failed to cancel Stripe PaymentIntent ${paymentIntent.id} after createPayment error: ${cancelErr instanceof Error ? cancelErr.message : String(cancelErr)}`
          );
        }
      }
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
            orderPayment.ancillarySelectionVersion ===
              payment.ancillarySelectionVersion &&
            (hasAncillaryBinding
              ? orderPayment.ancillarySelection?.id ===
                  payment.ancillarySelectionId &&
                orderPayment.ancillarySelection.version ===
                  payment.ancillarySelectionVersion &&
                orderPayment.ancillarySelection.status === 'PAYMENT_BOUND'
              : orderPayment.ancillarySelection === null);
          if (!hasExactBoundSelection) {
            throw new InternalServerErrorException(
              'Payment-bound ancillary selection could not be recovered',
            );
          }
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
            metadata: redactDuffelOrder(duffelOrder) as Prisma.InputJsonValue,
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

          let reconciledStatus: string;
          try {
            const reconciledIntent = await this.stripeService.retrievePaymentIntent(
              payment.stripePaymentIntentId,
            );
            reconciledStatus = reconciledIntent.status;
          } catch (reconciliationError: unknown) {
            const reconciliationMessage =
              reconciliationError instanceof Error
                ? reconciliationError.message
                : String(reconciliationError);
            this.logger.error(
              `Stripe capture outcome remains unknown for payment ${payment.id}: ${reconciliationMessage}`,
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
            reconciledStatus !== 'succeeded' &&
            reconciledStatus !== 'requires_capture' &&
            reconciledStatus !== 'canceled'
          ) {
            throw new HttpException(
              {
                success: false,
                error: `Stripe capture outcome is not final (${reconciledStatus}). Retry payment confirmation.`,
                bookingStatus: 'PROCESSING',
              },
              HttpStatus.BAD_GATEWAY,
            );
          }

          if (reconciledStatus !== 'succeeded') {

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
            const rawOrder = duffelEvent?.metadata as any;
            if (rawOrder) {
              const fullBookingIntent = await this.prisma.bookingIntent.findUnique({
                where: { id: payment.bookingIntentId },
                include: { passengers: true, user: true },
              });
              const enrichedOrder = fullBookingIntent && fullBookingIntent.user 
                ? enrichRedactedDuffelOrder(rawOrder, fullBookingIntent.passengers, fullBookingIntent.user.email) 
                : rawOrder;
              const snaps = this.duffelService.mapDuffelOrderToSnapshots(enrichedOrder);
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
            const bookingIntent = await tx.bookingIntent.findUnique({
              where: { id: payment.bookingIntentId },
              include: { passengers: true, user: true },
            });
            
            await tx.bookingIntent.update({
              where: { id: payment.bookingIntentId },
              data: { status: 'CONFIRMED' },
            });

            const enrichedOrder = bookingIntent && bookingIntent.user
              ? enrichRedactedDuffelOrder(duffelOrder, bookingIntent.passengers, bookingIntent.user.email)
              : duffelOrder;

            const { flightSnapshot, passengerSnapshot } = this.duffelService.mapDuffelOrderToSnapshots(enrichedOrder);
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
        include: {
          ancillarySelection: {
            include: {
              seatSelections: true,
              baggageSelections: true,
            },
          },
        },
      });

      if (!payment || payment.status === 'SUCCEEDED' || payment.status === 'CANCELLED' || payment.status === 'FAILED' || payment.status === 'EXPIRED') {
        return;
      }

      let paymentIntent;
      try {
        paymentIntent = await this.stripeService.retrievePaymentIntent(payment.stripePaymentIntentId);
      } catch (stripeErr: unknown) {
        this.logger.warn(
          `Failed to retrieve Stripe PaymentIntent for payment ${paymentId}: ${stripeErr instanceof Error ? stripeErr.message : String(stripeErr)}`
        );
        return; // warn & return early (recoverable)
      }

      const finalStatuses = ['succeeded', 'requires_capture', 'canceled'];
      if (!paymentIntent || !finalStatuses.includes(paymentIntent.status)) {
        this.logger.warn(
          `Stripe PaymentIntent for payment ${paymentId} is in non-final status: ${paymentIntent?.status}. Warning & returning early.`
        );
        return; // warn & return early (recoverable)
      }

      if (paymentIntent.status === 'succeeded') {
        const recoveryPoint = await this.idempotencyService.getResumePoint(idempotencyKey);
        if (recoveryPoint !== 'captured' && recoveryPoint !== 'completed') {
          try {
            await this.idempotencyService.updateRecoveryPoint(idempotencyKey, 'captured');
          } catch (updateErr: unknown) {
            this.logger.error(
              `Failed to update recovery point to 'captured' for payment ${paymentId}: ${updateErr instanceof Error ? updateErr.message : String(updateErr)}`
            );
          }
        }

        this.logger.error(
          `CRITICAL: Background confirmation failed after Stripe capture for payment ${paymentId}. Customer has been charged. Recovery point is '${recoveryPoint || 'started'}'. Retries will attempt to resume post-capture updates.`,
          error instanceof Error ? error.stack : undefined
        );
        return; // mark captured & return
      }

      // Check if Duffel order was created
      const duffelEvent = await this.prisma.paymentEvent.findFirst({
        where: {
          paymentId,
          eventType: 'duffel_order_created',
        },
        orderBy: { createdAt: 'desc' },
      });

      if (paymentIntent.status === 'requires_capture' || paymentIntent.status === 'canceled') {
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

        if (paymentIntent.status === 'requires_capture') {
          // Release hold if authorized
          try {
            await this.stripeService.cancelPaymentIntent(payment.stripePaymentIntentId);
          } catch (stripeError: unknown) {
            const err = stripeError as Error;
            this.logger.error(`Background cancelPaymentIntent failed: ${err.message}`);
          }
        }
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
