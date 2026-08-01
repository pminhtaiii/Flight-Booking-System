import { AuditService } from '@/audit/audit.service';
import { BookingService } from '@/booking/booking.service';
import { StripeService } from '@/common/stripe.service';
import { DuffelService } from '@/duffel/duffel.service';
import { AncillaryPaymentValidationService } from '@/payment/ancillary-payment-validation.service';
import { PaymentIdempotencyService } from '@/payment/payment-idempotency.service';
import { PaymentMethodService } from '@/payment/payment-method.service';
import { PaymentService } from '@/payment/payment.service';
import { PrismaService } from '@/prisma/prisma.service';
import { Prisma } from '@prisma/client';

const dto = {
  bookingIntentId: 'intent-1',
  ancillarySelectionId: 'selection-3',
  ancillarySelectionVersion: 3,
};

const validated = {
  selectionId: 'selection-3',
  selectionVersion: 3,
  baseAmount: '100.00',
  grandTotal: '123.45',
  currency: 'USD',
  services: [{ serviceId: 'seat-1', quantity: 1 }],
};

function createDependencies(transaction: Record<string, unknown>) {
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
    payment: { findFirst: jest.fn().mockResolvedValue(null) },
    idempotencyKey: { findUnique: jest.fn().mockResolvedValue(null) },
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
  const validation = { validateForPayment: jest.fn().mockResolvedValue(validated) };
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

  return { audit, idempotency, prisma, service, stripe, validation };
}

describe('PaymentService ancillary binding review fixes', () => {
  it('accepts scale-normalized Prisma Decimal values for the exact validated snapshot', async () => {
    const transaction = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([
          {
            id: 'intent-1',
            status: 'PENDING',
            paymentAttemptCount: 0,
            confirmedPrice: new Prisma.Decimal('100.00'),
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
            validatedBaseAmount: new Prisma.Decimal('100.00'),
            validatedGrandTotal: new Prisma.Decimal('123.45'),
            validationLeaseToken: null,
            validationLeaseExpiresAt: null,
            validatedAt: new Date(),
          },
        ])
        .mockResolvedValue([]),
      $executeRaw: jest.fn().mockResolvedValue(1),
      ancillarySelection: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      idempotencyKey: {
        findUnique: jest.fn().mockResolvedValue({ id: 'idempotency-record-1' }),
      },
      payment: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'payment-1', status: 'CREATED' }),
      },
    };
    const fixture = createDependencies(transaction);

    await expect(
      fixture.service.createPayment(dto, 'payment-key-1', 'user-1', '127.0.0.1'),
    ).resolves.toEqual({
      paymentId: 'payment-1',
      clientSecret: 'secret_1',
      status: 'CREATED',
    });
    expect(fixture.stripe.createPaymentIntent).toHaveBeenCalledWith(
      12345,
      'USD',
      'cus_1',
      expect.any(Object),
      'payment-key-1-stripe-intent',
      undefined,
      undefined,
    );
  });

  it('resumes a same-key reservation after a crash without another validation or attempt', async () => {
    let reservation:
      | {
          bookingIntentId: string;
          ancillarySelectionId: string;
          ancillarySelectionVersion: number;
          attemptNumber: number;
          amount: number;
          currency: string;
          validatedAncillary: typeof validated;
        }
      | undefined;
    const idempotencyRecord = () => ({
      id: 'idempotency-record-1',
      key: 'payment-key-1',
      requestHash: 'request-hash',
      customerId: 'user-1',
      requestPath: '/api/bookings/payment/create',
      requestParams: reservation ? { paymentReservation: reservation } : null,
    });
    const transaction = {
      $queryRaw: jest.fn().mockImplementation((strings: TemplateStringsArray) => {
        const sql = strings.join(' ');
        if (sql.includes('ancillary_selections')) {
          return [
            {
              id: 'selection-3',
              status: 'VALIDATED',
              currency: 'USD',
              validatedBaseAmount: new Prisma.Decimal('100.00'),
              validatedGrandTotal: new Prisma.Decimal('123.45'),
              validationLeaseToken: null,
              validationLeaseExpiresAt: null,
              validatedAt: new Date(),
            },
          ];
        }
        return [
          {
            id: 'intent-1',
            status: reservation ? 'AWAITING_PAYMENT' : 'PENDING',
            paymentAttemptCount: reservation ? 1 : 0,
            confirmedPrice: new Prisma.Decimal('100.00'),
            currency: 'USD',
            userId: 'user-1',
            currentAncillarySelectionId: 'selection-3',
            ancillaryVersion: 3,
          },
        ];
      }),
      $executeRaw: jest.fn().mockImplementation(
        (strings: TemplateStringsArray, ...values: unknown[]) => {
          const sql = strings.join(' ');
          if (sql.includes('idempotency_keys')) {
            reservation = values.find(
              (value): value is typeof reservation =>
                typeof value === 'object' &&
                value !== null &&
                'validatedAncillary' in value,
            );
          }
          return 1;
        },
      ),
      ancillarySelection: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      idempotencyKey: {
        findUnique: jest.fn().mockImplementation(() => idempotencyRecord()),
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
    const fixture = createDependencies(transaction);
    fixture.prisma.idempotencyKey.findUnique.mockImplementation(() =>
      reservation ? Promise.resolve(idempotencyRecord()) : Promise.resolve(null),
    );
    fixture.prisma.user.findUnique
      .mockRejectedValueOnce(new Error('simulated crash after reservation'))
      .mockResolvedValue({ email: 'traveller@example.com', stripeCustomerId: 'cus_1' });

    await expect(
      fixture.service.createPayment(dto, 'payment-key-1', 'user-1', '127.0.0.1'),
    ).rejects.toThrow('simulated crash after reservation');
    await expect(
      fixture.service.createPayment(dto, 'payment-key-1', 'user-1', '127.0.0.1'),
    ).resolves.toEqual({
      paymentId: 'payment-1',
      clientSecret: 'secret_1',
      status: 'CREATED',
    });

    expect(fixture.validation.validateForPayment).toHaveBeenCalledTimes(1);
    expect(transaction.$executeRaw).toHaveBeenCalledTimes(1);
    expect(fixture.stripe.createPaymentIntent).toHaveBeenCalledTimes(1);
    expect(transaction.payment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ attemptNumber: 1, amount: 12345 }),
    });
  });
});
