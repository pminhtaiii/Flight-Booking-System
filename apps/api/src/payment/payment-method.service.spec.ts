import { PaymentMethodService } from './payment-method.service';
import { PrismaService } from '@/prisma/prisma.service';
import { StripeService } from '@/common/stripe.service';

describe('PaymentMethodService', () => {
  const userId = 'user-123';
  const stripeCustomerId = 'cus-123';
  const stripePaymentIntentId = 'pi-123';

  let prisma: {
    paymentMethod: {
      findUnique: jest.Mock;
      create: jest.Mock;
    };
  };
  let stripeService: { retrievePaymentIntent: jest.Mock };
  let service: PaymentMethodService;

  beforeEach(() => {
    prisma = {
      paymentMethod: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'method-123' }),
      },
    };
    stripeService = { retrievePaymentIntent: jest.fn() };
    service = new PaymentMethodService(
      prisma as unknown as PrismaService,
      stripeService as unknown as StripeService,
    );
  });

  it('does not persist a method when the PaymentIntent was not set up for future use', async () => {
    stripeService.retrievePaymentIntent.mockResolvedValue({
      id: stripePaymentIntentId,
      setup_future_usage: null,
      payment_method: {
        id: 'pm-123',
        card: { brand: 'visa', last4: '4242' },
      },
    });

    await service.saveMethod(userId, stripeCustomerId, stripePaymentIntentId);

    expect(prisma.paymentMethod.create).not.toHaveBeenCalled();
  });

  it('persists the method with consent when the PaymentIntent was set up for off-session use', async () => {
    stripeService.retrievePaymentIntent.mockResolvedValue({
      id: stripePaymentIntentId,
      setup_future_usage: 'off_session',
      payment_method: {
        id: 'pm-123',
        card: { brand: 'visa', last4: '4242' },
      },
    });

    await service.saveMethod(userId, stripeCustomerId, stripePaymentIntentId);

    expect(prisma.paymentMethod.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId,
        stripeCustomerId,
        stripePaymentMethodId: 'pm-123',
        savedWithConsent: true,
      }),
    });
  });
});
