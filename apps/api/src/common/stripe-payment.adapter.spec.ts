import { Test, TestingModule } from '@nestjs/testing';
import { StripeService } from './stripe.service';
import { StripePaymentAdapter } from './stripe-payment.adapter';
import { StripeModule } from './stripe.module';
import {
  PAYMENT_GATEWAY_PORT,
  PaymentGatewayPort,
  PortInvocationControl,
} from '@/payment-fulfillment/ports';
import {
  BoundedSemaphore,
  AdmissionQueueFullException,
  AdmissionTimeoutException,
} from '@/payment-fulfillment/utils/bounded-semaphore';

describe('StripePaymentAdapter', () => {
  let stripeService: jest.Mocked<StripeService>;
  let adapter: StripePaymentAdapter;

  const createControl = (beforeInvokeImpl?: () => Promise<void>): PortInvocationControl => ({
    beforeInvoke: beforeInvokeImpl
      ? jest.fn().mockImplementation(beforeInvokeImpl)
      : jest.fn().mockResolvedValue(undefined),
  });

  beforeEach(() => {
    stripeService = {
      retrievePaymentIntent: jest.fn(),
      capturePaymentIntent: jest.fn(),
      cancelPaymentIntent: jest.fn(),
    } as unknown as jest.Mocked<StripeService>;

    adapter = new StripePaymentAdapter(stripeService);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('Semaphore Configuration & Defaults', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it('initializes with default semaphore parameters (20, 100, 5000) when env vars are absent', () => {
      delete process.env.STRIPE_ADMISSION_ACTIVE_LIMIT;
      delete process.env.STRIPE_ADMISSION_QUEUE_LIMIT;
      delete process.env.STRIPE_ADMISSION_TIMEOUT_MS;

      const defaultAdapter = new StripePaymentAdapter(stripeService);
      const sem = defaultAdapter.semaphore;

      expect(sem.activeLimit).toBe(20);
      expect(sem.queueLimit).toBe(100);
      expect(sem.timeoutMs).toBe(5000);
    });

    it('configures semaphore limits from environment variables when provided', () => {
      process.env.STRIPE_ADMISSION_ACTIVE_LIMIT = '5';
      process.env.STRIPE_ADMISSION_QUEUE_LIMIT = '15';
      process.env.STRIPE_ADMISSION_TIMEOUT_MS = '2500';

      const configuredAdapter = new StripePaymentAdapter(stripeService);
      const sem = configuredAdapter.semaphore;

      expect(sem.activeLimit).toBe(5);
      expect(sem.queueLimit).toBe(15);
      expect(sem.timeoutMs).toBe(2500);
    });

    it('accepts an injected BoundedSemaphore instance via constructor', () => {
      const customSem = new BoundedSemaphore(3, 7, 1200);
      const customAdapter = new StripePaymentAdapter(stripeService, customSem);

      expect(customAdapter.semaphore).toBe(customSem);
      expect(customAdapter.semaphore.activeLimit).toBe(3);
    });

    it.each([
      ['STRIPE_ADMISSION_ACTIVE_LIMIT', '5workers'],
      ['STRIPE_ADMISSION_ACTIVE_LIMIT', '2.5'],
      ['STRIPE_ADMISSION_ACTIVE_LIMIT', '-1'],
      ['STRIPE_ADMISSION_ACTIVE_LIMIT', '0'],
      ['STRIPE_ADMISSION_QUEUE_LIMIT', '5workers'],
      ['STRIPE_ADMISSION_QUEUE_LIMIT', '2.5'],
      ['STRIPE_ADMISSION_QUEUE_LIMIT', '-1'],
      ['STRIPE_ADMISSION_QUEUE_LIMIT', '0'],
      ['STRIPE_ADMISSION_TIMEOUT_MS', '5workers'],
      ['STRIPE_ADMISSION_TIMEOUT_MS', '2.5'],
      ['STRIPE_ADMISSION_TIMEOUT_MS', '-1'],
      ['STRIPE_ADMISSION_TIMEOUT_MS', '0'],
    ])(
      'throws an Error naming the variable when %s is set to %p',
      (envVar, invalidValue) => {
        process.env[envVar] = invalidValue;
        expect(() => new StripePaymentAdapter(stripeService)).toThrow(
          `Invalid configuration for ${envVar}: "${invalidValue}"`,
        );
      },
    );
  });

  describe('authorizeHold', () => {
    it.each([
      ['requires_capture', 'authorized'],
      ['succeeded', 'captured'],
      ['canceled', 'voided'],
      ['processing', 'nonfinal'],
      ['requires_payment_method', 'invalid'],
      ['requires_action', 'nonfinal'],
      ['requires_confirmation', 'nonfinal'],
      ['unknown_status_xyz', 'invalid'],
    ])('normalizes Stripe status "%s" to "%s"', async (stripeStatus, expectedStatus) => {
      stripeService.retrievePaymentIntent.mockResolvedValue({
        id: 'pi_test_123',
        status: stripeStatus,
        amount: 8500,
        currency: 'usd',
      } as any);

      const control = createControl();
      const result = await adapter.authorizeHold('pi_test_123', control);

      expect(stripeService.retrievePaymentIntent).toHaveBeenCalledWith('pi_test_123');
      expect(control.beforeInvoke).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        status: expectedStatus,
        intentId: 'pi_test_123',
        amount: 8500,
        currency: 'usd',
        rawStatus: stripeStatus,
      });
    });

    it('propagates error and releases permit when retrievePaymentIntent throws', async () => {
      stripeService.retrievePaymentIntent.mockRejectedValue(new Error('Stripe API unreachable'));
      const control = createControl();

      await expect(adapter.authorizeHold('pi_fail', control)).rejects.toThrow('Stripe API unreachable');
      expect(adapter.semaphore.activeCount).toBe(0);
    });
  });

  describe('capturePayment', () => {
    it('captures payment intent with captureKey and extracts amount_received', async () => {
      stripeService.capturePaymentIntent.mockResolvedValue({
        id: 'pi_cap_123',
        status: 'succeeded',
        amount: 12000,
        amount_received: 12000,
        currency: 'usd',
      } as any);

      const control = createControl();
      const result = await adapter.capturePayment('pi_cap_123', 'idemp_key_stripe_capture', control);

      expect(stripeService.capturePaymentIntent).toHaveBeenCalledWith(
        'pi_cap_123',
        undefined,
        'idemp_key_stripe_capture',
      );
      expect(control.beforeInvoke).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        success: true,
        intentId: 'pi_cap_123',
        status: 'succeeded',
        capturedAmount: 12000,
        currency: 'usd',
      });
      expect(adapter.semaphore.activeCount).toBe(0);
    });

    it('falls back to amount when amount_received is undefined or null', async () => {
      stripeService.capturePaymentIntent.mockResolvedValue({
        id: 'pi_cap_456',
        status: 'succeeded',
        amount: 9900,
        amount_received: undefined,
        currency: 'eur',
      } as any);

      const control = createControl();
      const result = await adapter.capturePayment('pi_cap_456', 'idemp_key_fallback', control);

      expect(result.capturedAmount).toBe(9900);
      expect(result.currency).toBe('eur');
      expect(adapter.semaphore.activeCount).toBe(0);
    });

    it('propagates error and releases permit when capturePaymentIntent throws', async () => {
      stripeService.capturePaymentIntent.mockRejectedValue(new Error('Card declined on capture'));
      const control = createControl();

      await expect(
        adapter.capturePayment('pi_cap_fail', 'cap_key', control),
      ).rejects.toThrow('Card declined on capture');
      expect(adapter.semaphore.activeCount).toBe(0);
    });

    it.each([
      'processing',
      'requires_action',
      'requires_capture',
      'requires_confirmation',
      'requires_payment_method',
      'canceled',
    ])(
      'returns success: false when capture returns non-succeeded status "%s"',
      async (stripeStatus) => {
        stripeService.capturePaymentIntent.mockResolvedValue({
          id: 'pi_cap_nonfinal',
          status: stripeStatus,
          amount: 5000,
          amount_received: 0,
          currency: 'usd',
        } as any);

        const control = createControl();
        const result = await adapter.capturePayment('pi_cap_nonfinal', 'cap_key', control);

        expect(result).toEqual({
          success: false,
          intentId: 'pi_cap_nonfinal',
          status: stripeStatus,
          capturedAmount: 0,
          currency: 'usd',
        });
        expect(adapter.semaphore.activeCount).toBe(0);
      },
    );
  });

  describe('voidHold', () => {
    it('calls cancelPaymentIntent and returns VoidHoldOutcome', async () => {
      stripeService.cancelPaymentIntent.mockResolvedValue({
        id: 'pi_void_123',
        status: 'canceled',
      } as any);

      const control = createControl();
      const result = await adapter.voidHold('pi_void_123', control);

      expect(stripeService.cancelPaymentIntent).toHaveBeenCalledWith(
        'pi_void_123',
        'pi_void_123-stripe-void',
      );
      expect(control.beforeInvoke).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        success: true,
        intentId: 'pi_void_123',
        status: 'canceled',
      });
      expect(adapter.semaphore.activeCount).toBe(0);
    });

    it('propagates error and releases permit when cancelPaymentIntent throws', async () => {
      stripeService.cancelPaymentIntent.mockRejectedValue(new Error('Cannot cancel captured intent'));
      const control = createControl();

      await expect(adapter.voidHold('pi_void_err', control)).rejects.toThrow(
        'Cannot cancel captured intent',
      );
      expect(adapter.semaphore.activeCount).toBe(0);
    });
  });

  describe('Invocation Control & Order of Operations', () => {
    it('calls control.beforeInvoke() after permit acquisition and immediately before the SDK call in authorizeHold', async () => {
      const callLog: string[] = [];

      const sem = new BoundedSemaphore(1, 5, 5000);
      const customAdapter = new StripePaymentAdapter(stripeService, sem);

      const control: PortInvocationControl = {
        beforeInvoke: jest.fn().mockImplementation(async () => {
          callLog.push(`beforeInvoke:activeCount=${sem.activeCount}`);
        }),
      };

      stripeService.retrievePaymentIntent.mockImplementation(async () => {
        callLog.push(`retrievePaymentIntent:activeCount=${sem.activeCount}`);
        return {
          id: 'pi_seq_1',
          status: 'requires_capture',
          amount: 5000,
          currency: 'usd',
        } as any;
      });

      await customAdapter.authorizeHold('pi_seq_1', control);

      expect(callLog).toEqual([
        'beforeInvoke:activeCount=1',
        'retrievePaymentIntent:activeCount=1',
      ]);
      expect(sem.activeCount).toBe(0);
    });

    it('calls control.beforeInvoke() after permit acquisition and immediately before the SDK call in capturePayment', async () => {
      const callLog: string[] = [];

      const sem = new BoundedSemaphore(1, 5, 5000);
      const customAdapter = new StripePaymentAdapter(stripeService, sem);

      const control: PortInvocationControl = {
        beforeInvoke: jest.fn().mockImplementation(async () => {
          callLog.push(`beforeInvoke:activeCount=${sem.activeCount}`);
        }),
      };

      stripeService.capturePaymentIntent.mockImplementation(async () => {
        callLog.push(`capturePaymentIntent:activeCount=${sem.activeCount}`);
        return {
          id: 'pi_seq_2',
          status: 'succeeded',
          amount: 5000,
          currency: 'usd',
        } as any;
      });

      await customAdapter.capturePayment('pi_seq_2', 'cap_key', control);

      expect(callLog).toEqual([
        'beforeInvoke:activeCount=1',
        'capturePaymentIntent:activeCount=1',
      ]);
      expect(sem.activeCount).toBe(0);
    });

    it('calls control.beforeInvoke() after permit acquisition and immediately before the SDK call in voidHold', async () => {
      const callLog: string[] = [];

      const sem = new BoundedSemaphore(1, 5, 5000);
      const customAdapter = new StripePaymentAdapter(stripeService, sem);

      const control: PortInvocationControl = {
        beforeInvoke: jest.fn().mockImplementation(async () => {
          callLog.push(`beforeInvoke:activeCount=${sem.activeCount}`);
        }),
      };

      stripeService.cancelPaymentIntent.mockImplementation(async () => {
        callLog.push(`cancelPaymentIntent:activeCount=${sem.activeCount}`);
        return {
          id: 'pi_seq_3',
          status: 'canceled',
        } as any;
      });

      await customAdapter.voidHold('pi_seq_3', control);

      expect(callLog).toEqual([
        'beforeInvoke:activeCount=1',
        'cancelPaymentIntent:activeCount=1',
      ]);
      expect(sem.activeCount).toBe(0);
    });

    it('releases permit and NEVER calls StripeService when control.beforeInvoke() throws in authorizeHold', async () => {
      const sem = new BoundedSemaphore(1, 5, 5000);
      const customAdapter = new StripePaymentAdapter(stripeService, sem);

      const control: PortInvocationControl = {
        beforeInvoke: jest.fn().mockRejectedValue(new Error('Ownership lease lost before authorizeHold')),
      };

      await expect(customAdapter.authorizeHold('pi_loss', control)).rejects.toThrow(
        'Ownership lease lost before authorizeHold',
      );

      expect(stripeService.retrievePaymentIntent).not.toHaveBeenCalled();
      expect(sem.activeCount).toBe(0);
    });

    it('releases permit and NEVER calls StripeService when control.beforeInvoke() throws in capturePayment', async () => {
      const sem = new BoundedSemaphore(1, 5, 5000);
      const customAdapter = new StripePaymentAdapter(stripeService, sem);

      const control: PortInvocationControl = {
        beforeInvoke: jest.fn().mockRejectedValue(new Error('Ownership lease lost before capturePayment')),
      };

      await expect(customAdapter.capturePayment('pi_loss', 'cap_key', control)).rejects.toThrow(
        'Ownership lease lost before capturePayment',
      );

      expect(stripeService.capturePaymentIntent).not.toHaveBeenCalled();
      expect(sem.activeCount).toBe(0);
    });

    it('releases permit and NEVER calls StripeService when control.beforeInvoke() throws in voidHold', async () => {
      const sem = new BoundedSemaphore(1, 5, 5000);
      const customAdapter = new StripePaymentAdapter(stripeService, sem);

      const control: PortInvocationControl = {
        beforeInvoke: jest.fn().mockRejectedValue(new Error('Ownership lease lost before voidHold')),
      };

      await expect(customAdapter.voidHold('pi_loss', control)).rejects.toThrow(
        'Ownership lease lost before voidHold',
      );

      expect(stripeService.cancelPaymentIntent).not.toHaveBeenCalled();
      expect(sem.activeCount).toBe(0);
    });
  });

  describe('Admission Control: Queue Full & Timeout Guarantees', () => {
    it('rejects with AdmissionQueueFullException without calling beforeInvoke or StripeService when queue is full', async () => {
      // 1 active, 1 queue limit
      const sem = new BoundedSemaphore(1, 1, 5000);
      const customAdapter = new StripePaymentAdapter(stripeService, sem);

      // Acquire active permit
      const releasePermit1 = await sem.acquire();
      expect(sem.activeCount).toBe(1);

      // Fill the single waiting slot in queue
      const queuedCallPromise = customAdapter.authorizeHold(
        'pi_queued',
        createControl(),
      );
      expect(sem.waitingCount).toBe(1);

      // Next call exceeds queueLimit (1)
      const controlBlocked = createControl();
      await expect(
        customAdapter.authorizeHold('pi_overflow', controlBlocked),
      ).rejects.toThrow(AdmissionQueueFullException);

      expect(controlBlocked.beforeInvoke).not.toHaveBeenCalled();
      expect(stripeService.retrievePaymentIntent).not.toHaveBeenCalled();

      // Clean up queued call
      stripeService.retrievePaymentIntent.mockResolvedValue({
        id: 'pi_queued',
        status: 'requires_capture',
        amount: 1000,
        currency: 'usd',
      } as any);

      releasePermit1();
      await queuedCallPromise;
      expect(sem.activeCount).toBe(0);
      expect(sem.waitingCount).toBe(0);
    });

    it('rejects with AdmissionTimeoutException without calling beforeInvoke or StripeService when admission times out', async () => {
      jest.useFakeTimers();

      // 1 active, 2 queue limit, 1000ms timeout
      const sem = new BoundedSemaphore(1, 2, 1000);
      const customAdapter = new StripePaymentAdapter(stripeService, sem);

      // Occupy active permit
      const releasePermit1 = await sem.acquire();

      const control = createControl();
      let capturedError: unknown;

      const callPromise = customAdapter
        .authorizeHold('pi_timeout', control)
        .catch((err: unknown) => {
          capturedError = err;
        });

      expect(sem.waitingCount).toBe(1);

      // Advance time beyond timeoutMs (1000ms)
      jest.advanceTimersByTime(1000);
      await Promise.resolve(); // flush microtasks
      await callPromise;

      expect(capturedError).toBeInstanceOf(AdmissionTimeoutException);
      expect(control.beforeInvoke).not.toHaveBeenCalled();
      expect(stripeService.retrievePaymentIntent).not.toHaveBeenCalled();

      expect(sem.waitingCount).toBe(0);
      expect(sem.activeCount).toBe(1);

      releasePermit1();
      expect(sem.activeCount).toBe(0);
    });
  });

  describe('Module Wiring (StripeModule)', () => {
    it('binds and exports PAYMENT_GATEWAY_PORT to StripePaymentAdapter in StripeModule', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_fake_key_module_wiring';
      const moduleRef: TestingModule = await Test.createTestingModule({
        imports: [StripeModule],
      }).compile();

      const gatewayPort = moduleRef.get<PaymentGatewayPort>(PAYMENT_GATEWAY_PORT);
      const adapterInstance = moduleRef.get<StripePaymentAdapter>(StripePaymentAdapter);
      const stripeServiceInstance = moduleRef.get<StripeService>(StripeService);

      expect(gatewayPort).toBeDefined();
      expect(adapterInstance).toBeDefined();
      expect(stripeServiceInstance).toBeDefined();

      expect(gatewayPort).toBeInstanceOf(StripePaymentAdapter);
      expect(adapterInstance).toBeInstanceOf(StripePaymentAdapter);
      expect(moduleRef.get(PAYMENT_GATEWAY_PORT)).toBe(moduleRef.get(StripePaymentAdapter));
    });
  });
});
