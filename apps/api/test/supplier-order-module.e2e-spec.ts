import { Test } from '@nestjs/testing';
import {
  FULFILLMENT_GATEWAY_PORT,
  FulfillmentGatewayPort,
  CreateOrderInput,
} from '@/payment-fulfillment/ports';
import { CacheService } from '@/cache/cache.service';
import { DUFFEL_SDK, DUFFEL_SDK_CONFIGURATION } from '@/supplier/core/duffel-core.module';
import { DuffelCancellationService } from '@/supplier/order/duffel-cancellation.service';
import { DuffelFulfillmentAdapter } from '@/supplier/order/duffel-fulfillment.adapter';
import { DuffelRecoveryService } from '@/supplier/order/duffel-recovery.service';
import { SupplierOrderModule } from '@/supplier/order/supplier-order.module';

describe('SupplierOrderModule (E2E)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('binds the real fulfillment graph and preserves offer matching before the order request', async () => {
    const events: string[] = [];
    const offerPassengers = [
      { id: 'pas_child_1', type: 'child' },
      { id: 'pas_adult_1', type: 'adult' },
      { id: 'pas_infant_1', type: 'infant_without_seat' },
      { id: 'pas_adult_2', type: 'adult' },
    ];
    const getOffer = jest.fn(async (offerId: string) => {
      expect(offerId).toBe('off_graph_123');
      events.push('offer');
      return { data: { passengers: offerPassengers } };
    });
    const cacheCheck = jest.fn().mockResolvedValue({ allowed: true, storeError: false });
    let requestBody: unknown;
    let requestInit: RequestInit | undefined;
    jest.spyOn(global, 'fetch').mockImplementation(async (_input, init) => {
      events.push('post');
      requestInit = init;
      requestBody = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
      return new Response(
        JSON.stringify({
          data: { id: 'ord_graph_123', booking_reference: 'GRAPH1', passengers: [] },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const moduleRef = await Test.createTestingModule({ imports: [SupplierOrderModule] })
      .overrideProvider(DUFFEL_SDK)
      .useValue({ offers: { get: getOffer } })
      .overrideProvider(DUFFEL_SDK_CONFIGURATION)
      .useValue({ token: 'test-token', basePath: 'http://127.0.0.1:4010' })
      .overrideProvider(CacheService)
      .useValue({ checkAndIncrement: cacheCheck })
      .compile();

    try {
      const gateway = moduleRef.get<FulfillmentGatewayPort>(FULFILLMENT_GATEWAY_PORT);
      expect(gateway).toBe(moduleRef.get(DuffelFulfillmentAdapter));
      expect(moduleRef.get(DuffelCancellationService)).toBeDefined();
      expect(moduleRef.get(DuffelRecoveryService)).toBeDefined();

      const firstAdult = {
        type: 'adult',
        given_name: 'Ada',
        family_name: 'Lovelace',
        born_on: '1990-11-27T00:00:00Z',
        gender: 'Female',
        title: ' MS ',
        phone_number: '+12025550199',
        email: 'ada@example.com',
        identity_documents: [
          {
            type: 'passport',
            unique_identifier: 'P123456',
            expires_on: '2030-01-01',
            issuing_country_code: 'US',
          },
        ],
      };
      const input: CreateOrderInput = {
        offerId: 'off_graph_123',
        passengers: [
          firstAdult,
          {
            type: 'adult',
            givenName: 'Grace',
            familyName: 'Hopper',
            dateOfBirth: '1980-04-15',
            gender: 'M',
            phoneNumber: '+12025550100',
            email: 'grace@example.com',
          },
          {
            type: 'child',
            givenName: 'Alan',
            familyName: 'Turing',
            dateOfBirth: '2015-06-23',
            gender: 'male',
            phoneNumber: '+12025550101',
            email: 'alan@example.com',
          },
          {
            type: 'infant_without_seat',
            givenName: 'Katherine',
            familyName: 'Johnson',
            dateOfBirth: '2025-01-12',
            gender: 'female',
            phoneNumber: '+12025550102',
            email: 'katherine@example.com',
          },
        ],
        services: [{ serviceId: 'srv_bag_123', quantity: 2 }],
        metadata: { bookingIntentId: 'intent_graph', paymentId: 'pay_graph' },
        idempotencyKey: 'idem_graph',
      };

      await gateway.createOrder(input, {
        beforeInvoke: async () => {
          events.push('beforeInvoke');
        },
      });

      expect(events).toEqual(['beforeInvoke', 'offer', 'post']);
      expect(cacheCheck).toHaveBeenCalledTimes(2);
      expect(getOffer).toHaveBeenCalledTimes(1);
      expect(requestInit?.method).toBe('POST');
      expect(requestInit?.headers).toMatchObject({
        'Idempotency-Key': 'idem_graph-duffel-order',
      });
      expect(requestBody).toEqual({
        data: {
          type: 'instant',
          selected_offers: ['off_graph_123'],
          passengers: [
            {
              id: 'pas_adult_1',
              given_name: 'Ada',
              family_name: 'Lovelace',
              born_on: '1990-11-27',
              gender: 'f',
              title: 'ms',
              phone_number: '+12025550199',
              email: 'ada@example.com',
              identity_documents: firstAdult.identity_documents,
            },
            {
              id: 'pas_adult_2',
              given_name: 'Grace',
              family_name: 'Hopper',
              born_on: '1980-04-15',
              gender: 'm',
              title: 'mr',
              phone_number: '+12025550100',
              email: 'grace@example.com',
            },
            {
              id: 'pas_child_1',
              given_name: 'Alan',
              family_name: 'Turing',
              born_on: '2015-06-23',
              gender: 'm',
              title: 'mr',
              phone_number: '+12025550101',
              email: 'alan@example.com',
            },
            {
              id: 'pas_infant_1',
              given_name: 'Katherine',
              family_name: 'Johnson',
              born_on: '2025-01-12',
              gender: 'f',
              title: 'ms',
              phone_number: '+12025550102',
              email: 'katherine@example.com',
            },
          ],
          services: [{ id: 'srv_bag_123', quantity: 2 }],
          metadata: { bookingIntentId: 'intent_graph', paymentId: 'pay_graph' },
        },
      });
    } finally {
      await moduleRef.close();
    }
  });

  it('rejects an invalid traveler before the real provider order POST', async () => {
    const getOffer = jest.fn(async () => ({
      data: { passengers: [{ id: 'pas_adult_1', type: 'adult' }] },
    }));
    const cacheCheck = jest.fn().mockResolvedValue({ allowed: true, storeError: false });
    const post = jest.spyOn(global, 'fetch').mockImplementation(async () =>
      new Response(
        JSON.stringify({ data: { id: 'ord_invalid_graph', booking_reference: 'INVALID' } }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const moduleRef = await Test.createTestingModule({ imports: [SupplierOrderModule] })
      .overrideProvider(DUFFEL_SDK)
      .useValue({ offers: { get: getOffer } })
      .overrideProvider(DUFFEL_SDK_CONFIGURATION)
      .useValue({ token: 'test-token', basePath: 'http://127.0.0.1:4010' })
      .overrideProvider(CacheService)
      .useValue({ checkAndIncrement: cacheCheck })
      .compile();

    try {
      const gateway = moduleRef.get<FulfillmentGatewayPort>(FULFILLMENT_GATEWAY_PORT);
      const invalidInput: CreateOrderInput = {
        offerId: 'off_invalid_graph',
        passengers: [
          {
            type: 'adult',
            givenName: 'Ada',
            familyName: 'Lovelace',
            dateOfBirth: '1990-11-27',
            phoneNumber: '+12025550199',
          },
        ],
        metadata: { bookingIntentId: 'intent_invalid', paymentId: 'pay_invalid' },
        idempotencyKey: 'idem_invalid',
      };
      const beforeInvoke = jest.fn();

      await expect(
        gateway.createOrder(invalidInput, { beforeInvoke }),
      ).rejects.toThrow('Email address is required for passenger Ada Lovelace');

      expect(beforeInvoke).toHaveBeenCalledTimes(1);
      expect(getOffer).toHaveBeenCalledWith('off_invalid_graph');
      expect(cacheCheck).toHaveBeenCalledTimes(1);
      expect(post).not.toHaveBeenCalled();
    } finally {
      await moduleRef.close();
    }
  });
});
