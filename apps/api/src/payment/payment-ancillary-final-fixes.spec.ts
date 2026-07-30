import { AuditService } from '@/audit/audit.service';
import { BookingService } from '@/booking/booking.service';
import { StripeService } from '@/common/stripe.service';
import { DuffelService } from '@/duffel/duffel.service';
import { AncillaryPaymentValidationService } from '@/payment/ancillary-payment-validation.service';
import { PaymentIdempotencyService } from '@/payment/payment-idempotency.service';
import { PaymentMethodService } from '@/payment/payment-method.service';
import { PaymentService } from '@/payment/payment.service';
import { PrismaService } from '@/prisma/prisma.service';
import { Prisma, BookingFailureReason } from '@prisma/client';
import { BadRequestException, ConflictException, GoneException, InternalServerErrorException } from '@nestjs/common';
import * as fs from 'fs';
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  appendFileSync: jest.fn(),
}));

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
      bookingIntentPassenger: {
        findMany: jest.fn(),
      },
      auditLog: {
        create: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
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
      updateRecoveryPoint: jest.fn(),
      completeKey: jest.fn(),
      getResumePoint: jest.fn(),
    };
    duffel = {
      createOrder: jest.fn(),
      cancelOrder: jest.fn(),
      mapDuffelOrderToSnapshots: jest.fn().mockReturnValue({
        flightSnapshot: {},
        passengerSnapshot: {},
      }),
    };
    audit = {
      createLog: jest.fn(),
    };
    methodService = {};
    bookingService = {
      updateToFailed: jest.fn(),
      createBooking: jest.fn().mockResolvedValue({ id: 'booking-1', userId: 'user-1' }),
      updateToConfirmed: jest.fn().mockResolvedValue(undefined),
    };
    validation = {
      validateForPayment: jest.fn(),
    };

    service = new PaymentService(
      prisma as unknown as PrismaService,
      stripe as unknown as StripeService,
      idempotency as unknown as PaymentIdempotencyService,
      duffel as unknown as DuffelService,
      audit as unknown as AuditService,
      methodService as unknown as PaymentMethodService,
      bookingService as unknown as BookingService,
      validation as unknown as AncillaryPaymentValidationService,
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
        passengers: [{ id: 'p-1' }],
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
      prisma.paymentEvent.findFirst.mockResolvedValue({
        eventType: 'duffel_order_created',
        metadata: duffelOrder,
      });

      const dto = { paymentId: 'pay-1', bookingId: 'book-1' };
      await service.executeConfirmPayment(dto, 'ikey-123', 'user-1');

      // Verify that the paymentEvent metadata has redacted PII fields
      expect(prisma.paymentEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          eventType: 'duffel_order_created',
          metadata: {
            id: 'ord-123',
            booking_reference: 'XYZ123',
            passengers: [
              {
                id: 'p-1',
                email: null,
                phone_number: null,
                born_on: null,
                given_name: 'REDACTED',
                family_name: 'REDACTED',
              },
            ],
          },
        }),
      });
    });
  });

  describe('Finding 2: handleBackgroundError Stripe checks', () => {
    it('should warn and return early (recoverable) if Stripe retrieval fails', async () => {
      prisma.payment.findUnique.mockResolvedValue({
        id: 'pay-123',
        status: 'CREATED',
        stripePaymentIntentId: 'pi-123',
      });
      stripe.retrievePaymentIntent.mockRejectedValue(new Error('Stripe network error'));

      await expect(
        service['handleBackgroundError']('pay-123', 'ikey-123', 'user-1', new Error('some background error')),
      ).resolves.toBeUndefined();

      // No updates should be made if Stripe retrieval failed
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
        service['handleBackgroundError']('pay-123', 'ikey-123', 'user-1', new Error('some background error')),
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
        service['handleBackgroundError']('pay-123', 'ikey-123', 'user-1', new Error('some background error')),
      ).resolves.toBeUndefined();

      expect(idempotency.updateRecoveryPoint).toHaveBeenCalledWith('ikey-123', 'captured');
      expect(prisma.payment.update).not.toHaveBeenCalled(); // Succeeded charge is not cancelled
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
      prisma.booking.findFirst.mockResolvedValue({ id: 'book-123' });

      await service['handleBackgroundError']('pay-123', 'ikey-123', 'user-1', new Error('some background error'));

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
          validatedAt: new Date(Date.now() - 70000).toISOString(), // > 60s ago (stale)
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

      prisma.user.findUnique.mockResolvedValue({ email: 'john@example.com', stripeCustomerId: 'cus-1' });
      stripe.createPaymentIntent.mockResolvedValue({ id: 'pi-1', client_secret: 'secret-1' });

      // Mock database transaction return values
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
        ]);
      prisma.$executeRaw.mockResolvedValue(1);

      const dto = {
        bookingIntentId: 'intent-1',
        ancillarySelectionId: 'sel-1',
        ancillarySelectionVersion: 1,
      };

      await service.createPayment(dto, 'ikey-123', 'user-1', '127.0.0.1');

      // Verify revalidation was run
      expect(validation.validateForPayment).toHaveBeenCalled();
      // Verify attempt number (2) was reused
      const executeRawCalls = prisma.$executeRaw.mock.calls;
      expect(executeRawCalls[0]).toContain(2);
    });
  });

  describe('Finding 6: Intent/Offer Expiration and Omitted Ancillary Selection Rejection', () => {
    it('should throw GoneException if intentExpiresAt is expired', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([
        {
          id: 'intent-1',
          userId: 'user-1',
          status: 'PENDING',
          paymentAttemptCount: 0,
          intentExpiresAt: new Date(Date.now() - 1000), // Expired
          offerExpiresAt: null,
        },
      ]);

      const dto = { bookingIntentId: 'intent-1' };
      await expect(
        service.createPayment(dto, 'ikey-123', 'user-1', '127.0.0.1'),
      ).rejects.toThrow(GoneException);
    });

    it('should throw GoneException if offerExpiresAt is expired', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([
        {
          id: 'intent-1',
          userId: 'user-1',
          status: 'PENDING',
          paymentAttemptCount: 0,
          intentExpiresAt: new Date(Date.now() + 600000),
          offerExpiresAt: new Date(Date.now() - 1000), // Expired
        },
      ]);

      const dto = { bookingIntentId: 'intent-1' };
      await expect(
        service.createPayment(dto, 'ikey-123', 'user-1', '127.0.0.1'),
      ).rejects.toThrow(GoneException);
    });

    it('should throw BadRequestException if dto.ancillarySelectionId is omitted but currentAncillarySelectionId has seat/baggage selections', async () => {
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
      prisma.seatSelection.count.mockResolvedValue(1); // 1 seat selection exists
      prisma.baggageSelection.count.mockResolvedValue(0);

      const dto = { bookingIntentId: 'intent-1' }; // Omitted ancillarySelectionId
      await expect(
        service.createPayment(dto, 'ikey-123', 'user-1', '127.0.0.1'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('Additional fixes (Issue 1, 2, 3)', () => {
    it('Issue 1: enrichPassengerSnapshot should retrieve original passenger PII, email from User table, and contactPhone from Duffel Order', async () => {
      // Stub passenger snapshot
      const rawSnapshot = {
        passengers: [
          {
            type: 'ADULT',
            firstName: 'REDACTED',
            lastName: 'REDACTED',
            dateOfBirth: '1990-01-01',
          },
        ],
        contactEmail: null,
        contactPhone: null,
      };

      prisma.bookingIntentPassenger.findMany.mockResolvedValue([
        {
          position: 0,
          givenName: 'John',
          familyName: 'Doe',
          dateOfBirth: new Date('1990-05-15'),
        },
      ]);

      prisma.bookingIntent.findUnique.mockResolvedValue({
        userId: 'user-123',
      });

      prisma.user.findUnique.mockResolvedValue({
        email: 'realuser@example.com',
      });

      // Mock database lookup for payment & booking to find duffelOrderId
      prisma.payment.findFirst.mockResolvedValue({
        id: 'pay-123',
        booking: {
          duffelOrderId: 'duffel-order-123',
        },
      });

      // Mock Duffel retrieveCompleteOrder to return contact phone
      duffel.retrieveCompleteOrder = jest.fn().mockResolvedValue({
        passengers: [
          {
            phone_number: '+1999999999',
          },
        ],
      });

      const enriched = await service['enrichPassengerSnapshot']('intent-123', rawSnapshot as any);

      expect(enriched.passengers[0].firstName).toBe('John');
      expect(enriched.passengers[0].lastName).toBe('Doe');
      expect(enriched.passengers[0].dateOfBirth).toBe('1990-05-15');
      expect(enriched.contactEmail).toBe('realuser@example.com');
      expect(enriched.contactPhone).toBe('+1999999999');
    });

    it('Issue 2: stale reservation should accept booking intent in AWAITING_PAYMENT state and bypass attempts exhausted check if reuseAttemptNumber is defined', async () => {
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
          validatedAt: new Date(Date.now() - 70000).toISOString(), // stale (> 60s)
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

      prisma.user.findUnique.mockResolvedValue({ email: 'john@example.com', stripeCustomerId: 'cus-1' });
      stripe.createPaymentIntent.mockResolvedValue({ id: 'pi-1', client_secret: 'secret-1' });

      // Mock booking intent to have AWAITING_PAYMENT status and paymentAttemptCount = 2 (meaning 2nd attempt is being retried)
      prisma.$queryRaw
        .mockResolvedValueOnce([
          {
            id: 'intent-1',
            userId: 'user-1',
            status: 'AWAITING_PAYMENT',
            paymentAttemptCount: 2,
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
        ]);
      prisma.$executeRaw.mockResolvedValue(1);

      const dto = {
        bookingIntentId: 'intent-1',
        ancillarySelectionId: 'sel-1',
        ancillarySelectionVersion: 1,
      };

      // Should complete successfully without throwing allowed status or attempt exhaustion error
      await expect(
        service.createPayment(dto, 'ikey-123', 'user-1', '127.0.0.1')
      ).resolves.toBeDefined();
    });

    it('Issue 3: should cancel the Stripe PaymentIntent if DB transaction fails during createPayment', async () => {
      prisma.idempotencyKey.findUnique.mockResolvedValue(null);
      validation.validateForPayment.mockResolvedValue({
        selectionId: 'sel-1',
        selectionVersion: 1,
        baseAmount: '10.00',
        grandTotal: '10.00',
        currency: 'USD',
        services: [{ serviceId: 'seat-1', quantity: 1 }],
      });
      prisma.user.findUnique.mockResolvedValue({ email: 'john@example.com', stripeCustomerId: 'cus-1' });
      stripe.createPaymentIntent.mockResolvedValue({ id: 'pi-failed-rollback', client_secret: 'secret-1' });

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
        ]);

      // Force second transaction (Step 5) to throw error, while first transaction (Step 2) succeeds
      prisma.$transaction
        .mockResolvedValueOnce({
          attemptNumber: 1,
          amount: 1000,
          currency: 'USD',
        })
        .mockRejectedValueOnce(new Error('Prisma transaction deadlock'));

      const dto = {
        bookingIntentId: 'intent-1',
        ancillarySelectionId: 'sel-1',
        ancillarySelectionVersion: 1,
      };

      await expect(
        service.createPayment(dto, 'ikey-123', 'user-1', '127.0.0.1')
      ).rejects.toThrow('Prisma transaction deadlock');

      // Verify that Stripe PaymentIntent cancellation was triggered to release the hold
      expect(stripe.cancelPaymentIntent).toHaveBeenCalledWith('pi-failed-rollback');
    });

    it('Issue 4: should save backupPaymentIntentId to idempotency key requestParams immediately and handle failed cancel rollback', async () => {
      prisma.idempotencyKey.findUnique.mockResolvedValue({
        requestParams: { originalField: 'value' },
      });
      validation.validateForPayment.mockResolvedValue({
        selectionId: 'sel-1',
        selectionVersion: 1,
        baseAmount: '10.00',
        grandTotal: '10.00',
        currency: 'USD',
        services: [{ serviceId: 'seat-1', quantity: 1 }],
      });
      prisma.user.findUnique.mockResolvedValue({ email: 'john@example.com', stripeCustomerId: 'cus-1' });
      stripe.createPaymentIntent.mockResolvedValue({ id: 'pi-unrollable', client_secret: 'secret-1' });

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
        ]);

      prisma.$transaction
        .mockResolvedValueOnce({
          attemptNumber: 1,
          amount: 1000,
          currency: 'USD',
        })
        .mockRejectedValueOnce(new Error('Transaction failure'));

      // Stripe cancellation fails
      stripe.cancelPaymentIntent.mockRejectedValueOnce(new Error('Stripe API error'));

      const dto = {
        bookingIntentId: 'intent-1',
        ancillarySelectionId: 'sel-1',
        ancillarySelectionVersion: 1,
      };

      await expect(
        service.createPayment(dto, 'ikey-123', 'user-1', '127.0.0.1')
      ).rejects.toThrow('Transaction failure');

      // Verify that the idempotency key was updated with backupPaymentIntentId immediately after intent creation
      expect(prisma.idempotencyKey.update).toHaveBeenCalledWith({
        where: { key: 'ikey-123' },
        data: {
          requestParams: {
            originalField: 'value',
            backupPaymentIntentId: 'pi-unrollable',
          },
        },
      });
    });

    it('Issue 4: should attempt to cancel backupPaymentIntentId and throw ConflictException on retry if Stripe cancellation fails again', async () => {
      // Setup mock key record with backupPaymentIntentId
      prisma.idempotencyKey.findUnique.mockResolvedValue({
        key: 'ikey-123',
        requestParams: {
          backupPaymentIntentId: 'pi-unrollable',
          originalField: 'value',
        },
      });

      // Stripe cancel fails again
      stripe.cancelPaymentIntent.mockRejectedValueOnce(new Error('Stripe still down'));

      const dto = {
        bookingIntentId: 'intent-1',
        ancillarySelectionId: 'sel-1',
        ancillarySelectionVersion: 1,
      };

      await expect(
        service.createPayment(dto, 'ikey-123', 'user-1', '127.0.0.1')
      ).rejects.toThrow(ConflictException);

      expect(stripe.cancelPaymentIntent).toHaveBeenCalledWith('pi-unrollable');
    });

    it('Issue 4: should cancel backupPaymentIntentId, clear it from requestParams, and proceed on retry if Stripe cancellation succeeds', async () => {
      // Setup mock key record with backupPaymentIntentId
      prisma.idempotencyKey.findUnique
        .mockResolvedValueOnce({
          id: 'ikey-id-123',
          key: 'ikey-123',
          requestParams: {
            backupPaymentIntentId: 'pi-unrollable',
            originalField: 'value',
          },
        })
        .mockResolvedValueOnce({
          id: 'ikey-id-123',
          key: 'ikey-123',
          requestParams: {
            backupPaymentIntentId: 'pi-unrollable',
            originalField: 'value',
          },
        })
        .mockResolvedValueOnce({
          id: 'ikey-id-123',
          key: 'ikey-123',
          requestParams: {
            originalField: 'value',
          },
        })
        .mockResolvedValueOnce({
          id: 'ikey-id-123',
          key: 'ikey-123',
          requestParams: {
            originalField: 'value',
          },
        });

      // Stripe cancel succeeds
      stripe.cancelPaymentIntent.mockResolvedValueOnce({ status: 'canceled' });

      // Mock normal createPayment operations
      validation.validateForPayment.mockResolvedValue({
        selectionId: 'sel-1',
        selectionVersion: 1,
        baseAmount: '10.00',
        grandTotal: '10.00',
        currency: 'USD',
        services: [{ serviceId: 'seat-1', quantity: 1 }],
      });
      prisma.user.findUnique.mockResolvedValue({ email: 'john@example.com', stripeCustomerId: 'cus-1' });
      stripe.createPaymentIntent.mockResolvedValue({ id: 'pi-new', client_secret: 'secret-new' });

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
        ]);

      prisma.$transaction.mockResolvedValueOnce({
        attemptNumber: 1,
        amount: 1000,
        currency: 'USD',
      });

      const dto = {
        bookingIntentId: 'intent-1',
        ancillarySelectionId: 'sel-1',
        ancillarySelectionVersion: 1,
      };

      await expect(
        service.createPayment(dto, 'ikey-123', 'user-1', '127.0.0.1')
      ).resolves.toBeDefined();

      // Expect old PaymentIntent to be cancelled
      expect(stripe.cancelPaymentIntent).toHaveBeenCalledWith('pi-unrollable');

      // Expect idempotency key requestParams to be updated/cleared of backupPaymentIntentId
      expect(prisma.idempotencyKey.update).toHaveBeenCalledWith({
        where: { key: 'ikey-123' },
        data: {
          requestParams: {
            originalField: 'value',
            stripeRetryCount: 1,
          },
        },
      });
    });

    it('Issue 5: should replay response and NOT cancel PaymentIntent if Payment record already exists in database despite backupPaymentIntentId being set', async () => {
      // Mock existing payment in DB
      prisma.payment.findFirst.mockResolvedValue({
        id: 'pay-existing-123',
        status: 'CREATED',
        stripePaymentIntentId: 'pi-valid-and-active',
      });

      // Mock idempotency Key lookup
      prisma.idempotencyKey.findUnique.mockResolvedValue({
        key: 'ikey-123',
        requestParams: {
          backupPaymentIntentId: 'pi-valid-and-active',
          originalField: 'value',
        },
      });

      stripe.retrievePaymentIntent.mockResolvedValue({
        id: 'pi-valid-and-active',
        client_secret: 'secret-active',
      });

      const dto = {
        bookingIntentId: 'intent-1',
        ancillarySelectionId: 'sel-1',
        ancillarySelectionVersion: 1,
      };

      const res = await service.createPayment(dto, 'ikey-123', 'user-1', '127.0.0.1');

      expect(res).toEqual({
        paymentId: 'pay-existing-123',
        clientSecret: 'secret-active',
        status: 'CREATED',
      });

      // Verification: cancelPaymentIntent should NEVER be called on the valid PaymentIntent
      expect(stripe.cancelPaymentIntent).not.toHaveBeenCalled();
    });

    it('Issue 6: should cancel Stripe PaymentIntent and throw InternalServerErrorException if saving backupPaymentIntentId to database fails', async () => {
      // Mock db save of backupPaymentIntentId to throw
      prisma.idempotencyKey.findUnique.mockResolvedValue({
        requestParams: { originalField: 'value' },
      });
      prisma.idempotencyKey.update.mockRejectedValueOnce(new Error('DB connection lost'));

      validation.validateForPayment.mockResolvedValue({
        selectionId: 'sel-1',
        selectionVersion: 1,
        baseAmount: '10.00',
        grandTotal: '10.00',
        currency: 'USD',
        services: [{ serviceId: 'seat-1', quantity: 1 }],
      });
      prisma.user.findUnique.mockResolvedValue({ email: 'john@example.com', stripeCustomerId: 'cus-1' });
      stripe.createPaymentIntent.mockResolvedValue({ id: 'pi-immediate-rollback', client_secret: 'secret-1' });

      stripe.cancelPaymentIntent.mockResolvedValueOnce({ status: 'canceled' });

      // Mock Step 2 transaction operations
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
        ]);

      prisma.$transaction.mockResolvedValueOnce({
        attemptNumber: 1,
        amount: 1000,
        currency: 'USD',
      });

      const dto = {
        bookingIntentId: 'intent-1',
        ancillarySelectionId: 'sel-1',
        ancillarySelectionVersion: 1,
      };

      await expect(
        service.createPayment(dto, 'ikey-123', 'user-1', '127.0.0.1')
      ).rejects.toThrow(InternalServerErrorException);

      // Verify that stripe.cancelPaymentIntent was called on the new PaymentIntent
      expect(stripe.cancelPaymentIntent).toHaveBeenCalledWith('pi-immediate-rollback');
    });

    it('Issue 7: should log to fallback database AuditLog when both backup ID save and Stripe cancellation fail, and sweep should process it on startup', async () => {
      // Mock db save of backupPaymentIntentId to throw
      prisma.idempotencyKey.findUnique.mockResolvedValue({
        requestParams: { originalField: 'value' },
      });
      prisma.idempotencyKey.update.mockRejectedValueOnce(new Error('DB connection lost'));

      validation.validateForPayment.mockResolvedValue({
        selectionId: 'sel-1',
        selectionVersion: 1,
        baseAmount: '10.00',
        grandTotal: '10.00',
        currency: 'USD',
        services: [{ serviceId: 'seat-1', quantity: 1 }],
      });
      prisma.user.findUnique.mockResolvedValue({ email: 'john@example.com', stripeCustomerId: 'cus-1' });
      stripe.createPaymentIntent.mockResolvedValue({ id: 'pi-unrollable-immediate', client_secret: 'secret-1' });

      // Mock Stripe cancel to throw (so cancellation fails)
      stripe.cancelPaymentIntent.mockRejectedValueOnce(new Error('Stripe API error'));

      // Mock audit log creation
      prisma.auditLog.create.mockResolvedValueOnce({ id: 'audit-log-123' });

      // Mock Step 2 transaction operations
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
        ]);

      prisma.$transaction.mockResolvedValueOnce({
        attemptNumber: 1,
        amount: 1000,
        currency: 'USD',
      });

      const dto = {
        bookingIntentId: 'intent-1',
        ancillarySelectionId: 'sel-1',
        ancillarySelectionVersion: 1,
      };

      // Call createPayment and expect failure
      await expect(
        service.createPayment(dto, 'ikey-failed-log', 'user-1', '127.0.0.1')
      ).rejects.toThrow(InternalServerErrorException);

      // Verify that prisma.auditLog.create was called with the rollback info
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-1',
          action: 'failed_stripe_rollback',
          resourceType: 'PaymentIntent',
          resourceId: 'pi-unrollable-immediate',
          metadata: {
            idempotencyKey: 'ikey-failed-log',
            reason: 'Immediate save rollback failed: Stripe API error',
          },
          traceId: '',
          correlationId: '',
        },
      });

      // Now test the startup sweep: mock Stripe cancel to succeed this time
      stripe.cancelPaymentIntent.mockResolvedValueOnce({ status: 'canceled' });

      prisma.auditLog.findMany.mockResolvedValueOnce([
        {
          id: 'audit-log-123',
          resourceId: 'pi-unrollable-immediate',
          metadata: {
            idempotencyKey: 'ikey-failed-log',
          },
        },
      ]);

      prisma.idempotencyKey.findUnique.mockResolvedValueOnce({
        requestParams: { backupPaymentIntentId: 'pi-unrollable-immediate' },
      });
      prisma.idempotencyKey.update.mockResolvedValueOnce({});
      prisma.auditLog.update.mockResolvedValueOnce({});

      // Execute sweep
      await service['sweepStripeRollbackFailures']();

      // Verify cancelPaymentIntent was retried
      expect(stripe.cancelPaymentIntent).toHaveBeenCalledWith('pi-unrollable-immediate');

      // Verify audit log record was updated to resolved status
      expect(prisma.auditLog.update).toHaveBeenCalledWith({
        where: { id: 'audit-log-123' },
        data: { action: 'resolved_failed_stripe_rollback' },
      });
    });
  });

  describe('Issue 1: enrichPassengerSnapshot fallback resolution', () => {
    it('should resolve duffelOrderId from passedDuffelOrderId directly', async () => {
      const rawSnapshot = {
        passengers: [{ type: 'ADULT', firstName: 'REDACTED', lastName: 'REDACTED', dateOfBirth: '1990-01-01' }],
        contactEmail: null,
        contactPhone: null,
      };

      prisma.bookingIntentPassenger.findMany.mockResolvedValue([]);
      prisma.bookingIntent.findUnique.mockResolvedValue({ userId: 'user-1' });
      prisma.user.findUnique.mockResolvedValue({ email: 'user@example.com' });
      duffel.retrieveCompleteOrder = jest.fn().mockResolvedValue({
        passengers: [{ phone_number: '+12223334444' }],
      });

      const enriched = await service['enrichPassengerSnapshot']('intent-123', rawSnapshot as any, 'passed-order-id');

      expect(enriched.contactPhone).toBe('+12223334444');
      expect(duffel.retrieveCompleteOrder).toHaveBeenCalledWith('passed-order-id');
    });

    it('should resolve duffelOrderId from booking.duffelOrderId if passedDuffelOrderId is not provided', async () => {
      const rawSnapshot = {
        passengers: [{ type: 'ADULT', firstName: 'REDACTED', lastName: 'REDACTED', dateOfBirth: '1990-01-01' }],
        contactEmail: null,
        contactPhone: null,
      };

      prisma.bookingIntentPassenger.findMany.mockResolvedValue([]);
      prisma.bookingIntent.findUnique.mockResolvedValue({ userId: 'user-1' });
      prisma.user.findUnique.mockResolvedValue({ email: 'user@example.com' });
      prisma.booking.findFirst.mockResolvedValue({
        duffelOrderId: 'booking-order-id',
      });
      duffel.retrieveCompleteOrder = jest.fn().mockResolvedValue({
        passengers: [{ phone_number: '+12223334444' }],
      });

      const enriched = await service['enrichPassengerSnapshot']('intent-123', rawSnapshot as any);

      expect(enriched.contactPhone).toBe('+12223334444');
      expect(duffel.retrieveCompleteOrder).toHaveBeenCalledWith('booking-order-id');
    });

    it('should resolve duffelOrderId from duffel_order_created event if not in booking or passed', async () => {
      const rawSnapshot = {
        passengers: [{ type: 'ADULT', firstName: 'REDACTED', lastName: 'REDACTED', dateOfBirth: '1990-01-01' }],
        contactEmail: null,
        contactPhone: null,
      };

      prisma.bookingIntentPassenger.findMany.mockResolvedValue([]);
      prisma.bookingIntent.findUnique.mockResolvedValue({ userId: 'user-1' });
      prisma.user.findUnique.mockResolvedValue({ email: 'user@example.com' });
      prisma.booking.findFirst.mockResolvedValue({
        duffelOrderId: null,
        paymentId: 'pay-123',
      });
      prisma.paymentEvent.findFirst.mockResolvedValue({
        metadata: { id: 'event-order-id' },
      });
      duffel.retrieveCompleteOrder = jest.fn().mockResolvedValue({
        passengers: [{ phone_number: '+12223334444' }],
      });

      const enriched = await service['enrichPassengerSnapshot']('intent-123', rawSnapshot as any);

      expect(enriched.contactPhone).toBe('+12223334444');
      expect(duffel.retrieveCompleteOrder).toHaveBeenCalledWith('event-order-id');
    });

    it('should fall back to travelerProfile.phoneNumber if Duffel retrieval fails', async () => {
      const rawSnapshot = {
        passengers: [{ type: 'ADULT', firstName: 'REDACTED', lastName: 'REDACTED', dateOfBirth: '1990-01-01' }],
        contactEmail: null,
        contactPhone: null,
      };

      prisma.bookingIntentPassenger.findMany.mockResolvedValue([
        { travelerProfile: { phoneNumber: '+19999999999' } }
      ]);
      prisma.bookingIntent.findUnique.mockResolvedValue({ userId: 'user-1' });
      prisma.user.findUnique.mockResolvedValue({ email: 'user@example.com' });
      duffel.retrieveCompleteOrder = jest.fn().mockRejectedValue(new Error('Duffel API error'));

      const enriched = await service['enrichPassengerSnapshot']('intent-123', rawSnapshot as any, 'passed-order-id');
      expect(enriched.contactPhone).toBe('+19999999999');
    });

    it('should fall back to travelerProfile.phoneNumber if passenger phone number is missing in retrieved Duffel order', async () => {
      const rawSnapshot = {
        passengers: [{ type: 'ADULT', firstName: 'REDACTED', lastName: 'REDACTED', dateOfBirth: '1990-01-01' }],
        contactEmail: null,
        contactPhone: null,
      };

      prisma.bookingIntentPassenger.findMany.mockResolvedValue([
        { travelerProfile: { phoneNumber: '+18888888888' } }
      ]);
      prisma.bookingIntent.findUnique.mockResolvedValue({ userId: 'user-1' });
      prisma.user.findUnique.mockResolvedValue({ email: 'user@example.com' });
      duffel.retrieveCompleteOrder = jest.fn().mockResolvedValue({
        passengers: [{ phone_number: null }],
      });

      const enriched = await service['enrichPassengerSnapshot']('intent-123', rawSnapshot as any, 'passed-order-id');
      expect(enriched.contactPhone).toBe('+18888888888');
    });

    it('should continue with null contact phone and not throw if both Duffel retrieval and travelerProfile phone are missing or fail', async () => {
      const rawSnapshot = {
        passengers: [{ type: 'ADULT', firstName: 'REDACTED', lastName: 'REDACTED', dateOfBirth: '1990-01-01' }],
        contactEmail: null,
        contactPhone: null,
      };

      prisma.bookingIntentPassenger.findMany.mockResolvedValue([
        { travelerProfile: null }
      ]);
      prisma.bookingIntent.findUnique.mockResolvedValue({ userId: 'user-1' });
      prisma.user.findUnique.mockResolvedValue({ email: 'user@example.com' });
      duffel.retrieveCompleteOrder = jest.fn().mockRejectedValue(new Error('Duffel API error'));

      const enriched = await service['enrichPassengerSnapshot']('intent-123', rawSnapshot as any, 'passed-order-id');
      expect(enriched.contactPhone).toBeNull();
    });
  });

  describe('Issue 2: createPayment failed_stripe_rollback cancellation', () => {
    it('should query failed_stripe_rollback logs and cancel matching ones only once per unique ID', async () => {
      prisma.idempotencyKey.findUnique.mockResolvedValue({
        requestParams: {},
      });
      validation.validateForPayment.mockResolvedValue({
        selectionId: 'sel-1',
        selectionVersion: 1,
        baseAmount: '10.00',
        grandTotal: '10.00',
        currency: 'USD',
        services: [{ serviceId: 'seat-1', quantity: 1 }],
      });
      prisma.user.findUnique.mockResolvedValue({ email: 'john@example.com', stripeCustomerId: 'cus-1' });
      stripe.createPaymentIntent.mockResolvedValue({ id: 'pi-new', client_secret: 'secret-new' });

      // Mock audit log query returning duplicate failed_stripe_rollback entries for the same/different intents
      prisma.auditLog.findMany.mockResolvedValue([
        {
          id: 'log-1',
          resourceId: 'pi-failed-1',
          metadata: { idempotencyKey: 'ikey-match' },
        },
        {
          id: 'log-2',
          resourceId: 'pi-failed-1', // duplicate PI ID
          metadata: { idempotencyKey: 'ikey-match' },
        },
        {
          id: 'log-3',
          resourceId: 'pi-failed-2',
          metadata: { idempotencyKey: 'ikey-match' },
        },
        {
          id: 'log-4',
          resourceId: 'pi-failed-other',
          metadata: { idempotencyKey: 'ikey-other' },
        },
      ]);

      stripe.cancelPaymentIntent.mockResolvedValue({ status: 'canceled' });

      // Mock other prisma operations so createPayment completes
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
        ]);
      prisma.$transaction.mockResolvedValueOnce({
        attemptNumber: 1,
        amount: 1000,
        currency: 'USD',
      });

      const dto = {
        bookingIntentId: 'intent-1',
        ancillarySelectionId: 'sel-1',
        ancillarySelectionVersion: 1,
      };

      await service.createPayment(dto, 'ikey-match', 'user-1', '127.0.0.1');

      // Verify cancel was called exactly once for each unique matching PI ID
      expect(stripe.cancelPaymentIntent).toHaveBeenCalledWith('pi-failed-1');
      expect(stripe.cancelPaymentIntent).toHaveBeenCalledWith('pi-failed-2');
      expect(stripe.cancelPaymentIntent).not.toHaveBeenCalledWith('pi-failed-other');
      // Ensure we only canceled 2 times (and not 3) due to tracking duplicate IDs
      const cancelCalls = stripe.cancelPaymentIntent.mock.calls.filter((c: any) => c[0].startsWith('pi-failed-'));
      expect(cancelCalls.length).toBe(2);

      // Verify audit logs updated
      expect(prisma.auditLog.update).toHaveBeenCalledWith({
        where: { id: 'log-1' },
        data: { action: 'resolved_failed_stripe_rollback' },
      });
      expect(prisma.auditLog.update).toHaveBeenCalledWith({
        where: { id: 'log-2' },
        data: { action: 'resolved_failed_stripe_rollback' },
      });
      expect(prisma.auditLog.update).toHaveBeenCalledWith({
        where: { id: 'log-3' },
        data: { action: 'resolved_failed_stripe_rollback' },
      });
      expect(prisma.auditLog.update).not.toHaveBeenCalledWith({
        where: { id: 'log-4' },
        data: expect.anything(),
      });
    });

    it('should throw ConflictException if cancelPaymentIntent fails on matches', async () => {
      prisma.auditLog.findMany.mockResolvedValue([
        {
          id: 'log-1',
          resourceId: 'pi-failed-1',
          metadata: { idempotencyKey: 'ikey-match' },
        },
      ]);

      stripe.cancelPaymentIntent.mockRejectedValueOnce(new Error('Stripe API error'));

      const dto = {
        bookingIntentId: 'intent-1',
        ancillarySelectionId: 'sel-1',
        ancillarySelectionVersion: 1,
      };

      await expect(
        service.createPayment(dto, 'ikey-match', 'user-1', '127.0.0.1')
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('Step 5 rollback logging to AuditLog', () => {
    it('should correctly log a durable rollback reference to AuditLog if Step 5 database transaction fails and Stripe cancel fails', async () => {
      // 1. Setup mocks
      prisma.idempotencyKey.findUnique.mockResolvedValue({
        key: 'ikey-step5-fail',
        requestParams: {},
      });
      validation.validateForPayment.mockResolvedValue({
        selectionId: 'sel-1',
        selectionVersion: 1,
        baseAmount: '10.00',
        grandTotal: '10.00',
        currency: 'USD',
        services: [{ serviceId: 'seat-1', quantity: 1 }],
      });
      prisma.user.findUnique.mockResolvedValue({ email: 'john@example.com', stripeCustomerId: 'cus-1' });
      stripe.createPaymentIntent.mockResolvedValue({ id: 'pi-step5-fail', client_secret: 'secret-1' });

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
        ]);

      // Force Step 5 transaction to throw error
      prisma.$transaction
        .mockResolvedValueOnce({
          attemptNumber: 1,
          amount: 1000,
          currency: 'USD',
        })
        .mockRejectedValueOnce(new Error('Step 5 DB Failure'));

      // Stripe cancellation fails (rollback failure)
      stripe.cancelPaymentIntent.mockRejectedValueOnce(new Error('Stripe cancel failed'));

      const dto = {
        bookingIntentId: 'intent-1',
        ancillarySelectionId: 'sel-1',
        ancillarySelectionVersion: 1,
      };

      await expect(
        service.createPayment(dto, 'ikey-step5-fail', 'user-1', '127.0.0.1')
      ).rejects.toThrow('Step 5 DB Failure');

      // Verify AuditLog record was created with the correct info
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-1',
          action: 'failed_stripe_rollback',
          resourceType: 'PaymentIntent',
          resourceId: 'pi-step5-fail',
          metadata: {
            idempotencyKey: 'ikey-step5-fail',
            reason: 'Transaction rollback failed: Stripe cancel failed',
          },
          traceId: '',
          correlationId: '',
        },
      });
    });
  });

  describe('Issue 1: Stripe Retry Count and Idempotency Key Appending', () => {
    it('should increment stripeRetryCount and append it to Stripe idempotency key on retries', async () => {
      // First attempt: no params in key
      const keyObj = {
        key: 'ikey-retry-test',
        requestParams: {},
      };
      prisma.idempotencyKey.findUnique.mockResolvedValue(keyObj);
      validation.validateForPayment.mockResolvedValue({
        selectionId: 'sel-1',
        selectionVersion: 1,
        baseAmount: '10.00',
        grandTotal: '10.00',
        currency: 'USD',
        services: [{ serviceId: 'seat-1', quantity: 1 }],
      });
      prisma.user.findUnique.mockResolvedValue({ email: 'john@example.com', stripeCustomerId: 'cus-1' });
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
        ]);
      prisma.$transaction.mockResolvedValueOnce({
        attemptNumber: 1,
        amount: 1000,
        currency: 'USD',
      });

      const dto = {
        bookingIntentId: 'intent-1',
        ancillarySelectionId: 'sel-1',
        ancillarySelectionVersion: 1,
      };

      await service.createPayment(dto, 'ikey-retry-test', 'user-1', '127.0.0.1');

      // Verify first call to createPaymentIntent used the base idempotency key
      expect(stripe.createPaymentIntent).toHaveBeenCalledWith(
        expect.any(Number),
        expect.any(String),
        expect.any(String),
        expect.any(Object),
        'ikey-retry-test-stripe-intent',
        undefined,
        undefined,
      );

      // Verify that requestParams was updated to record backupPaymentIntentId
      expect(prisma.idempotencyKey.update).toHaveBeenCalledWith({
        where: { key: 'ikey-retry-test' },
        data: {
          requestParams: {
            backupPaymentIntentId: 'pi-1',
          },
        },
      });

      // Second attempt (retry): key already has backupPaymentIntentId: pi-1
      const retryKeyObj = {
        key: 'ikey-retry-test',
        requestParams: {
          backupPaymentIntentId: 'pi-1',
        },
      };
      prisma.idempotencyKey.findUnique.mockResolvedValue(retryKeyObj);
      stripe.createPaymentIntent.mockClear().mockResolvedValue({ id: 'pi-2', client_secret: 'secret-2' });
      prisma.idempotencyKey.update.mockClear();
      stripe.cancelPaymentIntent.mockResolvedValue({ status: 'canceled' });

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
        ]);
      prisma.$transaction.mockResolvedValueOnce({
        attemptNumber: 1,
        amount: 1000,
        currency: 'USD',
      });

      await service.createPayment(dto, 'ikey-retry-test', 'user-1', '127.0.0.1');

      // Verify backup intent pi-1 was cancelled
      expect(stripe.cancelPaymentIntent).toHaveBeenCalledWith('pi-1');

      // Verify second call to createPaymentIntent appended the retry suffix
      expect(stripe.createPaymentIntent).toHaveBeenCalledWith(
        expect.any(Number),
        expect.any(String),
        expect.any(String),
        expect.any(Object),
        'ikey-retry-test-stripe-intent-1',
        undefined,
        undefined,
      );

      // Verify that requestParams was updated to record backupPaymentIntentId pi-2, preserving stripeRetryCount: 1
      expect(prisma.idempotencyKey.update).toHaveBeenCalledWith({
        where: { key: 'ikey-retry-test' },
        data: {
          requestParams: {
            stripeRetryCount: 1,
            backupPaymentIntentId: 'pi-2',
          },
        },
      });
    });
  });

  describe('logStripeRollbackFailure fallback to local file', () => {
    it('should append to local file when database write fails', async () => {
      const appendSpy = fs.appendFileSync as jest.Mock;
      appendSpy.mockClear().mockImplementationOnce(() => {});
      prisma.auditLog.create.mockRejectedValueOnce(new Error('Database offline'));

      await service['logStripeRollbackFailure'](
        'pi-fail-intent',
        'ikey-fail-rollback',
        'Stripe cancel timed out',
        'user-fail-123'
      );

      expect(prisma.auditLog.create).toHaveBeenCalled();
      expect(appendSpy).toHaveBeenCalled();
      const [filePath, content] = appendSpy.mock.calls[0];
      expect(filePath).toContain('stripe_rollback_failures.log');

      const parsedLog = JSON.parse(content as string);
      expect(parsedLog.paymentIntentId).toBe('pi-fail-intent');
      expect(parsedLog.idempotencyKey).toBe('ikey-fail-rollback');
      expect(parsedLog.reason).toBe('Stripe cancel timed out');
      expect(parsedLog.userId).toBe('user-fail-123');
      expect(parsedLog.dbError).toBe('Database offline');
    });
  });

  describe('Issue 2: retry suffix counter advancement on AuditLog rollback', () => {
    it('should increment stripeRetryCount by number of unique cancelled intents and save to idempotencyKey requestParams', async () => {
      const dto = {
        bookingIntentId: 'intent-rollback-adv',
        ancillarySelectionId: 'sel-1',
        ancillarySelectionVersion: 1,
      };

      // Mock idempotency key findUnique to return stripeRetryCount: 1
      prisma.idempotencyKey.findUnique.mockResolvedValue({
        key: 'ikey-rollback-adv',
        requestParams: {
          stripeRetryCount: 1,
        },
      });

      // Mock pending rollbacks matching current idempotency key
      prisma.auditLog.findMany.mockResolvedValueOnce([
        {
          id: 'log-1',
          action: 'failed_stripe_rollback',
          resourceType: 'PaymentIntent',
          resourceId: 'pi-old-1',
          metadata: { idempotencyKey: 'ikey-rollback-adv' },
        },
        {
          id: 'log-2',
          action: 'failed_stripe_rollback',
          resourceType: 'PaymentIntent',
          resourceId: 'pi-old-2',
          metadata: { idempotencyKey: 'ikey-rollback-adv' },
        },
        {
          id: 'log-3',
          action: 'failed_stripe_rollback',
          resourceType: 'PaymentIntent',
          resourceId: 'pi-old-1', // duplicate PI ID
          metadata: { idempotencyKey: 'ikey-rollback-adv' },
        },
      ]);

      validation.validateForPayment.mockResolvedValue({
        selectionId: 'sel-1',
        selectionVersion: 1,
        baseAmount: '10.00',
        grandTotal: '10.00',
        currency: 'USD',
        services: [{ serviceId: 'seat-1', quantity: 1 }],
      });
      prisma.user.findUnique.mockResolvedValue({ email: 'john@example.com', stripeCustomerId: 'cus-1' });
      stripe.createPaymentIntent.mockResolvedValue({ id: 'pi-new', client_secret: 'secret-new' });
      stripe.cancelPaymentIntent.mockResolvedValue({ status: 'canceled' });

      prisma.$queryRaw
        .mockResolvedValueOnce([
          {
            id: 'intent-rollback-adv',
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
        ]);
      prisma.$transaction.mockResolvedValueOnce({
        attemptNumber: 1,
        amount: 1000,
        currency: 'USD',
      });

      await service.createPayment(dto, 'ikey-rollback-adv', 'user-1', '127.0.0.1');

      // Verify cancelPaymentIntent called for unique PIs
      expect(stripe.cancelPaymentIntent).toHaveBeenCalledWith('pi-old-1');
      expect(stripe.cancelPaymentIntent).toHaveBeenCalledWith('pi-old-2');

      // Verify that idempotencyKey update was called to advance stripeRetryCount (1 + 2 = 3)
      expect(prisma.idempotencyKey.update).toHaveBeenCalledWith({
        where: { key: 'ikey-rollback-adv' },
        data: {
          requestParams: {
            stripeRetryCount: 3,
          },
        },
      });

      // Verify all AuditLog entries are marked resolved
      expect(prisma.auditLog.update).toHaveBeenCalledWith({
        where: { id: 'log-1' },
        data: { action: 'resolved_failed_stripe_rollback' },
      });
      expect(prisma.auditLog.update).toHaveBeenCalledWith({
        where: { id: 'log-2' },
        data: { action: 'resolved_failed_stripe_rollback' },
      });
      expect(prisma.auditLog.update).toHaveBeenCalledWith({
        where: { id: 'log-3' },
        data: { action: 'resolved_failed_stripe_rollback' },
      });
    });
  });
});
