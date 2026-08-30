import { AuditService } from '@/audit/audit.service';
import { BookingLifecycleService } from '@/booking-lifecycle/booking-lifecycle.service';
import { StripeService } from '@/common/stripe.service';
import { DuffelService } from '@/duffel/duffel.service';
import { AncillaryPaymentValidationService } from '@/payment/ancillary-payment-validation.service';
import { PaymentIdempotencyService } from '@/payment/payment-idempotency.service';
import { PaymentMethodService } from '@/payment/payment-method.service';
import { PaymentService } from '@/payment/payment.service';
import { PrismaService } from '@/prisma/prisma.service';

const validatedAncillary = {
  selectionId: 'selection-3',
  selectionVersion: 3,
  baseAmount: '100.00',
  grandTotal: '123.45',
  currency: 'USD',
  services: [
    { serviceId: 'seat-1', quantity: 1 },
    { serviceId: 'bag-1', quantity: 2 },
  ],
};

function createAncillaryFixture(options?: {
  currentSelectionId?: string;
  currentVersion?: number;
  paymentAttemptCount?: number;
  bindCount?: number;
}) {
  const payment = {
    id: 'payment-1',
    status: 'CREATED',
    attemptNumber: 1,
    amount: 12345,
    currency: 'usd',
  };
  const transaction = {
    $queryRaw: jest
      .fn()
      .mockResolvedValueOnce([
        {
          id: 'intent-1',
          status: 'PENDING',
          paymentAttemptCount: options?.paymentAttemptCount ?? 0,
          confirmedPrice: '100.00',
          currency: 'USD',
          userId: 'user-1',
          currentAncillarySelectionId: options?.currentSelectionId ?? 'selection-3',
          ancillaryVersion: options?.currentVersion ?? 3,
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
          validatedAt: new Date(),
        },
      ])
      .mockResolvedValueOnce([
        {
          currentAncillarySelectionId: options?.currentSelectionId ?? 'selection-3',
          ancillaryVersion: options?.currentVersion ?? 3,
        },
      ]),
    $executeRaw: jest.fn().mockResolvedValue(1),
    ancillarySelection: {
      updateMany: jest.fn().mockResolvedValue({ count: options?.bindCount ?? 1 }),
    },
    idempotencyKey: {
      findUnique: jest.fn().mockResolvedValue({ id: 'idempotency-record-1' }),
    },
    payment: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(payment),
    },
  };
  const prisma = {
    bookingIntent: {
      findUnique: jest
        .fn()
        .mockResolvedValue({
          id: 'intent-1',
          status: 'PENDING',
          paymentAttemptCount: options?.paymentAttemptCount ?? 0,
          confirmedPrice: '100.00',
          currency: 'USD',
          userId: 'user-1',
          currentAncillarySelectionId: options?.currentSelectionId ?? 'selection-3',
          ancillaryVersion: options?.currentVersion ?? 3,
        }),
    },
    $transaction: jest.fn().mockImplementation(async (callback) => callback(transaction)),
    payment: { findFirst: jest.fn().mockResolvedValue(null) },
    user: {
      findUnique: jest.fn().mockResolvedValue({
        email: 'traveller@example.com',
        stripeCustomerId: 'cus_1',
      }),
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
    validateForPayment: jest.fn().mockResolvedValue(validatedAncillary),
  };
  const service = new PaymentService(
    prisma as unknown as PrismaService,
    stripe as unknown as StripeService,
    idempotency as unknown as PaymentIdempotencyService,
    {} as DuffelService,
    audit as unknown as AuditService,
    {} as PaymentMethodService,
    {} as BookingLifecycleService,
    validation as unknown as AncillaryPaymentValidationService,
  );

  return { audit, payment, prisma, service, stripe, transaction };
}

const ancillaryDto = {
  bookingIntentId: 'intent-1',
  ancillarySelectionId: 'selection-3',
  ancillarySelectionVersion: 3,
};

describe('PaymentService ancillary snapshot binding supplemental coverage', () => {
  it('rejects current pointer/version drift after validation without consuming an attempt', async () => {
    const fixture = createAncillaryFixture({
      currentSelectionId: 'selection-4',
      currentVersion: 4,
    });

    await expect(
      fixture.service.createPayment(ancillaryDto, 'payment-key-1', 'user-1', '127.0.0.1'),
    ).rejects.toMatchObject({
      response: { code: 'ANCILLARY_VERSION_CONFLICT', currentVersion: 4 },
    });
    expect(fixture.transaction.$executeRaw).not.toHaveBeenCalled();
    expect(fixture.stripe.createPaymentIntent).not.toHaveBeenCalled();
  });

  it('rejects a fresh ancillary request at the attempt limit without mutation or Stripe', async () => {
    const fixture = createAncillaryFixture({ paymentAttemptCount: 2 });

    await expect(
      fixture.service.createPayment(ancillaryDto, 'payment-key-1', 'user-1', '127.0.0.1'),
    ).rejects.toThrow('Payment attempts exhausted');
    expect(fixture.transaction.$executeRaw).not.toHaveBeenCalled();
    expect(fixture.stripe.createPaymentIntent).not.toHaveBeenCalled();
  });

  it('converts a decimal-string base fare exactly when ancillary identity is omitted', async () => {
    const payment = { id: 'payment-1', status: 'CREATED' };
    const prisma = {
      bookingIntent: {
        findUnique: jest
          .fn()
          .mockResolvedValue({
            id: 'intent-1',
            status: 'PENDING',
            paymentAttemptCount: 0,
            confirmedPrice: '123.45',
            currency: 'USD',
            userId: 'user-1',
            currentAncillarySelectionId: null,
            ancillaryVersion: 0,
          }),
      },
      $transaction: jest.fn().mockImplementation(async (callback) => callback(prisma)),
      $queryRaw: jest.fn().mockResolvedValue([
        {
          id: 'intent-1',
          status: 'PENDING',
          paymentAttemptCount: 0,
          confirmedPrice: '123.45',
          currency: 'USD',
          userId: 'user-1',
          currentAncillarySelectionId: null,
          ancillaryVersion: 0,
        },
      ]),
      $executeRaw: jest.fn().mockResolvedValue(1),
      payment: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(payment),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          email: 'traveller@example.com',
          stripeCustomerId: 'cus_1',
        }),
      },
      idempotencyKey: {
        findUnique: jest.fn().mockResolvedValue({ id: 'idempotency-record-1' }),
      },
      paymentEvent: { create: jest.fn().mockResolvedValue({}) },
    };
    const stripe = {
      createPaymentIntent: jest.fn().mockResolvedValue({ id: 'pi_1', client_secret: 'secret_1' }),
    };
    const idempotency = {
      computeHash: jest.fn().mockReturnValue('request-hash'),
      acquireOrReplay: jest.fn().mockResolvedValue({ status: 'acquired' }),
      updateRecoveryPoint: jest.fn().mockResolvedValue(undefined),
      completeKey: jest.fn().mockResolvedValue(undefined),
    };
    const service = new PaymentService(
      prisma as unknown as PrismaService,
      stripe as unknown as StripeService,
      idempotency as unknown as PaymentIdempotencyService,
      {} as DuffelService,
      { createLog: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService,
      {} as PaymentMethodService,
      {} as BookingLifecycleService,
      undefined,
    );

    await service.createPayment(
      { bookingIntentId: 'intent-1' },
      'payment-key-1',
      'user-1',
      '127.0.0.1',
    );

    expect(stripe.createPaymentIntent).toHaveBeenCalledWith(
      12345,
      'USD',
      'cus_1',
      { bookingIntentId: 'intent-1' },
      'payment-key-1-stripe-intent',
      undefined,
      undefined,
    );
    expect(prisma.payment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ amount: 12345, currency: 'usd' }),
    });
  });

  it('fails closed when the snapshot binding CAS loses the race', async () => {
    const fixture = createAncillaryFixture({ bindCount: 0 });

    await expect(
      fixture.service.createPayment(ancillaryDto, 'payment-key-1', 'user-1', '127.0.0.1'),
    ).rejects.toMatchObject({
      response: { code: 'ANCILLARY_VERSION_CONFLICT' },
    });
    expect(fixture.transaction.payment.create).not.toHaveBeenCalled();
    expect(fixture.prisma.paymentEvent.create).not.toHaveBeenCalled();
    expect(fixture.audit.createLog).not.toHaveBeenCalled();
  });

  it('records exact safe ancillary metadata without supplier or passenger payloads', async () => {
    const fixture = createAncillaryFixture();

    await fixture.service.createPayment(ancillaryDto, 'payment-key-1', 'user-1', '127.0.0.1');

    const expectedMetadata = {
      bookingIntentId: 'intent-1',
      ancillarySelectionId: 'selection-3',
      ancillarySelectionVersion: 3,
      serviceCount: 2,
      serviceQuantity: 3,
      baseAmount: '100.00',
      grandTotal: '123.45',
      currency: 'USD',
    };
    expect(fixture.prisma.paymentEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ metadata: expectedMetadata }),
    });
    expect(fixture.audit.createLog).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        metadata: { ...expectedMetadata, amount: 12345, attemptNumber: 1 },
      }),
    );
    const metadata = JSON.stringify([
      fixture.prisma.paymentEvent.create.mock.calls[0][0].data.metadata,
      fixture.audit.createLog.mock.calls[0][1].metadata,
    ]);
    expect(metadata).not.toMatch(/passenger|seatMap|raw|supplier/i);
  });
});
