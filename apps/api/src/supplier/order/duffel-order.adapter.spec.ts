import { CacheService } from '@/cache/cache.service';
import { DuffelService } from '@/duffel/duffel.service';
import { DuffelRateBudgetService } from '@/supplier/core/duffel-rate-budget.service';
import type { BudgetReservationResult } from '@/supplier/core/duffel-rate-budget.service';
import { DUFFEL_SDK } from '@/supplier/core/duffel-core.module';
import { Test, TestingModule } from '@nestjs/testing';

describe('Duffel order request parity', () => {
  let moduleRef: TestingModule | undefined;
  let previousApiUrl: string | undefined;
  let previousAccessToken: string | undefined;

  beforeEach(() => {
    previousApiUrl = process.env.DUFFEL_API_URL;
    previousAccessToken = process.env.DUFFEL_ACCESS_TOKEN;
    process.env.DUFFEL_API_URL = 'http://127.0.0.1:4010';
    process.env.DUFFEL_ACCESS_TOKEN = 'duffel-test-token';
  });

  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = undefined;
    jest.restoreAllMocks();
    if (previousApiUrl === undefined) {
      delete process.env.DUFFEL_API_URL;
    } else {
      process.env.DUFFEL_API_URL = previousApiUrl;
    }
    if (previousAccessToken === undefined) {
      delete process.env.DUFFEL_ACCESS_TOKEN;
    } else {
      process.env.DUFFEL_ACCESS_TOKEN = previousAccessToken;
    }
  });

  it('posts a manual order with mapped passengers, services, metadata, and idempotency', async () => {
    const reserveAttempt = jest
      .fn<Promise<BudgetReservationResult>, [extraConstraint?: { key: string; limit: number }]>()
      .mockResolvedValue({ ok: true });
    const getOffer = jest.fn<
      Promise<{ data: { passengers: Array<{ id: string; type: string }> } }>,
      [offerId: string]
    >().mockResolvedValue({
      data: { passengers: [{ id: 'pas_adult_1', type: 'adult' }] },
    });
    const order = { id: 'ord_1', booking_reference: 'ABC123' };
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: order }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );

    moduleRef = await Test.createTestingModule({
      providers: [
        DuffelService,
        { provide: CacheService, useValue: {} },
        { provide: DuffelRateBudgetService, useValue: { reserveAttempt } },
        { provide: DUFFEL_SDK, useValue: { offers: { get: getOffer } } },
      ],
    }).compile();

    const service = moduleRef.get(DuffelService);
    await expect(
      service.createOrder(
        'off_1',
        [
          {
            type: 'adult',
            gender: 'female',
            givenName: 'Amina',
            familyName: 'Nguyen',
            dateOfBirth: '1990-01-02T00:00:00Z',
            phoneNumber: '+84901234567',
            email: 'amina@example.com',
          },
        ],
        [{ id: 'aseat_1', quantity: 1 }],
        { paymentId: 'pay_1' },
        'attempt-1',
      ),
    ).resolves.toEqual(order);

    expect(getOffer).toHaveBeenCalledWith('off_1');
    expect(reserveAttempt).toHaveBeenCalledTimes(2);

    const request = fetchSpy.mock.calls[0];
    if (request === undefined) {
      throw new Error('Expected Duffel order POST request');
    }
    const [url, requestOptions] = request;
    expect(url).toBe('http://127.0.0.1:4010/air/orders');
    expect(requestOptions?.method).toBe('POST');
    const headers = new Headers(requestOptions?.headers);
    expect(headers.get('Authorization')).toBe('Bearer duffel-test-token');
    expect(headers.get('Duffel-Version')).toBe('v2');
    expect(headers.get('Idempotency-Key')).toBe('attempt-1-duffel-order');

    const requestBodyText = requestOptions?.body;
    if (typeof requestBodyText !== 'string') {
      throw new Error('Expected serialized Duffel order body');
    }
    const requestBody: unknown = JSON.parse(requestBodyText);
    expect(requestBody).toEqual({
      data: {
        type: 'instant',
        selected_offers: ['off_1'],
        passengers: [
          {
            id: 'pas_adult_1',
            given_name: 'Amina',
            family_name: 'Nguyen',
            born_on: '1990-01-02',
            gender: 'f',
            title: 'ms',
            phone_number: '+84901234567',
            email: 'amina@example.com',
          },
        ],
        services: [{ id: 'aseat_1', quantity: 1 }],
        metadata: { paymentId: 'pay_1' },
      },
    });
  });
});
