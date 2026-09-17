import { AuditService } from '@/audit/audit.service';
import { BookingLifecycleService } from '@/booking-lifecycle/booking-lifecycle.service';
import { StripeService } from '@/common/stripe.service';
import { DuffelService } from '@/duffel/duffel.service';
import { DuffelFulfillmentAdapter } from '@/duffel/duffel-fulfillment.adapter';
import { AncillaryPaymentValidationService } from '@/payment/ancillary-payment-validation.service';
import { PaymentIdempotencyService, SagaOwnership } from '@/idempotency/payment-idempotency.service';
import { PaymentMethodService } from '@/payment/payment-method.service';
import { PaymentService } from '@/payment/payment.service';
import { PaymentFulfillmentSaga } from '@/payment-fulfillment/payment-fulfillment.saga';
import {
  PaymentGatewayPort,
  PaymentAuthorizationStatus,
  FulfillmentGatewayPort,
  PortInvocationControl,
} from '@/payment-fulfillment/ports';
import { PrismaService } from '@/prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { BadRequestException, GoneException, ConflictException } from '@nestjs/common';

describe('PaymentService - Final Fixes Spec', () => {
  let prisma: any;
  let stripe: any;
  let idempotency: any;
  let duffel: any;
  let audit: any;
  let methodService: any;
  let bookingService: any;
  let validation: any;
  let service: PaymentService;
  let saga: PaymentFulfillmentSaga;
  let mockPaymentGateway: PaymentGatewayPort;
  let mockFulfillmentGateway: FulfillmentGatewayPort;

  beforeEach(() => {
    prisma = {
      $transaction: jest.fn().mockImplementation(async (cb) => cb(prisma)),
      $queryRaw: jest.fn(),
      $executeRaw: jest.fn(),
      payment: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn().mockResolvedValue({ id: 'payment-1', status: 'CREATED' }),
        update: jest.fn(),
        updateMany: jest.fn().mockImplementation(async (args) => {
          if (args?.data) {
            await prisma.payment.update({
              where: { id: args.where?.id ?? 'pay-123' },
              data: args.data,
            });
          }
          return { count: 1 };
        }),
      },
      paymentEvent: {
        create: jest.fn(),
        findFirst: jest.fn(),
      },
      idempotencyKey: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      user: {
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      seatSelection: {
        count: jest.fn(),
      },
      baggageSelection: {
        count: jest.fn(),
      },
      bookingIntent: {
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      booking: {
        findFirst: jest.fn(),
      },
      ledgerEntry: {
        createMany: jest.fn(),
      },
      ancillarySelection: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    stripe = {
      retrievePaymentIntent: jest.fn(),
      createPaymentIntent: jest.fn(),
      cancelPaymentIntent: jest.fn(),
      capturePaymentIntent: jest.fn().mockResolvedValue({ status: 'succeeded' }),
    };
    idempotency = {
      computeHash: jest.fn().mockReturnValue('hash-123'),
      acquireOrReplay: jest.fn().mockResolvedValue({ status: 'acquired' }),
      assertOwned: jest.fn().mockResolvedValue(undefined),
      advanceSagaCheckpoint: jest.fn().mockImplementation(async (ownership: any, checkpoint: string) => {
        const key = typeof ownership === 'string' ? ownership : ownership?.key;
        await idempotency.updateRecoveryPoint(key, checkpoint);
      }),
      completeSagaKeyAtomic: jest.fn().mockResolvedValue(undefined),
      updateRecoveryPoint: jest.fn(),
      completeKey: jest.fn(),
      getResumePoint: jest.fn(),
    };
    duffel = {
      createOrder: jest.fn(),
      cancelOrder: jest.fn(),
      retrieveCompleteOrder: jest.fn(),
      mapDuffelOrderToSnapshots: jest.fn().mockReturnValue({
        flightSnapshot: {},
        passengerSnapshot: {},
      }),
    };
    audit = {
      createLog: jest.fn(),
    };
    methodService = {
      saveMethod: jest.fn(),
    };
    bookingService = {
      updateToFailed: jest.fn(),
      failBooking: jest.fn(),
      createBooking: jest.fn().mockResolvedValue({ id: 'booking-1', userId: 'user-1' }),
      updateToConfirmed: jest.fn().mockResolvedValue(undefined),
      confirmBooking: jest.fn().mockResolvedValue(undefined),
    };
    validation = {
      validateForPayment: jest.fn(),
    };

    mockPaymentGateway = {
      authorizeHold: jest.fn(async (intentId: string, control?: PortInvocationControl) => {
        if (control?.beforeInvoke) await control.beforeInvoke();
        const pi = await stripe.retrievePaymentIntent(intentId);
        const status: PaymentAuthorizationStatus =
          pi?.status === 'requires_capture'
            ? 'authorized'
            : pi?.status === 'succeeded'
              ? 'captured'
              : 'invalid';
        return {
          status,
          intentId,
          amount: pi?.amount ?? 1000,
          currency: pi?.currency ?? 'usd',
          rawStatus: pi?.status,
        };
      }),
      capturePayment: jest.fn(
        async (intentId: string, captureKey: string, control?: PortInvocationControl) => {
          if (control?.beforeInvoke) await control.beforeInvoke();
          const res = await stripe.capturePaymentIntent(intentId, undefined, captureKey);
          return {
            success: res?.status === 'succeeded',
            intentId,
            status: res?.status ?? 'succeeded',
          };
        },
      ),
      voidHold: jest.fn(async (intentId: string, control?: PortInvocationControl) => {
        if (control?.beforeInvoke) await control.beforeInvoke();
        await stripe.cancelPaymentIntent(intentId);
        return {
          success: true,
          intentId,
          status: 'canceled',
        };
      }),
    };

    mockFulfillmentGateway = new DuffelFulfillmentAdapter(duffel as unknown as DuffelService);

    prisma.bookingIntent.findUnique.mockResolvedValue({
      id: 'intent-1',
      userId: 'user-1',
      status: 'PENDING',
      paymentAttemptCount: 1,
      currency: 'USD',
      intentExpiresAt: new Date(Date.now() + 600000),
      offerExpiresAt: new Date(Date.now() + 600000),
      currentAncillarySelectionId: 'sel-1',
      ancillaryVersion: 1,
      passengers: [{ id: 'passenger-1', type: 'adult' }],
    });

    prisma.idempotencyKey.findUnique.mockResolvedValue({
      id: 'key-123',
      requestHash: 'hash-123',
      customerId: 'user-1',
      requestPath: '/api/bookings/payment/create',
      requestParams: {},
    });

    service = new PaymentService(
      prisma as unknown as PrismaService,
      stripe as unknown as StripeService,
      idempotency as unknown as PaymentIdempotencyService,
      audit as unknown as AuditService,
      validation as unknown as AncillaryPaymentValidationService,
    );

    saga = new PaymentFulfillmentSaga(
      mockPaymentGateway,
      mockFulfillmentGateway,
      idempotency as unknown as PaymentIdempotencyService,
      methodService as unknown as PaymentMethodService,
      bookingService as unknown as BookingLifecycleService,
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
    );
  });

  describe('Finding 1: redactDuffelOrder PII redaction', () => {
    it('should redact email, phone_number, born_on, given_name, and family_name recursively in metadata', async () => {
      const duffelOrder = {
        id: 'ord-123',
        booking_reference: 'XYZ123',
        passengers: [
          {
            id: 'p-1',
            email: 'john@example.com',
            phone_number: '+123456789',
            born_on: '1990-01-01',
            given_name: 'John',
            family_name: 'Doe',
          },
        ],
      };

      prisma.bookingIntent.findUnique.mockResolvedValue({
        id: 'intent-1',
        duffelOfferId: 'offer-1',
        passengers: [
          {
            duffelPassengerId: 'p-1',
            givenName: 'John',
            familyName: 'Doe',
            dateOfBirth: new Date('1990-01-01'),
          },
        ],
        user: { email: 'john@example.com' },
        paymentAttemptCount: 1,
      });
      prisma.payment.findUnique.mockResolvedValue({
        id: 'pay-1',
        bookingIntentId: 'intent-1',
        stripePaymentIntentId: 'pi-1',
        stripeCustomerId: 'cus-1',
        amount: 1000,
        currency: 'usd',
        status: 'AUTHORIZED',
        ancillarySelectionId: 'sel-1',
        ancillarySelectionVersion: 1,
        bookingIntent: {
          userId: 'user-1',
        },
        ancillarySelection: {
          id: 'sel-1',
          version: 1,
          status: 'PAYMENT_BOUND',
          seatSelections: [],
          baggageSelections: [],
        },
      });
      stripe.retrievePaymentIntent.mockResolvedValue({ status: 'requires_capture' });
      duffel.createOrder.mockResolvedValue(duffelOrder);
      duffel.retrieveCompleteOrder.mockRejectedValue(new Error('simulated fallback'));

      const redactedDuffelOrder = {
        id: 'ord-123',
        booking_reference: 'XYZ123',
        passengers: [
          {
            id: 'p-1',
            email: 'REDACTED',
            phone_number: 'REDACTED',
            born_on: 'REDACTED',
            given_name: 'REDACTED',
            family_name: 'REDACTED',
          },
        ],
      };

      prisma.paymentEvent.findFirst.mockResolvedValue({
        eventType: 'duffel_order_created',
        metadata: redactedDuffelOrder,
      });

      const dto = { paymentId: 'pay-1', bookingId: 'book-1' };
      await saga.executeConfirmPayment(dto, 'ikey-123', 'user-1');

      expect(prisma.paymentEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          eventType: 'duffel_order_created',
          metadata: expect.objectContaining(redactedDuffelOrder),
        }),
      });
      expect(duffel.mapDuffelOrderToSnapshots).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'ord-123',
          passengers: expect.arrayContaining([
            expect.objectContaining({
              id: 'p-1',
              email: 'john@example.com',
              born_on: '1990-01-01',
              given_name: 'John',
              family_name: 'Doe',
            }),
          ]),
        }),
      );
    });
  });

  describe('Finding 2: handleBackgroundError Stripe checks', () => {
    const ownership: SagaOwnership = {
      key: 'ikey-123',
      userId: 'user-1',
      requestPath: '/api/bookings/payment/confirm',
      requestHash: 'hash-123',
      lockedAt: new Date('2026-09-16T12:00:00Z'),
    };

    it('should warn and return early (recoverable) if Stripe retrieval fails', async () => {
      prisma.payment.findUnique.mockResolvedValue({
        id: 'pay-123',
        status: 'CREATED',
        stripePaymentIntentId: 'pi-123',
      });
      stripe.retrievePaymentIntent.mockRejectedValue(new Error('Stripe network error'));

      await expect(
        saga.handleBackgroundError(
          'pay-123',
          'ikey-123',
          'user-1',
          ownership,
          new Error('some background error'),
        ),
      ).resolves.toBeUndefined();

      expect(prisma.payment.update).not.toHaveBeenCalled();
      expect(stripe.cancelPaymentIntent).not.toHaveBeenCalled();
    });

    it('should warn and return early (recoverable) if Stripe status is non-final (e.g., requires_payment_method)', async () => {
      prisma.payment.findUnique.mockResolvedValue({
        id: 'pay-123',
        status: 'CREATED',
        stripePaymentIntentId: 'pi-123',
      });
      stripe.retrievePaymentIntent.mockResolvedValue({ status: 'requires_payment_method' });

      await expect(
        saga.handleBackgroundError(
          'pay-123',
          'ikey-123',
          'user-1',
          ownership,
          new Error('some background error'),
        ),
      ).resolves.toBeUndefined();

      expect(prisma.payment.update).not.toHaveBeenCalled();
      expect(stripe.cancelPaymentIntent).not.toHaveBeenCalled();
    });

    it('should mark captured and return if Stripe status is succeeded', async () => {
      prisma.payment.findUnique.mockResolvedValue({
        id: 'pay-123',
        status: 'CREATED',
        stripePaymentIntentId: 'pi-123',
      });
      stripe.retrievePaymentIntent.mockResolvedValue({ status: 'succeeded' });
      idempotency.getResumePoint.mockResolvedValue('started');

      await expect(
        saga.handleBackgroundError(
          'pay-123',
          'ikey-123',
          'user-1',
          ownership,
          new Error('some background error'),
        ),
      ).resolves.toBeUndefined();

      expect(idempotency.updateRecoveryPoint).toHaveBeenCalledWith('ikey-123', 'captured');
      expect(prisma.payment.update).not.toHaveBeenCalled();
      expect(stripe.cancelPaymentIntent).not.toHaveBeenCalled();
    });

    it('should cancel Duffel and Stripe if status is requires_capture', async () => {
      prisma.payment.findUnique.mockResolvedValue({
        id: 'pay-123',
        status: 'CREATED',
        bookingIntentId: 'intent-123',
        stripePaymentIntentId: 'pi-123',
        amount: 1000,
      });
      stripe.retrievePaymentIntent.mockResolvedValue({ status: 'requires_capture' });
      idempotency.getResumePoint.mockResolvedValue('started');
      prisma.paymentEvent.findFirst.mockResolvedValue({
        eventType: 'duffel_order_created',
        metadata: { id: 'ord-123' },
      });
      prisma.bookingIntent.findUnique.mockResolvedValue({ paymentAttemptCount: 1 });
      prisma.booking.findFirst.mockResolvedValue({ id: 'book-123', paymentId: 'pay-123' });

      await saga.handleBackgroundError(
        'pay-123',
        'ikey-123',
        'user-1',
        ownership,
        new Error('some background error'),
      );

      expect(duffel.cancelOrder).toHaveBeenCalledWith('ord-123');
      expect(stripe.cancelPaymentIntent).toHaveBeenCalledWith('pi-123');
      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: 'pay-123' },
        data: { status: 'CANCELLED' },
      });
    });
  });

  describe('Finding 5: Staleness checking and revalidation in createPayment', () => {
    it('should revalidate but reuse attemptNumber if recovered reservation is stale', async () => {
      const staleParams = {
        paymentReservation: {
          bookingIntentId: 'intent-1',
          ancillarySelectionId: 'sel-1',
          ancillarySelectionVersion: 1,
          attemptNumber: 2,
          amount: 1000,
          currency: 'USD',
          intentExpiresAt: new Date(Date.now() + 600000).toISOString(),
          offerExpiresAt: new Date(Date.now() + 600000).toISOString(),
          validatedAt: new Date(Date.now() - 70000).toISOString(),
          validatedAncillary: {
            selectionId: 'sel-1',
            selectionVersion: 1,
            baseAmount: '10.00',
            grandTotal: '10.00',
            currency: 'USD',
            services: [{ serviceId: 'seat-1', quantity: 1 }],
          },
        },
      };

      prisma.idempotencyKey.findUnique.mockResolvedValue({
        requestHash: 'hash-123',
        customerId: 'user-1',
        requestPath: '/api/bookings/payment/create',
        requestParams: staleParams,
      });

      validation.validateForPayment.mockResolvedValue({
        selectionId: 'sel-1',
        selectionVersion: 1,
        baseAmount: '10.00',
        grandTotal: '10.00',
        currency: 'USD',
        services: [{ serviceId: 'seat-1', quantity: 1 }],
      });

      prisma.user.findUnique.mockResolvedValue({
        email: 'john@example.com',
        stripeCustomerId: 'cus-1',
      });
      stripe.createPaymentIntent.mockResolvedValue({ id: 'pi-1', client_secret: 'secret-1' });

      prisma.$queryRaw
        .mockResolvedValueOnce([
          {
            id: 'intent-1',
            userId: 'user-1',
            status: 'PENDING',
            paymentAttemptCount: 1,
            currency: 'USD',
            intentExpiresAt: new Date(Date.now() + 600000),
            offerExpiresAt: new Date(Date.now() + 600000),
            currentAncillarySelectionId: 'sel-1',
            ancillaryVersion: 1,
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'sel-1',
            status: 'VALIDATED',
            currency: 'USD',
            validatedBaseAmount: new Prisma.Decimal('10.00'),
            validatedGrandTotal: new Prisma.Decimal('10.00'),
            validationLeaseToken: null,
            validationLeaseExpiresAt: null,
            validatedAt: new Date(),
          },
        ])
        .mockResolvedValueOnce([
          {
            currentAncillarySelectionId: 'sel-1',
            ancillaryVersion: 1,
          },
        ]);
      prisma.$executeRaw.mockResolvedValue(1);

      const dto = {
        bookingIntentId: 'intent-1',
        ancillarySelectionId: 'sel-1',
        ancillarySelectionVersion: 1,
      };

      await service.createPayment(dto, 'ikey-123', 'user-1', '127.0.0.1');

      expect(validation.validateForPayment).toHaveBeenCalled();
      const executeRawCalls = prisma.$executeRaw.mock.calls;
      expect(executeRawCalls[0]).toContain(2);
    });

    it('should throw ConflictException if selection validatedAt is stale during lock', async () => {
      validation.validateForPayment.mockResolvedValue({
        selectionId: 'sel-1',
        selectionVersion: 1,
        baseAmount: '10.00',
        grandTotal: '10.00',
        currency: 'USD',
        services: [],
      });

      prisma.$queryRaw
        .mockResolvedValueOnce([
          {
            id: 'intent-1',
            userId: 'user-1',
            status: 'PENDING',
            paymentAttemptCount: 1,
            currency: 'USD',
            currentAncillarySelectionId: 'sel-1',
            ancillaryVersion: 1,
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'sel-1',
            status: 'VALIDATED',
            currency: 'USD',
            validatedBaseAmount: new Prisma.Decimal('10.00'),
            validatedGrandTotal: new Prisma.Decimal('10.00'),
            validationLeaseToken: null,
            validationLeaseExpiresAt: null,
            validatedAt: new Date(Date.now() - 65000), // Stale
          },
        ]);

      const dto = {
        bookingIntentId: 'intent-1',
        ancillarySelectionId: 'sel-1',
        ancillarySelectionVersion: 1,
      };

      await expect(service.createPayment(dto, 'ikey-123', 'user-1', '127.0.0.1')).rejects.toThrow(
        ConflictException,
      );
    });

    it('should NOT cancel the Stripe PaymentIntent if the database transaction commits but updateRecoveryPoint throws', async () => {
      prisma.bookingIntent.findUnique.mockResolvedValue({
        id: 'intent-1',
        status: 'PENDING',
        paymentAttemptCount: 0,
        confirmedPrice: '100.00',
        currency: 'USD',
        userId: 'user-1',
        currentAncillarySelectionId: null,
        ancillaryVersion: null,
      });

      prisma.$queryRaw.mockResolvedValueOnce([
        {
          id: 'intent-1',
          status: 'PENDING',
          paymentAttemptCount: 0,
          confirmedPrice: '100.00',
          currency: 'USD',
          userId: 'user-1',
          currentAncillarySelectionId: null,
          ancillaryVersion: null,
          intentExpiresAt: new Date(Date.now() + 600000),
          offerExpiresAt: null,
        },
      ]);

      prisma.idempotencyKey.findUnique.mockResolvedValue({
        id: 'key-1',
      });

      prisma.user.findUnique.mockResolvedValue({
        email: 'john@example.com',
        stripeCustomerId: 'cus-1',
      });

      stripe.createPaymentIntent.mockResolvedValue({
        id: 'pi-1',
        client_secret: 'secret-1',
      });

      prisma.payment.findFirst.mockResolvedValue(null);

      idempotency.updateRecoveryPoint.mockRejectedValue(new Error('Recovery point update failed'));

      const dto = { bookingIntentId: 'intent-1' };

      await expect(service.createPayment(dto, 'ikey-123', 'user-1', '127.0.0.1')).rejects.toThrow(
        'Recovery point update failed',
      );

      expect(stripe.cancelPaymentIntent).not.toHaveBeenCalled();
    });

    it('should validate ancillary selection exactly once during payment creation', async () => {
      prisma.idempotencyKey.findUnique.mockResolvedValueOnce(null);

      validation.validateForPayment.mockResolvedValue({
        selectionId: 'sel-1',
        selectionVersion: 1,
        baseAmount: '10.00',
        grandTotal: '10.00',
        currency: 'USD',
        services: [{ serviceId: 'seat-1', quantity: 1 }],
      });

      prisma.user.findUnique.mockResolvedValue({
        email: 'john@example.com',
        stripeCustomerId: 'cus-1',
      });
      stripe.createPaymentIntent.mockResolvedValue({ id: 'pi-1', client_secret: 'secret-1' });

      prisma.$queryRaw
        .mockResolvedValueOnce([
          {
            id: 'intent-1',
            userId: 'user-1',
            status: 'PENDING',
            paymentAttemptCount: 0,
            currency: 'USD',
            intentExpiresAt: new Date(Date.now() + 600000),
            offerExpiresAt: new Date(Date.now() + 600000),
            currentAncillarySelectionId: 'sel-1',
            ancillaryVersion: 1,
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'sel-1',
            status: 'VALIDATED',
            currency: 'USD',
            validatedBaseAmount: new Prisma.Decimal('10.00'),
            validatedGrandTotal: new Prisma.Decimal('10.00'),
            validationLeaseToken: null,
            validationLeaseExpiresAt: null,
            validatedAt: new Date(),
          },
        ])
        .mockResolvedValueOnce([
          {
            currentAncillarySelectionId: 'sel-1',
            ancillaryVersion: 1,
          },
        ]);
      prisma.$executeRaw.mockResolvedValue(1);

      const dto = {
        bookingIntentId: 'intent-1',
        ancillarySelectionId: 'sel-1',
        ancillarySelectionVersion: 1,
      };

      await service.createPayment(dto, 'ikey-123', 'user-1', '127.0.0.1');

      expect(validation.validateForPayment).toHaveBeenCalledTimes(1);
    });

    it('should cancel the Stripe PaymentIntent if the database transaction fails after createPaymentIntent', async () => {
      prisma.idempotencyKey.findUnique.mockResolvedValueOnce(null);

      validation.validateForPayment.mockResolvedValue({
        selectionId: 'sel-1',
        selectionVersion: 1,
        baseAmount: '10.00',
        grandTotal: '10.00',
        currency: 'USD',
        services: [{ serviceId: 'seat-1', quantity: 1 }],
      });

      prisma.user.findUnique.mockResolvedValue({
        email: 'john@example.com',
        stripeCustomerId: 'cus-1',
      });
      stripe.createPaymentIntent.mockResolvedValue({ id: 'pi-1', client_secret: 'secret-1' });

      prisma.$queryRaw
        .mockResolvedValueOnce([
          {
            id: 'intent-1',
            userId: 'user-1',
            status: 'PENDING',
            paymentAttemptCount: 0,
            currency: 'USD',
            intentExpiresAt: new Date(Date.now() + 600000),
            offerExpiresAt: new Date(Date.now() + 600000),
            currentAncillarySelectionId: 'sel-1',
            ancillaryVersion: 1,
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'sel-1',
            status: 'VALIDATED',
            currency: 'USD',
            validatedBaseAmount: new Prisma.Decimal('10.00'),
            validatedGrandTotal: new Prisma.Decimal('10.00'),
            validationLeaseToken: null,
            validationLeaseExpiresAt: null,
            validatedAt: new Date(),
          },
        ])
        .mockResolvedValueOnce([
          {
            currentAncillarySelectionId: 'sel-1',
            ancillaryVersion: 1,
          },
        ]);

      prisma.$executeRaw.mockResolvedValue(1);

      prisma.ancillarySelection.updateMany.mockRejectedValue(
        new Error('Database transaction failed'),
      );

      const dto = {
        bookingIntentId: 'intent-1',
        ancillarySelectionId: 'sel-1',
        ancillarySelectionVersion: 1,
      };

      await expect(service.createPayment(dto, 'ikey-123', 'user-1', '127.0.0.1')).rejects.toThrow(
        'Database transaction failed',
      );

      expect(stripe.cancelPaymentIntent).toHaveBeenCalledWith('pi-1');
    });
  });

  describe('Finding 6: Intent/Offer Expiration and Omitted Ancillary Selection Rejection', () => {
    it('should throw GoneException if intentExpiresAt is expired', async () => {
      prisma.bookingIntent.findUnique.mockResolvedValueOnce({
        id: 'intent-1',
        userId: 'user-1',
        status: 'PENDING',
        paymentAttemptCount: 0,
        intentExpiresAt: new Date(Date.now() - 1000),
        offerExpiresAt: null,
      });

      prisma.$queryRaw.mockResolvedValueOnce([
        {
          id: 'intent-1',
          userId: 'user-1',
          status: 'PENDING',
          paymentAttemptCount: 0,
          intentExpiresAt: new Date(Date.now() - 1000),
          offerExpiresAt: null,
        },
      ]);

      const dto = { bookingIntentId: 'intent-1' };
      await expect(service.createPayment(dto, 'ikey-123', 'user-1', '127.0.0.1')).rejects.toThrow(
        GoneException,
      );
    });

    it('should throw GoneException if offerExpiresAt is expired', async () => {
      prisma.bookingIntent.findUnique.mockResolvedValueOnce({
        id: 'intent-1',
        userId: 'user-1',
        status: 'PENDING',
        paymentAttemptCount: 0,
        intentExpiresAt: new Date(Date.now() + 600000),
        offerExpiresAt: new Date(Date.now() - 1000),
      });

      prisma.$queryRaw.mockResolvedValueOnce([
        {
          id: 'intent-1',
          userId: 'user-1',
          status: 'PENDING',
          paymentAttemptCount: 0,
          intentExpiresAt: new Date(Date.now() + 600000),
          offerExpiresAt: new Date(Date.now() - 1000),
        },
      ]);

      const dto = { bookingIntentId: 'intent-1' };
      await expect(service.createPayment(dto, 'ikey-123', 'user-1', '127.0.0.1')).rejects.toThrow(
        GoneException,
      );
    });

    it('should throw BadRequestException if dto.ancillarySelectionId is omitted but currentAncillarySelectionId has seat/baggage selections', async () => {
      prisma.bookingIntent.findUnique.mockResolvedValueOnce({
        id: 'intent-1',
        userId: 'user-1',
        status: 'PENDING',
        paymentAttemptCount: 0,
        intentExpiresAt: new Date(Date.now() + 600000),
        offerExpiresAt: null,
        currentAncillarySelectionId: 'sel-1',
      });

      prisma.$queryRaw.mockResolvedValueOnce([
        {
          id: 'intent-1',
          userId: 'user-1',
          status: 'PENDING',
          paymentAttemptCount: 0,
          intentExpiresAt: new Date(Date.now() + 600000),
          offerExpiresAt: null,
          currentAncillarySelectionId: 'sel-1',
        },
      ]);
      prisma.seatSelection.count.mockResolvedValue(1);
      prisma.baggageSelection.count.mockResolvedValue(0);

      const dto = { bookingIntentId: 'intent-1' };
      await expect(service.createPayment(dto, 'ikey-123', 'user-1', '127.0.0.1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
