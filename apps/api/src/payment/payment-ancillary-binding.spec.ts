import { AuditService } from '@/audit/audit.service';
import { BookingService } from '@/booking/booking.service';
import { StripeService } from '@/common/stripe.service';
import { DuffelService } from '@/duffel/duffel.service';
import { AncillaryPaymentValidationService } from '@/payment/ancillary-payment-validation.service';
import { PaymentIdempotencyService } from '@/payment/payment-idempotency.service';
import { PaymentMethodService } from '@/payment/payment-method.service';
import { PaymentService } from '@/payment/payment.service';
import { PrismaService } from '@/prisma/prisma.service';
import { CreatePaymentDto } from '@/payment/dto/create-payment.dto';
import { validateSync } from 'class-validator';

describe('PaymentService ancillary snapshot binding', () => {
  it('requires ancillary selection ID and version together while allowing neither', () => {
    const empty = Object.assign(new CreatePaymentDto(), { bookingIntentId: 'intent-1' });
    const idOnly = Object.assign(new CreatePaymentDto(), {
      bookingIntentId: 'intent-1',
      ancillarySelectionId: '3f2dfaf7-9f20-4ca8-88b1-b1bed1a7db0e',
    });
    const versionOnly = Object.assign(new CreatePaymentDto(), {
      bookingIntentId: 'intent-1',
      ancillarySelectionVersion: 3,
    });

    expect(validateSync(empty)).toHaveLength(0);
    expect(validateSync(idOnly)).not.toHaveLength(0);
    expect(validateSync(versionOnly)).not.toHaveLength(0);
  });

  it('binds the validated snapshot and charges its exact authoritative grand total', async () => {
    const transaction = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([
          {
            id: 'intent-1',
            status: 'PENDING',
            paymentAttemptCount: 0,
            confirmedPrice: '100.00',
            currency: 'USD',
            userId: 'user-1',
            currentAncillarySelectionId: 'selection-3',
            ancillaryVersion: 3,
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'selection-3',
            status: 'VALIDATED',
            currency: 'USD',
            validatedBaseAmount: '100.00',
            validatedGrandTotal: '123.45',
            validationLeaseToken: null,
            validationLeaseExpiresAt: null,
          },
        ])
        .mockResolvedValue([]),
      $executeRaw: jest.fn().mockResolvedValue(1),
      ancillarySelection: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      idempotencyKey: {
        findUnique: jest.fn().mockResolvedValue({ id: 'idempotency-record-1' }),
      },
      payment: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: 'payment-1',
          status: 'CREATED',
          attemptNumber: 1,
          amount: 12345,
          currency: 'usd',
        }),
      },
    };
    const prisma = {
      $transaction: jest.fn().mockImplementation(async (callback) => callback(transaction)),
      bookingIntent: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'intent-1',
          status: 'PENDING',
          paymentAttemptCount: 0,
          confirmedPrice: '100.00',
          currency: 'USD',
          userId: 'user-1',
          currentAncillarySelectionId: 'selection-3',
          ancillaryVersion: 3,
          intentExpiresAt: new Date(Date.now() + 100000),
          offerExpiresAt: new Date(Date.now() + 100000),
        }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          email: 'traveller@example.com',
          stripeCustomerId: 'cus_1',
        }),
      },
      payment: {
        update: jest.fn().mockResolvedValue({ id: 'payment-1', status: 'CREATED' }),
        findFirst: jest.fn().mockResolvedValue({ id: 'payment-1', status: 'CREATED' }),
      },
      idempotencyKey: {
        findUnique: jest.fn().mockResolvedValue({ id: 'idempotency-record-1' }),
      },
      paymentEvent: { create: jest.fn().mockResolvedValue({}) },
    };
    const stripe = {
      createPaymentIntent: jest.fn().mockResolvedValue({
        id: 'pi_1',
        client_secret: 'secret_1',
      }),
    };
    const idempotency = {
      computeHash: jest.fn().mockReturnValue('request-hash'),
      acquireOrReplay: jest.fn().mockResolvedValue({ status: 'acquired' }),
      updateRecoveryPoint: jest.fn().mockResolvedValue(undefined),
      completeKey: jest.fn().mockResolvedValue(undefined),
    };
    const audit = { createLog: jest.fn().mockResolvedValue(undefined) };
    const validation = {
      validateForPayment: jest.fn().mockResolvedValue({
        selectionId: 'selection-3',
        selectionVersion: 3,
        baseAmount: '100.00',
        grandTotal: '123.45',
        currency: 'USD',
        services: [
          { serviceId: 'seat-1', quantity: 1 },
          { serviceId: 'bag-1', quantity: 2 },
        ],
      }),
    };
    const service = new PaymentService(
      prisma as unknown as PrismaService,
      stripe as unknown as StripeService,
      idempotency as unknown as PaymentIdempotencyService,
      {} as DuffelService,
      audit as unknown as AuditService,
      {} as PaymentMethodService,
      {} as BookingService,
      validation as unknown as AncillaryPaymentValidationService,
    );

    const response = await service.createPayment(
      {
        bookingIntentId: 'intent-1',
        ancillarySelectionId: 'selection-3',
        ancillarySelectionVersion: 3,
        paymentMethodId: 'pm_1',
        saveCard: false,
      },
      'payment-key-1',
      'user-1',
      '127.0.0.1',
    );

    expect(transaction.ancillarySelection.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'selection-3',
        bookingIntentId: 'intent-1',
        version: 3,
        status: 'VALIDATED',
        currency: 'USD',
        validatedBaseAmount: '100.00',
        validatedGrandTotal: '123.45',
      },
      data: { status: 'PAYMENT_BOUND' },
    });
    expect(transaction.payment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        bookingIntentId: 'intent-1',
        ancillarySelectionId: 'selection-3',
        ancillarySelectionVersion: 3,
        amount: 12345,
        currency: 'usd',
      }),
    });
    expect(stripe.createPaymentIntent).toHaveBeenCalledWith(
      12345,
      'USD',
      'cus_1',
      expect.objectContaining({
        bookingIntentId: 'intent-1',
        ancillarySelectionId: 'selection-3',
        ancillarySelectionVersion: '3',
      }),
      'payment-key-1-stripe-intent',
      'pm_1',
      undefined,
    );
    expect(response).toEqual({
      paymentId: 'payment-1',
      clientSecret: 'secret_1',
      status: 'CREATED',
    });
  });

  it('rejects a currency change after validation without consuming an attempt or calling Stripe', async () => {
    const transaction = {
      $queryRaw: jest.fn().mockResolvedValue([
        {
          id: 'intent-1',
          status: 'PENDING',
          paymentAttemptCount: 0,
          confirmedPrice: '100.00',
          currency: 'EUR',
          userId: 'user-1',
          currentAncillarySelectionId: 'selection-3',
          ancillaryVersion: 3,
        },
      ]),
      $executeRaw: jest.fn(),
      payment: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const prisma = {
      $transaction: jest.fn().mockImplementation(async (callback) => callback(transaction)),
      bookingIntent: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'intent-1',
          status: 'PENDING',
          paymentAttemptCount: 0,
          confirmedPrice: '100.00',
          currency: 'USD',
          userId: 'user-1',
          currentAncillarySelectionId: 'selection-3',
          ancillaryVersion: 3,
          intentExpiresAt: new Date(Date.now() + 100000),
          offerExpiresAt: new Date(Date.now() + 100000),
        }),
      },
    };
    const stripe = { createPaymentIntent: jest.fn() };
    const idempotency = {
      computeHash: jest.fn().mockReturnValue('request-hash'),
      acquireOrReplay: jest.fn().mockResolvedValue({ status: 'acquired' }),
    };
    const validation = {
      validateForPayment: jest.fn().mockResolvedValue({
        selectionId: 'selection-3',
        selectionVersion: 3,
        baseAmount: '100.00',
        grandTotal: '123.45',
        currency: 'USD',
        services: [{ serviceId: 'seat-1', quantity: 1 }],
      }),
    };
    const service = new PaymentService(
      prisma as unknown as PrismaService,
      stripe as unknown as StripeService,
      idempotency as unknown as PaymentIdempotencyService,
      {} as DuffelService,
      {} as AuditService,
      {} as PaymentMethodService,
      {} as BookingService,
      validation as unknown as AncillaryPaymentValidationService,
    );

    await expect(
      service.createPayment(
        {
          bookingIntentId: 'intent-1',
          ancillarySelectionId: 'selection-3',
          ancillarySelectionVersion: 3,
        },
        'payment-key-1',
        'user-1',
        '127.0.0.1',
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'ANCILLARY_CURRENCY_MISMATCH',
        intentId: 'intent-1',
      },
    });
    expect(transaction.$executeRaw).not.toHaveBeenCalled();
    expect(stripe.createPaymentIntent).not.toHaveBeenCalled();
  });

  it('replays a completed bound payment without revalidating the immutable snapshot', async () => {
    const prisma = {
      bookingIntent: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'intent-1',
          status: 'PENDING',
          paymentAttemptCount: 0,
          confirmedPrice: '100.00',
          currency: 'USD',
          userId: 'user-1',
          currentAncillarySelectionId: 'selection-3',
          ancillaryVersion: 3,
          intentExpiresAt: new Date(Date.now() + 100000),
          offerExpiresAt: new Date(Date.now() + 100000),
        }),
      },
      payment: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'payment-1',
          bookingIntentId: 'intent-1',
          ancillarySelectionId: 'selection-3',
          ancillarySelectionVersion: 3,
          amount: 12345,
          currency: 'usd',
        }),
      },
    };
    const idempotency = {
      computeHash: jest.fn().mockReturnValue('request-hash'),
      acquireOrReplay: jest.fn().mockResolvedValue({
        status: 'replay',
        responseBody: JSON.stringify({
          paymentId: 'payment-1',
          clientSecret: 'secret-1',
          status: 'CREATED',
        }),
      }),
    };
    const validation = { validateForPayment: jest.fn() };
    const stripe = { createPaymentIntent: jest.fn() };
    const service = new PaymentService(
      prisma as unknown as PrismaService,
      stripe as unknown as StripeService,
      idempotency as unknown as PaymentIdempotencyService,
      {} as DuffelService,
      {} as AuditService,
      {} as PaymentMethodService,
      {} as BookingService,
      validation as unknown as AncillaryPaymentValidationService,
    );

    await expect(
      service.createPayment(
        {
          bookingIntentId: 'intent-1',
          ancillarySelectionId: 'selection-3',
          ancillarySelectionVersion: 3,
        },
        'payment-key-1',
        'user-1',
        '127.0.0.1',
      ),
    ).resolves.toEqual({
      paymentId: 'payment-1',
      clientSecret: 'secret-1',
      status: 'CREATED',
    });
    expect(validation.validateForPayment).not.toHaveBeenCalled();
    expect(stripe.createPaymentIntent).not.toHaveBeenCalled();
  });

  it('rejects a snapshot leased by another validator before consuming an attempt or calling Stripe', async () => {
    const transaction = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([
          {
            id: 'intent-1',
            status: 'PENDING',
            paymentAttemptCount: 0,
            confirmedPrice: '100.00',
            currency: 'USD',
            userId: 'user-1',
            currentAncillarySelectionId: 'selection-3',
            ancillaryVersion: 3,
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'selection-3',
            status: 'VALIDATED',
            currency: 'USD',
            validatedBaseAmount: '100.00',
            validatedGrandTotal: '123.45',
            validationLeaseToken: 'other-validator',
            validationLeaseExpiresAt: new Date(Date.now() + 10_000),
          },
        ]),
      $executeRaw: jest.fn(),
      payment: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const prisma = {
      $transaction: jest.fn().mockImplementation(async (callback) => callback(transaction)),
      bookingIntent: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'intent-1',
          status: 'PENDING',
          paymentAttemptCount: 0,
          confirmedPrice: '100.00',
          currency: 'USD',
          userId: 'user-1',
          currentAncillarySelectionId: 'selection-3',
          ancillaryVersion: 3,
          intentExpiresAt: new Date(Date.now() + 100000),
          offerExpiresAt: new Date(Date.now() + 100000),
        }),
      },
    };
    const stripe = { createPaymentIntent: jest.fn() };
    const idempotency = {
      computeHash: jest.fn().mockReturnValue('request-hash'),
      acquireOrReplay: jest.fn().mockResolvedValue({ status: 'acquired' }),
    };
    const validation = {
      validateForPayment: jest.fn().mockResolvedValue({
        selectionId: 'selection-3',
        selectionVersion: 3,
        baseAmount: '100.00',
        grandTotal: '123.45',
        currency: 'USD',
        services: [{ serviceId: 'seat-1', quantity: 1 }],
      }),
    };
    const service = new PaymentService(
      prisma as unknown as PrismaService,
      stripe as unknown as StripeService,
      idempotency as unknown as PaymentIdempotencyService,
      {} as DuffelService,
      {} as AuditService,
      {} as PaymentMethodService,
      {} as BookingService,
      validation as unknown as AncillaryPaymentValidationService,
    );

    await expect(
      service.createPayment(
        {
          bookingIntentId: 'intent-1',
          ancillarySelectionId: 'selection-3',
          ancillarySelectionVersion: 3,
        },
        'payment-key-1',
        'user-1',
        '127.0.0.1',
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'ANCILLARY_VERSION_CONFLICT',
        intentId: 'intent-1',
        currentVersion: 3,
      },
    });
    expect(transaction.$executeRaw).not.toHaveBeenCalled();
    expect(stripe.createPaymentIntent).not.toHaveBeenCalled();
  });

  it('recovers a stale idempotency lock without another attempt, validation, or created event', async () => {
    const existingPayment = {
      id: 'payment-1',
      bookingIntentId: 'intent-1',
      ancillarySelectionId: 'selection-3',
      ancillarySelectionVersion: 3,
      attemptNumber: 1,
      amount: 12345,
      currency: 'usd',
      status: 'CREATED',
    };
    const transaction = {
      $queryRaw: jest.fn().mockResolvedValue([
        {
          id: 'intent-1',
          status: 'AWAITING_PAYMENT',
          paymentAttemptCount: 2,
          confirmedPrice: '100.00',
          currency: 'USD',
          userId: 'user-1',
          currentAncillarySelectionId: 'selection-3',
          ancillaryVersion: 3,
        },
      ]),
      $executeRaw: jest.fn(),
      payment: { findFirst: jest.fn().mockResolvedValue(existingPayment) },
    };
    const paymentEvent = { create: jest.fn() };
    const prisma = {
      $transaction: jest.fn().mockImplementation(async (callback) => callback(transaction)),
      bookingIntent: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'intent-1',
          status: 'PENDING',
          paymentAttemptCount: 0,
          confirmedPrice: '100.00',
          currency: 'USD',
          userId: 'user-1',
          currentAncillarySelectionId: 'selection-3',
          ancillaryVersion: 3,
          intentExpiresAt: new Date(Date.now() + 100000),
          offerExpiresAt: new Date(Date.now() + 100000),
        }),
      },
      payment: { findFirst: jest.fn().mockResolvedValue(existingPayment) },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          email: 'traveller@example.com',
          stripeCustomerId: 'cus_1',
        }),
      },
      idempotencyKey: {
        findUnique: jest.fn().mockResolvedValue({ id: 'idempotency-record-1' }),
      },
      paymentEvent,
    };
    const stripe = {
      createPaymentIntent: jest.fn().mockResolvedValue({
        id: 'pi_1',
        client_secret: 'secret_1',
      }),
    };
    const idempotency = {
      computeHash: jest.fn().mockReturnValue('request-hash'),
      acquireOrReplay: jest.fn().mockResolvedValue({ status: 'acquired' }),
      updateRecoveryPoint: jest.fn().mockResolvedValue(undefined),
      completeKey: jest.fn().mockResolvedValue(undefined),
    };
    const validation = { validateForPayment: jest.fn() };
    const audit = { createLog: jest.fn() };
    const service = new PaymentService(
      prisma as unknown as PrismaService,
      stripe as unknown as StripeService,
      idempotency as unknown as PaymentIdempotencyService,
      {} as DuffelService,
      audit as unknown as AuditService,
      {} as PaymentMethodService,
      {} as BookingService,
      validation as unknown as AncillaryPaymentValidationService,
    );

    await expect(
      service.createPayment(
        {
          bookingIntentId: 'intent-1',
          ancillarySelectionId: 'selection-3',
          ancillarySelectionVersion: 3,
        },
        'payment-key-1',
        'user-1',
        '127.0.0.1',
      ),
    ).resolves.toEqual({
      paymentId: 'payment-1',
      clientSecret: 'secret_1',
      status: 'CREATED',
    });
    expect(transaction.$executeRaw).not.toHaveBeenCalled();
    expect(validation.validateForPayment).not.toHaveBeenCalled();
    expect(paymentEvent.create).not.toHaveBeenCalled();
    expect(audit.createLog).not.toHaveBeenCalled();
  });
});
