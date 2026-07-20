import { StripeService } from './stripe.service';

describe('StripeService', () => {
  const originalSecretKey = process.env.STRIPE_SECRET_KEY;

  afterEach(() => {
    if (originalSecretKey === undefined) {
      delete process.env.STRIPE_SECRET_KEY;
      return;
    }

    process.env.STRIPE_SECRET_KEY = originalSecretKey;
  });

  it('expands the payment method when retrieving a PaymentIntent', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_payment_method_expansion';
    const service = new StripeService();
    const retrieve = jest.fn().mockResolvedValue({ id: 'pi_123' });

    Object.defineProperty(service, 'stripe', {
      value: { paymentIntents: { retrieve } },
    });

    await service.retrievePaymentIntent('pi_123');

    expect(retrieve).toHaveBeenCalledWith('pi_123', {
      expand: ['payment_method'],
    });
  });
});
