import { StripeService } from './stripe.service';

describe('StripeService', () => {
  const originalSecretKey = process.env.STRIPE_SECRET_KEY;
  const originalApiUrl = process.env.STRIPE_API_URL;

  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_123';
    delete process.env.STRIPE_API_URL;
  });

  afterEach(() => {
    if (originalSecretKey === undefined) {
      delete process.env.STRIPE_SECRET_KEY;
    } else {
      process.env.STRIPE_SECRET_KEY = originalSecretKey;
    }

    if (originalApiUrl === undefined) {
      delete process.env.STRIPE_API_URL;
    } else {
      process.env.STRIPE_API_URL = originalApiUrl;
    }
  });

  describe('Stripe provider override', () => {
    it('initializes Stripe SDK with default options when STRIPE_API_URL is undefined', () => {
      delete process.env.STRIPE_API_URL;
      const service = new StripeService();
      const api = (service as any).stripe._api;
      expect(api.host).toBe('api.stripe.com');
      expect(api.protocol).toBe('https');
    });

    it('configures Stripe client with parsed protocol, host, and port when STRIPE_API_URL is set', () => {
      process.env.STRIPE_API_URL = 'http://127.0.0.1:4010';
      const service = new StripeService();
      const api = (service as any).stripe._api;
      expect(api.protocol).toBe('http');
      expect(api.host).toBe('127.0.0.1');
      expect(Number(api.port)).toBe(4010);
    });

    it('configures Stripe client without port override when STRIPE_API_URL has no port', () => {
      process.env.STRIPE_API_URL = 'https://custom-stripe.local';
      const service = new StripeService();
      const api = (service as any).stripe._api;
      expect(api.protocol).toBe('https');
      expect(api.host).toBe('custom-stripe.local');
    });

    it('throws an initialization error when STRIPE_API_URL is invalid', () => {
      process.env.STRIPE_API_URL = 'invalid-url';
      expect(() => new StripeService()).toThrow();
    });

    it('throws an initialization error when STRIPE_API_URL has an unsupported protocol', () => {
      process.env.STRIPE_API_URL = 'ws://127.0.0.1:4010';
      expect(() => new StripeService()).toThrow();

      process.env.STRIPE_API_URL = 'ftp://127.0.0.1:4010';
      expect(() => new StripeService()).toThrow();
    });
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
