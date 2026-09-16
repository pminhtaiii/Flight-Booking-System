import {
  AdmissionQueueFullException,
  AdmissionTimeoutException,
  BoundedSemaphore,
} from '@/payment-fulfillment/utils/bounded-semaphore';
import {
  CreateOrderInput,
  FULFILLMENT_GATEWAY_PORT,
  PassengerEnrichmentInput,
  PersistedOrderEvidence,
  PortInvocationControl,
} from '@/payment-fulfillment/ports';
import { Test, TestingModule } from '@nestjs/testing';
import { CacheService } from '@/cache/cache.service';
import { PrismaService } from '@/prisma/prisma.service';
import { DuffelFulfillmentAdapter } from './duffel-fulfillment.adapter';
import { DuffelService } from './duffel.service';
import { DuffelModule } from './duffel.module';

describe('DuffelFulfillmentAdapter', () => {
  let adapter: DuffelFulfillmentAdapter;
  let mockDuffelService: jest.Mocked<Partial<DuffelService>>;
  let mockControl: PortInvocationControl;

  beforeEach(() => {
    mockDuffelService = {
      createOrder: jest.fn(),
      cancelOrder: jest.fn(),
      retrieveCompleteOrder: jest.fn(),
      mapDuffelOrderToSnapshots: jest.fn(),
    };

    mockControl = {
      beforeInvoke: jest.fn().mockResolvedValue(undefined),
    };

    adapter = new DuffelFulfillmentAdapter(mockDuffelService as DuffelService);
  });

  describe('Semaphore Configuration & Defaults', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it('initializes with default semaphore parameters (10, 100, 5000) when env vars are absent', () => {
      delete process.env.DUFFEL_ADMISSION_ACTIVE_LIMIT;
      delete process.env.DUFFEL_ADMISSION_QUEUE_LIMIT;
      delete process.env.DUFFEL_ADMISSION_TIMEOUT_MS;

      const defaultAdapter = new DuffelFulfillmentAdapter(mockDuffelService as DuffelService);
      const sem = defaultAdapter.semaphore;

      expect(sem.activeLimit).toBe(10);
      expect(sem.queueLimit).toBe(100);
      expect(sem.timeoutMs).toBe(5000);
    });

    it('configures semaphore limits from environment variables when provided', () => {
      process.env.DUFFEL_ADMISSION_ACTIVE_LIMIT = '5';
      process.env.DUFFEL_ADMISSION_QUEUE_LIMIT = '15';
      process.env.DUFFEL_ADMISSION_TIMEOUT_MS = '2500';

      const configuredAdapter = new DuffelFulfillmentAdapter(mockDuffelService as DuffelService);
      const sem = configuredAdapter.semaphore;

      expect(sem.activeLimit).toBe(5);
      expect(sem.queueLimit).toBe(15);
      expect(sem.timeoutMs).toBe(2500);
    });

    it.each([
      ['DUFFEL_ADMISSION_ACTIVE_LIMIT', '5workers'],
      ['DUFFEL_ADMISSION_ACTIVE_LIMIT', '2.5'],
      ['DUFFEL_ADMISSION_ACTIVE_LIMIT', '-1'],
      ['DUFFEL_ADMISSION_ACTIVE_LIMIT', '0'],
      ['DUFFEL_ADMISSION_QUEUE_LIMIT', '5workers'],
      ['DUFFEL_ADMISSION_QUEUE_LIMIT', '2.5'],
      ['DUFFEL_ADMISSION_QUEUE_LIMIT', '-1'],
      ['DUFFEL_ADMISSION_QUEUE_LIMIT', '0'],
      ['DUFFEL_ADMISSION_TIMEOUT_MS', '5workers'],
      ['DUFFEL_ADMISSION_TIMEOUT_MS', '2.5'],
      ['DUFFEL_ADMISSION_TIMEOUT_MS', '-1'],
      ['DUFFEL_ADMISSION_TIMEOUT_MS', '0'],
    ])(
      'throws an Error naming the variable when %s is set to %p',
      (envVar, invalidValue) => {
        process.env[envVar] = invalidValue;
        expect(() => new DuffelFulfillmentAdapter(mockDuffelService as DuffelService)).toThrow(
          `Invalid configuration for ${envVar}: "${invalidValue}"`,
        );
      },
    );
  });

  describe('createOrder', () => {
    const validCreateOrderInput: CreateOrderInput = {
      offerId: 'off_test_123',
      passengers: [
        {
          id: 'pas_test_1',
          givenName: 'John',
          familyName: 'Doe',
          email: 'john.doe@example.com',
          phoneNumber: '+1234567890',
          bornOn: '1990-01-01',
          type: 'adult',
        },
      ],
      services: [{ serviceId: 'srv_bag_123', quantity: 2 }],
      metadata: {
        bookingIntentId: 'intent_123',
        paymentId: 'pay_123',
      },
      idempotencyKey: 'idem_key_123',
    };

    const rawDuffelOrder = {
      id: 'ord_duffel_123',
      booking_reference: 'ABCDEF',
      slices: [
        {
          duration: 'PT2H',
          segments: [
            {
              id: 'seg_1',
              departing_at: '2026-10-01T10:00:00Z',
              arriving_at: '2026-10-01T12:00:00Z',
            },
          ],
        },
      ],
      passengers: [
        {
          id: 'pas_test_1',
          given_name: 'John',
          family_name: 'Doe',
          born_on: '1990-01-01',
          email: 'john.doe@example.com',
          phone_number: '+1234567890',
          type: 'adult',
        },
      ],
    };

    it('maps serviceId to id, passes metadata and idempotencyKey, calls beforeInvoke before SDK, and redacts PII', async () => {
      const callOrder: string[] = [];
      mockControl.beforeInvoke = jest.fn().mockImplementation(async () => {
        callOrder.push('beforeInvoke');
      });
      (mockDuffelService.createOrder as jest.Mock).mockImplementation(async () => {
        callOrder.push('duffelCreateOrder');
        return rawDuffelOrder;
      });

      const outcome = await adapter.createOrder(validCreateOrderInput, mockControl);

      expect(callOrder).toEqual(['beforeInvoke', 'duffelCreateOrder']);
      expect(mockDuffelService.createOrder).toHaveBeenCalledWith(
        'off_test_123',
        validCreateOrderInput.passengers,
        [{ id: 'srv_bag_123', quantity: 2 }],
        {
          bookingIntentId: 'intent_123',
          paymentId: 'pay_123',
        },
        'idem_key_123',
      );

      expect(outcome.orderId).toBe('ord_duffel_123');
      expect(outcome.bookingReference).toBe('ABCDEF');

      // Verify PII redaction on evidence
      const passengers = outcome.evidence.passengers as Array<Record<string, unknown>>;
      const passengerEvidence = passengers[0];
      expect(passengerEvidence.email).toBe('REDACTED');
      expect(passengerEvidence.born_on).toBe('REDACTED');
      expect(passengerEvidence.given_name).toBe('REDACTED');
      expect(passengerEvidence.family_name).toBe('REDACTED');
      expect(passengerEvidence.phone_number).toBe('REDACTED');
      expect(passengerEvidence.id).toBe('pas_test_1');

      // Verify original raw order was not mutated
      expect(rawDuffelOrder.passengers[0].email).toBe('john.doe@example.com');
    });

    it('passes undefined services when services list is empty or omitted', async () => {
      (mockDuffelService.createOrder as jest.Mock).mockResolvedValue(rawDuffelOrder);

      const inputWithoutServices: CreateOrderInput = {
        ...validCreateOrderInput,
        services: [],
      };

      await adapter.createOrder(inputWithoutServices, mockControl);

      expect(mockDuffelService.createOrder).toHaveBeenCalledWith(
        'off_test_123',
        validCreateOrderInput.passengers,
        undefined,
        {
          bookingIntentId: 'intent_123',
          paymentId: 'pay_123',
        },
        'idem_key_123',
      );
    });

    it('releases permit and never calls DuffelService if beforeInvoke fails', async () => {
      mockControl.beforeInvoke = jest.fn().mockRejectedValue(new Error('Pre-flight lock failed'));

      await expect(adapter.createOrder(validCreateOrderInput, mockControl)).rejects.toThrow(
        'Pre-flight lock failed',
      );

      expect(mockDuffelService.createOrder).not.toHaveBeenCalled();
      expect(adapter.semaphore.activeCount).toBe(0);
    });
  });

  describe('cancelOrder', () => {
    it('calls beforeInvoke before calling duffelService.cancelOrder and returns CancelOrderOutcome', async () => {
      const callOrder: string[] = [];
      mockControl.beforeInvoke = jest.fn().mockImplementation(async () => {
        callOrder.push('beforeInvoke');
      });
      (mockDuffelService.cancelOrder as jest.Mock).mockImplementation(async () => {
        callOrder.push('duffelCancelOrder');
        return { id: 'ord_123', status: 'CANCELLED' };
      });

      const outcome = await adapter.cancelOrder('ord_123', mockControl);

      expect(callOrder).toEqual(['beforeInvoke', 'duffelCancelOrder']);
      expect(mockDuffelService.cancelOrder).toHaveBeenCalledWith('ord_123');
      expect(outcome).toEqual({
        success: true,
        orderId: 'ord_123',
        status: 'CANCELLED',
      });
      expect(adapter.semaphore.activeCount).toBe(0);
    });

    it('releases permit and never calls DuffelService if beforeInvoke fails', async () => {
      mockControl.beforeInvoke = jest.fn().mockRejectedValue(new Error('Pre-flight lock failed'));

      await expect(adapter.cancelOrder('ord_123', mockControl)).rejects.toThrow(
        'Pre-flight lock failed',
      );

      expect(mockDuffelService.cancelOrder).not.toHaveBeenCalled();
      expect(adapter.semaphore.activeCount).toBe(0);
    });
  });

  describe('retrieveOrderSnapshot', () => {
    const fallbackEvidence: PersistedOrderEvidence = {
      id: 'ord_fallback_123',
      bookingReference: 'REF123',
      passengers: [
        {
          id: 'pas_1',
          given_name: 'REDACTED',
          family_name: 'REDACTED',
          born_on: 'REDACTED',
          email: 'REDACTED',
          phone_number: 'REDACTED',
          type: 'adult',
        },
      ],
      slices: [
        {
          duration: 'PT2H',
          segments: [
            {
              id: 'seg_1',
              departing_at: '2026-10-01T10:00:00Z',
              arriving_at: '2026-10-01T12:00:00Z',
            },
          ],
        },
      ],
    };

    const passengerEnrichment: PassengerEnrichmentInput[] = [
      {
        id: 'pas_1',
        firstName: 'Jane',
        lastName: 'Smith',
        dateOfBirth: '1985-05-20',
        email: 'jane@example.com',
        phoneNumber: '+1987654321',
      },
    ];

    const mockSnapshots = {
      flightSnapshot: {
        segments: [
          {
            airline: { name: 'British Airways', iataCode: 'BA' },
            flightNumber: 'BA123',
            departureAirport: { iataCode: 'LHR', name: 'Heathrow', city: 'London' },
            arrivalAirport: { iataCode: 'JFK', name: 'JFK', city: 'New York' },
            departureAt: '2026-10-01T10:00:00.000Z',
            arrivalAt: '2026-10-01T13:00:00.000Z',
            duration: 'PT8H',
          },
        ],
        totalDuration: 'PT8H',
        stops: 0,
        cabinClass: 'economy',
      },
      passengerSnapshot: {
        passengers: [
          {
            type: 'ADULT' as const,
            firstName: 'Jane',
            lastName: 'Smith',
            dateOfBirth: '1985-05-20',
          },
        ],
        contactEmail: 'jane@example.com',
        contactPhone: '+1987654321',
      },
    };

    it('returns snapshots and departureAt Date on retrieveCompleteOrder success', async () => {
      const freshOrder = { id: 'ord_123' };
      (mockDuffelService.retrieveCompleteOrder as jest.Mock).mockResolvedValue(freshOrder);
      (mockDuffelService.mapDuffelOrderToSnapshots as jest.Mock).mockReturnValue(mockSnapshots);

      const outcome = await adapter.retrieveOrderSnapshot(
        'ord_123',
        fallbackEvidence,
        passengerEnrichment,
        'contact@example.com',
        mockControl,
      );

      expect(mockControl.beforeInvoke).toHaveBeenCalled();
      expect(mockDuffelService.retrieveCompleteOrder).toHaveBeenCalledWith('ord_123');
      expect(mockDuffelService.mapDuffelOrderToSnapshots).toHaveBeenCalledWith(freshOrder);
      expect(outcome.flightSnapshot).toEqual(mockSnapshots.flightSnapshot);
      expect(outcome.passengerSnapshot).toEqual(mockSnapshots.passengerSnapshot);
      expect(outcome.departureAt).toEqual(new Date('2026-10-01T10:00:00.000Z'));
      expect(adapter.semaphore.activeCount).toBe(0);
    });

    it('falls back to enrichRedactedDuffelOrder when retrieveCompleteOrder throws', async () => {
      (mockDuffelService.retrieveCompleteOrder as jest.Mock).mockRejectedValue(
        new Error('Upstream Duffel error'),
      );
      (mockDuffelService.mapDuffelOrderToSnapshots as jest.Mock).mockReturnValue(mockSnapshots);

      const outcome = await adapter.retrieveOrderSnapshot(
        'ord_123',
        fallbackEvidence,
        passengerEnrichment,
        'contact@example.com',
        mockControl,
      );

      expect(mockDuffelService.retrieveCompleteOrder).toHaveBeenCalledWith('ord_123');
      // mapDuffelOrderToSnapshots should have been called with the enriched fallback evidence
      expect(mockDuffelService.mapDuffelOrderToSnapshots).toHaveBeenCalled();
      const enrichedArg = (mockDuffelService.mapDuffelOrderToSnapshots as jest.Mock).mock.calls[0][0];
      expect(enrichedArg.passengers[0].given_name).toBe('Jane');
      expect(enrichedArg.passengers[0].family_name).toBe('Smith');
      expect(enrichedArg.passengers[0].born_on).toBe('1985-05-20');
      expect(outcome.departureAt).toEqual(new Date('2026-10-01T10:00:00.000Z'));
      expect(adapter.semaphore.activeCount).toBe(0);
    });

    it('releases permit and never calls DuffelService if beforeInvoke fails', async () => {
      mockControl.beforeInvoke = jest.fn().mockRejectedValue(new Error('Pre-flight lock failed'));

      await expect(
        adapter.retrieveOrderSnapshot(
          'ord_123',
          fallbackEvidence,
          passengerEnrichment,
          'contact@example.com',
          mockControl,
        ),
      ).rejects.toThrow('Pre-flight lock failed');

      expect(mockDuffelService.retrieveCompleteOrder).not.toHaveBeenCalled();
      expect(mockDuffelService.mapDuffelOrderToSnapshots).not.toHaveBeenCalled();
      expect(adapter.semaphore.activeCount).toBe(0);
    });
  });

  describe('BoundedSemaphore admission control', () => {
    it('rejects with AdmissionQueueFullException on queue overflow and does not invoke beforeInvoke or SDK', async () => {
      // Create adapter with tiny semaphore: activeLimit = 1, queueLimit = 1, timeoutMs = 2000
      const tightSemaphore = new BoundedSemaphore(1, 1, 2000);
      const tightAdapter = new DuffelFulfillmentAdapter(
        mockDuffelService as DuffelService,
        tightSemaphore,
      );

      let releaseTask1: () => void;
      const task1Promise = new Promise<void>((resolve) => {
        releaseTask1 = resolve;
      });

      // Call 1 occupies active permit
      mockControl.beforeInvoke = jest.fn().mockImplementation(() => task1Promise);
      const call1 = tightAdapter.cancelOrder('ord_1', mockControl);

      // Give event loop tick so call 1 acquires permit and awaits beforeInvoke
      await new Promise((r) => setImmediate(r));
      expect(tightAdapter.semaphore.activeCount).toBe(1);

      // Call 2 queues up
      const call2Control: PortInvocationControl = { beforeInvoke: jest.fn() };
      const call2 = tightAdapter.cancelOrder('ord_2', call2Control);
      expect(tightAdapter.semaphore.waitingCount).toBe(1);

      // Call 3 exceeds queue limit and rejects immediately
      const call3Control: PortInvocationControl = { beforeInvoke: jest.fn() };
      await expect(tightAdapter.cancelOrder('ord_3', call3Control)).rejects.toThrow(
        AdmissionQueueFullException,
      );

      expect(call3Control.beforeInvoke).not.toHaveBeenCalled();
      expect(mockDuffelService.cancelOrder).not.toHaveBeenCalled();

      // Clean up Call 1 and Call 2
      releaseTask1!();
      await call1;
      await call2;
      expect(tightAdapter.semaphore.activeCount).toBe(0);
    });

    it('rejects with AdmissionTimeoutException on admission timeout and does not invoke beforeInvoke or SDK', async () => {
      const timeoutSemaphore = new BoundedSemaphore(1, 2, 50); // 50ms timeout
      const timeoutAdapter = new DuffelFulfillmentAdapter(
        mockDuffelService as DuffelService,
        timeoutSemaphore,
      );

      let releaseTask1: () => void;
      const task1Promise = new Promise<void>((resolve) => {
        releaseTask1 = resolve;
      });

      mockControl.beforeInvoke = jest.fn().mockImplementation(() => task1Promise);
      const call1 = timeoutAdapter.cancelOrder('ord_1', mockControl);

      await new Promise((r) => setImmediate(r));
      expect(timeoutAdapter.semaphore.activeCount).toBe(1);

      // Call 2 queues up and will time out after 50ms
      const call2Control: PortInvocationControl = { beforeInvoke: jest.fn() };
      const call2 = timeoutAdapter.cancelOrder('ord_2', call2Control);

      await expect(call2).rejects.toThrow(AdmissionTimeoutException);
      expect(call2Control.beforeInvoke).not.toHaveBeenCalled();
      expect(mockDuffelService.cancelOrder).not.toHaveBeenCalled();

      // Clean up Call 1
      releaseTask1!();
      await call1;
      expect(timeoutAdapter.semaphore.activeCount).toBe(0);
    });
  });

  describe('Privacy helpers: redactDuffelOrder and enrichRedactedDuffelOrder', () => {
    it('redactDuffelOrder redacts passenger PII while preserving ID and structure', () => {
      const order = {
        id: 'ord_privacy_123',
        booking_reference: 'XYZ987',
        passengers: [
          {
            id: 'pas_1',
            given_name: 'John',
            family_name: 'Doe',
            born_on: '1990-01-01',
            email: 'john@example.com',
            phone_number: '+1234567890',
          },
          {
            id: 'pas_2',
            given_name: 'Jane',
            family_name: 'Doe',
            born_on: '1992-02-02',
            email: 'jane@example.com',
            phone_number: '+1234567891',
          },
        ],
      };

      const redacted = adapter.redactDuffelOrder(order);

      expect(redacted.id).toBe('ord_privacy_123');
      expect(redacted.bookingReference).toBe('XYZ987');
      const passengers = redacted.passengers as Array<Record<string, unknown>>;
      const p1 = passengers[0];
      const p2 = passengers[1];
      expect(p1.email).toBe('REDACTED');
      expect(p1.born_on).toBe('REDACTED');
      expect(p1.given_name).toBe('REDACTED');
      expect(p1.family_name).toBe('REDACTED');
      expect(p1.phone_number).toBe('REDACTED');
      expect(p2.email).toBe('REDACTED');
      expect(p2.born_on).toBe('REDACTED');
      expect(p2.given_name).toBe('REDACTED');
      expect(p2.family_name).toBe('REDACTED');
      expect(p2.phone_number).toBe('REDACTED');
    });

    it('enrichRedactedDuffelOrder restores passenger PII matching by id or index', () => {
      const redactedOrder = {
        id: 'ord_privacy_123',
        booking_reference: 'XYZ987',
        passengers: [
          {
            id: 'pas_1',
            given_name: 'REDACTED',
            family_name: 'REDACTED',
            born_on: 'REDACTED',
            email: 'REDACTED',
            phone_number: 'REDACTED',
          },
          {
            id: 'pas_unknown_id',
            given_name: 'REDACTED',
            family_name: 'REDACTED',
            born_on: 'REDACTED',
            email: 'REDACTED',
            phone_number: 'REDACTED',
          },
        ],
      };

      const passengerEnrichment: PassengerEnrichmentInput[] = [
        {
          id: 'pas_1',
          firstName: 'Alice',
          lastName: 'Wonderland',
          dateOfBirth: '1995-03-15',
          email: 'alice@example.com',
          phoneNumber: '+1112223333',
        },
        {
          // Matched by index 1
          firstName: 'Bob',
          lastName: 'Builder',
          dateOfBirth: '1988-08-08',
          phoneNumber: '+4445556666',
        },
      ];

      const enriched = adapter.enrichRedactedDuffelOrder(
        redactedOrder,
        passengerEnrichment,
        'primary@example.com',
      ) as { passengers: Array<Record<string, unknown>> };

      expect(enriched.passengers[0].given_name).toBe('Alice');
      expect(enriched.passengers[0].family_name).toBe('Wonderland');
      expect(enriched.passengers[0].born_on).toBe('1995-03-15');
      expect(enriched.passengers[0].email).toBe('alice@example.com');
      expect(enriched.passengers[0].phone_number).toBe('+1112223333');

      expect(enriched.passengers[1].given_name).toBe('Bob');
      expect(enriched.passengers[1].family_name).toBe('Builder');
      expect(enriched.passengers[1].born_on).toBe('1988-08-08');
      expect(enriched.passengers[1].phone_number).toBe('+4445556666');
    });
  });

  describe('Module Wiring (DuffelModule)', () => {
    it('binds and exports FULFILLMENT_GATEWAY_PORT as a singleton alias of DuffelFulfillmentAdapter', async () => {
      const moduleRef: TestingModule = await Test.createTestingModule({
        imports: [DuffelModule],
      })
        .overrideProvider(CacheService)
        .useValue({})
        .overrideProvider(PrismaService)
        .useValue({})
        .compile();

      const gatewayPort = moduleRef.get(FULFILLMENT_GATEWAY_PORT);
      const adapterInstance = moduleRef.get(DuffelFulfillmentAdapter);

      expect(gatewayPort).toBeDefined();
      expect(adapterInstance).toBeDefined();
      expect(gatewayPort).toBeInstanceOf(DuffelFulfillmentAdapter);
      expect(adapterInstance).toBeInstanceOf(DuffelFulfillmentAdapter);
      expect(moduleRef.get(FULFILLMENT_GATEWAY_PORT)).toBe(
        moduleRef.get(DuffelFulfillmentAdapter),
      );
    });
  });
});

