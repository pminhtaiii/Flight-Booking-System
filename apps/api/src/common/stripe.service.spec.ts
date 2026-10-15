import * as http from 'node:http';
import { Test } from '@nestjs/testing';
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

  describe('Authorization Expiry Extraction (extractAuthorizationExpiry)', () => {
    it('rejects finite expiry seconds outside the representable Date range', async (): Promise<void> => {
      const module = await Test.createTestingModule({ providers: [StripeService] }).compile();
      const service = module.get(StripeService);
      try {
        for (const kind of ['card', 'card_present']) {
          expect(
            service.extractAuthorizationExpiry({
              latest_charge: {
                payment_method_details: { [kind]: { capture_before: Number.MAX_VALUE } },
              },
            }),
          ).toBeNull();
        }
      } finally {
        await module.close();
      }
    });
    it('extracts actual authorization expiry from latest_charge.payment_method_details.card.capture_before', () => {
      const service = new StripeService();
      const captureBeforeSeconds = 1735689600;
      const paymentIntent = {
        id: 'pi_test_card',
        latest_charge: {
          id: 'ch_test_1',
          payment_method_details: {
            card: {
              capture_before: captureBeforeSeconds,
            },
          },
        },
      };

      const expiry = service.extractAuthorizationExpiry(paymentIntent);
      expect(expiry).toEqual(new Date(captureBeforeSeconds * 1000));
    });

    it('extracts actual authorization expiry from latest_charge.payment_method_details.card_present.capture_before', () => {
      const service = new StripeService();
      const captureBeforeSeconds = 1735700000;
      const paymentIntent = {
        id: 'pi_test_card_present',
        latest_charge: {
          id: 'ch_test_2',
          payment_method_details: {
            card_present: {
              capture_before: captureBeforeSeconds,
            },
          },
        },
      };

      const expiry = service.extractAuthorizationExpiry(paymentIntent);
      expect(expiry).toEqual(new Date(captureBeforeSeconds * 1000));
    });

    it('returns null when capture_before is absent without guessing expiry', () => {
      const service = new StripeService();
      const paymentIntent = {
        id: 'pi_test_no_capture_before',
        created: 1700000000,
        latest_charge: {
          id: 'ch_test_3',
          payment_method_details: {
            card: {
              brand: 'visa',
            },
          },
        },
      };

      const expiry = service.extractAuthorizationExpiry(paymentIntent);
      expect(expiry).toBeNull();
    });

    it('returns null when capture_before is non-finite or non-positive without guessing', () => {
      const service = new StripeService();
      for (const invalidValue of [
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        0,
        -100,
      ]) {
        const paymentIntent = {
          id: 'pi_test_invalid_ts',
          latest_charge: {
            id: 'ch_test',
            payment_method_details: {
              card: {
                capture_before: invalidValue,
              },
            },
          },
        };
        expect(service.extractAuthorizationExpiry(paymentIntent)).toBeNull();
      }
    });

    it('returns null when latest_charge is missing or unexpanded even if charges.data has historical charges', () => {
      const service = new StripeService();
      const paymentIntent = {
        id: 'pi_test_historical',
        latest_charge: 'ch_unexpanded_id',
        charges: {
          data: [
            {
              id: 'ch_old_1',
              payment_method_details: {
                card: {
                  capture_before: 1735689600,
                },
              },
            },
          ],
        },
      };
      expect(service.extractAuthorizationExpiry(paymentIntent)).toBeNull();
    });

    it('returns null when latest_charge is null or a string ID', () => {
      const service = new StripeService();
      expect(service.extractAuthorizationExpiry({ id: 'pi_1', latest_charge: null })).toBeNull();
      expect(
        service.extractAuthorizationExpiry({ id: 'pi_2', latest_charge: 'ch_unexpanded' }),
      ).toBeNull();
      expect(service.extractAuthorizationExpiry(null)).toBeNull();
      expect(service.extractAuthorizationExpiry(undefined)).toBeNull();
      expect(service.extractAuthorizationExpiry('not-an-object')).toBeNull();
    });
  });

  describe('Capture Normalization (normalizeCapture)', () => {
    it('requires valid intended money and currency before confirming a full capture', async (): Promise<void> => {
      const module = await Test.createTestingModule({ providers: [StripeService] }).compile();
      const service = module.get(StripeService);
      try {
        for (const amount of [undefined, null, 0, -1, Number.NaN, Infinity, 1.5]) {
          expect(
            service.normalizeCapture({
              status: 'succeeded',
              amount,
              amount_received: 1000,
              currency: 'usd',
            }).succeeded,
          ).toBe(false);
        }
        for (const currency of [undefined, null, '', ' ', 'US', 'usd!']) {
          expect(
            service.normalizeCapture({
              status: 'succeeded',
              amount: 1000,
              amount_received: 1000,
              currency,
            }).succeeded,
          ).toBe(false);
        }
      } finally {
        await module.close();
      }
    });
    it('normalizes succeeded PaymentIntent with amount_received to confirmed capture', () => {
      const service = new StripeService();
      const paymentIntent = {
        id: 'pi_test_succeeded',
        status: 'succeeded',
        amount: 8500,
        amount_received: 8500,
        currency: 'usd',
      };

      const result = service.normalizeCapture(paymentIntent);
      expect(result).toEqual({
        succeeded: true,
        status: 'succeeded',
        capturedAmount: 8500,
        currency: 'usd',
      });
    });

    it('does not fall back to amount when amount_received is undefined, returning capturedAmount: 0 and succeeded: false', () => {
      const service = new StripeService();
      const paymentIntent = {
        id: 'pi_test_fallback',
        status: 'succeeded',
        amount: 9900,
        currency: 'eur',
      };

      const result = service.normalizeCapture(paymentIntent);
      expect(result).toEqual({
        succeeded: false,
        status: 'succeeded',
        capturedAmount: 0,
        currency: 'eur',
      });
    });

    it('normalizes partial capture (amount_received < amount) to succeeded: false', () => {
      const service = new StripeService();
      const paymentIntent = {
        id: 'pi_test_partial',
        status: 'succeeded',
        amount: 10000,
        amount_received: 2000,
        currency: 'usd',
      };

      const result = service.normalizeCapture(paymentIntent);
      expect(result).toEqual({
        succeeded: false,
        status: 'succeeded',
        capturedAmount: 2000,
        currency: 'usd',
      });
    });

    it.each([
      ['requires_capture'],
      ['processing'],
      ['requires_action'],
      ['requires_confirmation'],
      ['requires_payment_method'],
      ['canceled'],
      ['unknown_status'],
    ])('normalizes non-succeeded status "%s" to succeeded: false', (status) => {
      const service = new StripeService();
      const paymentIntent = {
        id: 'pi_test_non_succeeded',
        status,
        amount: 5000,
        currency: 'usd',
      };

      const result = service.normalizeCapture(paymentIntent);
      expect(result).toEqual({
        succeeded: false,
        status,
        capturedAmount: 0,
        currency: 'usd',
      });
    });

    it('safely handles non-object or malformed input', () => {
      const service = new StripeService();
      expect(service.normalizeCapture(null)).toEqual({
        succeeded: false,
        status: 'unknown',
        capturedAmount: 0,
      });
      expect(service.normalizeCapture(undefined)).toEqual({
        succeeded: false,
        status: 'unknown',
        capturedAmount: 0,
      });
    });
  });

  describe('Nullable-ID Guards and Expanded Retrieve', () => {
    it('expands payment_method and latest_charge when retrieving a PaymentIntent via actual Stripe SDK loopback transport', async () => {
      let requestedUrl = '';
      const server = http.createServer((req, res) => {
        requestedUrl = req.url ?? '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'pi_loopback_123',
            object: 'payment_intent',
            amount: 1000,
            currency: 'usd',
            status: 'requires_capture',
            latest_charge: null,
            payment_method: null,
          }),
        );
      });

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Server address not available');
      }
      const port = address.port;

      process.env.STRIPE_SECRET_KEY = 'sk_test_loopback_expand';
      process.env.STRIPE_API_URL = `http://127.0.0.1:${port}`;

      try {
        const service = new StripeService();
        const result = await service.retrievePaymentIntent('pi_loopback_123');

        expect(result.id).toBe('pi_loopback_123');
        expect(requestedUrl).toContain('/v1/payment_intents/pi_loopback_123');
        const decodedUrl = decodeURIComponent(requestedUrl);
        expect(decodedUrl).toContain('expand[0]=payment_method');
        expect(decodedUrl).toContain('expand[1]=latest_charge');
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          });
        });
      }
    });

    it.each([
      ['empty string', ''],
      ['whitespace only', '   '],
    ])('throws when retrievePaymentIntent is called with %s', async (_desc, invalidId) => {
      const service = new StripeService();
      await expect(service.retrievePaymentIntent(invalidId)).rejects.toThrow('PaymentIntent ID');
    });

    it.each([
      ['empty string', ''],
      ['whitespace only', '   '],
    ])('throws when capturePaymentIntent is called with %s', async (_desc, invalidId) => {
      const service = new StripeService();
      await expect(service.capturePaymentIntent(invalidId)).rejects.toThrow('PaymentIntent ID');
    });

    it.each([
      ['empty string', ''],
      ['whitespace only', '   '],
    ])('throws when cancelPaymentIntent is called with %s', async (_desc, invalidId) => {
      const service = new StripeService();
      await expect(service.cancelPaymentIntent(invalidId)).rejects.toThrow('PaymentIntent ID');
    });

    it.each([
      ['empty string', ''],
      ['whitespace only', '   '],
    ])('throws when createRefund is called with %s', async (_desc, invalidId) => {
      const service = new StripeService();
      await expect(service.createRefund(invalidId)).rejects.toThrow('PaymentIntent ID');
    });

    it.each([
      ['empty string', ''],
      ['whitespace only', '   '],
    ])('throws when detachPaymentMethod is called with %s', async (_desc, invalidId) => {
      const service = new StripeService();
      await expect(service.detachPaymentMethod(invalidId)).rejects.toThrow('PaymentMethod ID');
    });

    it.each([
      ['empty string', ''],
      ['whitespace only', '   '],
    ])('throws when retrieveRefund is called with %s', async (_desc, invalidId) => {
      const service = new StripeService();
      await expect(service.retrieveRefund(invalidId)).rejects.toThrow('Refund ID');
    });

    it.each([
      ['empty string', ''],
      ['whitespace only', '   '],
    ])('throws when retrieveCharge is called with %s', async (_desc, invalidId) => {
      const service = new StripeService();
      await expect(service.retrieveCharge(invalidId)).rejects.toThrow('Charge ID');
    });
  });
});
