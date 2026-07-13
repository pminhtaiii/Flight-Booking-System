import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { StripeService } from './stripe.service';
import Stripe from 'stripe';

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => {
    return {
      paymentIntents: {
        create: jest.fn(),
        capture: jest.fn(),
        cancel: jest.fn(),
        retrieve: jest.fn(),
      },
      customers: {
        create: jest.fn(),
      },
      refunds: {
        create: jest.fn(),
      },
      paymentMethods: {
        retrieve: jest.fn(),
        detach: jest.fn(),
      },
      webhooks: {
        constructEvent: jest.fn(),
      },
    };
  });
});

describe('StripeService', () => {
  let service: StripeService;
  let mockStripeInstance: {
    paymentIntents: {
      create: jest.Mock;
      capture: jest.Mock;
      cancel: jest.Mock;
      retrieve: jest.Mock;
    };
    customers: {
      create: jest.Mock;
    };
    refunds: {
      create: jest.Mock;
    };
    paymentMethods: {
      retrieve: jest.Mock;
      detach: jest.Mock;
    };
    webhooks: {
      constructEvent: jest.Mock;
    };
  };

  const mockConfigService = {
    get: jest.fn((key: string) => {
      if (key === 'STRIPE_SECRET_KEY') return 'sk_test_mock';
      if (key === 'STRIPE_WEBHOOK_SECRET') return 'whsec_mock';
      return null;
    }),
  };

  beforeEach(async () => {
    mockConfigService.get.mockImplementation((key: string) => {
      if (key === 'STRIPE_SECRET_KEY') return 'sk_test_mock';
      if (key === 'STRIPE_WEBHOOK_SECRET') return 'whsec_mock';
      return null;
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StripeService,
        { provide: ConfigService, useValue: mockConfigService as unknown as ConfigService },
      ],
    }).compile();

    service = module.get<StripeService>(StripeService);
    // Get the mocked Stripe constructor instance
    const StripeConstructor = require('stripe');
    mockStripeInstance = StripeConstructor.mock.results[0].value;
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createPaymentIntent', () => {
    it('should call stripe.paymentIntents.create with correct params', async () => {
      const mockPi = { id: 'pi_123', status: 'requires_capture' };
      mockStripeInstance.paymentIntents.create.mockResolvedValue(mockPi);

      const result = await service.createPaymentIntent({
        amount: 1000,
        currency: 'usd',
        customerId: 'cus_123',
        metadata: { bookingId: '123' },
        idempotencyKey: 'idemp_key_123',
      });

      expect(mockStripeInstance.paymentIntents.create).toHaveBeenCalledWith(
        {
          amount: 1000,
          currency: 'usd',
          customer: 'cus_123',
          metadata: { bookingId: '123' },
          capture_method: 'manual',
        },
        {
          idempotencyKey: 'idemp_key_123',
        }
      );
      expect(result).toEqual(mockPi);
    });

    it('should support setupFutureUsage parameter', async () => {
      const mockPi = { id: 'pi_123', status: 'requires_capture' };
      mockStripeInstance.paymentIntents.create.mockResolvedValue(mockPi);

      await service.createPaymentIntent({
        amount: 1000,
        currency: 'usd',
        idempotencyKey: 'idemp_key_123',
        setupFutureUsage: 'off_session',
      });

      expect(mockStripeInstance.paymentIntents.create).toHaveBeenCalledWith(
        {
          amount: 1000,
          currency: 'usd',
          capture_method: 'manual',
          setup_future_usage: 'off_session',
        },
        {
          idempotencyKey: 'idemp_key_123',
        }
      );
    });
  });

  describe('capturePaymentIntent', () => {
    it('should call stripe.paymentIntents.capture', async () => {
      const mockPi = { id: 'pi_123', status: 'succeeded' };
      mockStripeInstance.paymentIntents.capture.mockResolvedValue(mockPi);

      const result = await service.capturePaymentIntent('pi_123', 'idemp_capture');

      expect(mockStripeInstance.paymentIntents.capture).toHaveBeenCalledWith(
        'pi_123',
        undefined,
        { idempotencyKey: 'idemp_capture' }
      );
      expect(result).toEqual(mockPi);
    });
  });

  describe('cancelPaymentIntent', () => {
    it('should call stripe.paymentIntents.cancel', async () => {
      const mockPi = { id: 'pi_123', status: 'canceled' };
      mockStripeInstance.paymentIntents.cancel.mockResolvedValue(mockPi);

      const result = await service.cancelPaymentIntent('pi_123', 'idemp_cancel');

      expect(mockStripeInstance.paymentIntents.cancel).toHaveBeenCalledWith(
        'pi_123',
        undefined,
        { idempotencyKey: 'idemp_cancel' }
      );
      expect(result).toEqual(mockPi);
    });
  });

  describe('createCustomer', () => {
    it('should call stripe.customers.create', async () => {
      const mockCustomer = { id: 'cus_123', email: 'test@example.com' };
      mockStripeInstance.customers.create.mockResolvedValue(mockCustomer);

      const result = await service.createCustomer({
        email: 'test@example.com',
        name: 'John Doe',
        metadata: { userId: 'user_123' },
        idempotencyKey: 'idemp_customer',
      });

      expect(mockStripeInstance.customers.create).toHaveBeenCalledWith(
        {
          email: 'test@example.com',
          name: 'John Doe',
          metadata: { userId: 'user_123' },
        },
        {
          idempotencyKey: 'idemp_customer',
        }
      );
      expect(result).toEqual(mockCustomer);
    });
  });

  describe('retrievePaymentIntent', () => {
    it('should call stripe.paymentIntents.retrieve', async () => {
      const mockPi = { id: 'pi_123', status: 'requires_capture' };
      mockStripeInstance.paymentIntents.retrieve.mockResolvedValue(mockPi);

      const result = await service.retrievePaymentIntent('pi_123');

      expect(mockStripeInstance.paymentIntents.retrieve).toHaveBeenCalledWith('pi_123');
      expect(result).toEqual(mockPi);
    });
  });

  describe('createRefund', () => {
    it('should call stripe.refunds.create', async () => {
      const mockRefund = { id: 're_123', amount: 500 };
      mockStripeInstance.refunds.create.mockResolvedValue(mockRefund);

      const result = await service.createRefund({
        paymentIntentId: 'pi_123',
        amount: 500,
        reason: 'requested_by_customer',
        idempotencyKey: 'idemp_refund',
      });

      expect(mockStripeInstance.refunds.create).toHaveBeenCalledWith(
        {
          payment_intent: 'pi_123',
          amount: 500,
          reason: 'requested_by_customer',
        },
        {
          idempotencyKey: 'idemp_refund',
        }
      );
      expect(result).toEqual(mockRefund);
    });
  });

  describe('constructWebhookEvent', () => {
    it('should call stripe.webhooks.constructEvent', () => {
      const mockEvent = { id: 'evt_123', type: 'payment_intent.succeeded' };
      mockStripeInstance.webhooks.constructEvent.mockReturnValue(mockEvent);

      const result = service.constructWebhookEvent('payload_str', 'sig_123');

      expect(mockStripeInstance.webhooks.constructEvent).toHaveBeenCalledWith(
        'payload_str',
        'sig_123',
        'whsec_mock'
      );
      expect(result).toEqual(mockEvent);
    });
  });

  describe('retrievePaymentMethod', () => {
    it('should call stripe.paymentMethods.retrieve', async () => {
      const mockPm = { id: 'pm_123', type: 'card' };
      mockStripeInstance.paymentMethods.retrieve.mockResolvedValue(mockPm);

      const result = await service.retrievePaymentMethod('pm_123');

      expect(mockStripeInstance.paymentMethods.retrieve).toHaveBeenCalledWith('pm_123');
      expect(result).toEqual(mockPm);
    });
  });

  describe('detachPaymentMethod', () => {
    it('should call stripe.paymentMethods.detach', async () => {
      const mockPm = { id: 'pm_123', type: 'card' };
      mockStripeInstance.paymentMethods.detach.mockResolvedValue(mockPm);

      const result = await service.detachPaymentMethod('pm_123');

      expect(mockStripeInstance.paymentMethods.detach).toHaveBeenCalledWith('pm_123');
      expect(result).toEqual(mockPm);
    });
  });

  describe('initialization errors', () => {
    it('should throw error if STRIPE_SECRET_KEY is missing', () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'STRIPE_SECRET_KEY') return null;
        return 'whsec_mock';
      });

      expect(() => new StripeService(mockConfigService as unknown as ConfigService)).toThrow('STRIPE_SECRET_KEY is missing');
    });

    it('should throw error if STRIPE_WEBHOOK_SECRET is missing', () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'STRIPE_SECRET_KEY') return 'sk_test_mock';
        if (key === 'STRIPE_WEBHOOK_SECRET') return null;
        return null;
      });

      expect(() => new StripeService(mockConfigService as unknown as ConfigService)).toThrow('STRIPE_WEBHOOK_SECRET is missing');
    });
  });
});
