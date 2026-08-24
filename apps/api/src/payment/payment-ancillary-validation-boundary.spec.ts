import { ConflictException } from '@nestjs/common';
import { AuditService } from '@/audit/audit.service';
import { BookingLifecycleService } from '@/booking-lifecycle/booking-lifecycle.service';
import { StripeService } from '@/common/stripe.service';
import { DuffelService } from '@/duffel/duffel.service';
import { PaymentIdempotencyService } from '@/payment/payment-idempotency.service';
import { PaymentMethodService } from '@/payment/payment-method.service';
import { PaymentService } from '@/payment/payment.service';
import { PrismaService } from '@/prisma/prisma.service';
import { AncillaryPaymentValidationService } from './ancillary-payment-validation.service';

describe('PaymentService ancillary validation boundary', () => {
  it('rejects a stale selection version before acquiring idempotency or consuming payment side effects', async () => {
    const prisma = {
      $transaction: jest.fn(),
      idempotencyKey: {
        findUnique: jest.fn().mockResolvedValue({
          requestHash: 'different-request-hash',
          customerId: 'user-1',
          requestPath: '/api/bookings/payment/create',
          requestParams: null,
        }),
      },
    };
    const stripe = {
      createCustomer: jest.fn(),
      createPaymentIntent: jest.fn(),
    };
    const idempotency = {
      computeHash: jest.fn(),
      acquireOrReplay: jest.fn(),
    };
    const validation = {
      validateForPayment: jest.fn().mockRejectedValue(
        new ConflictException({
          code: 'ANCILLARY_VERSION_CONFLICT',
          intentId: 'intent-1',
          currentVersion: 3,
        }),
      ),
    };

    const service = new PaymentService(
      prisma as unknown as PrismaService,
      stripe as unknown as StripeService,
      idempotency as unknown as PaymentIdempotencyService,
      {} as DuffelService,
      {} as AuditService,
      {} as PaymentMethodService,
      {} as BookingLifecycleService,
      validation as unknown as AncillaryPaymentValidationService,
    );

    await expect(
      service.createPayment(
        {
          bookingIntentId: 'intent-1',
          ancillarySelectionId: 'selection-2',
          ancillarySelectionVersion: 2,
          saveCard: false,
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

    expect(idempotency.acquireOrReplay).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(stripe.createCustomer).not.toHaveBeenCalled();
    expect(stripe.createPaymentIntent).not.toHaveBeenCalled();
  });
});
