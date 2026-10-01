import { HttpException, HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Duffel } from '@duffel/api';
import { DUFFEL_SDK } from '@/supplier/core/duffel-core.module';
import {
  BudgetReservationResult,
  DuffelRateBudgetService,
} from '@/supplier/core/duffel-rate-budget.service';
import { DuffelAncillaryAdapter } from './duffel-ancillary.adapter';

type PricedOfferParams = {
  intended_payment_methods: Array<{ type: 'card'; card_id: string }>;
  intended_services: Array<{ id: string; quantity: number }>;
};

describe('DuffelAncillaryAdapter', () => {
  let adapter: DuffelAncillaryAdapter;
  let offersGet: jest.Mock<Promise<{ data: unknown }>, [string, { return_available_services: boolean }]>;
  let offersGetPriced: jest.Mock<Promise<{ data: unknown }>, [string, PricedOfferParams]>;
  let seatMapsGet: jest.Mock<Promise<{ data: unknown }>, [{ offer_id: string }]>;
  let reserveAttempt: jest.Mock<Promise<BudgetReservationResult>, []>;

  beforeEach(async () => {
    offersGet = jest.fn();
    offersGetPriced = jest.fn();
    seatMapsGet = jest.fn();
    reserveAttempt = jest.fn().mockResolvedValue({ ok: true });

    const sdk = {
      offers: { get: offersGet, getPriced: offersGetPriced },
      seatMaps: { get: seatMapsGet },
    } as unknown as Duffel;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DuffelAncillaryAdapter,
        { provide: DUFFEL_SDK, useValue: sdk },
        {
          provide: DuffelRateBudgetService,
          useValue: { reserveAttempt },
        },
      ],
    }).compile();

    adapter = module.get<DuffelAncillaryAdapter>(DuffelAncillaryAdapter);
  });

  it('resolves through Nest and returns the raw offer data with available services', async () => {
    const rawOffer = { id: 'off_123', available_services: [] };
    offersGet.mockResolvedValue({ data: rawOffer });

    const result = await adapter.getOfferWithServices('off_123');

    expect(result).toBe(rawOffer);
    expect(reserveAttempt).toHaveBeenCalledTimes(1);
    expect(offersGet).toHaveBeenCalledWith('off_123', { return_available_services: true });
  });

  it('returns raw seat-map data after reserving one attempt', async () => {
    const rawSeatMaps = [{ id: 'sm_123', segment_id: 'seg_123' }];
    seatMapsGet.mockResolvedValue({ data: rawSeatMaps });

    const result = await adapter.getSeatMaps('off_123');

    expect(result).toBe(rawSeatMaps);
    expect(reserveAttempt).toHaveBeenCalledTimes(1);
    expect(seatMapsGet).toHaveBeenCalledWith({ offer_id: 'off_123' });
  });

  it('returns raw priced-offer data and forwards every supplied service line', async () => {
    const rawPricedOffer = { id: 'off_123', total_amount: '510.00' };
    const services = [
      { id: 'ase_bag_1', quantity: 1 },
      { id: 'ase_bag_1', quantity: 2 },
    ];
    offersGetPriced.mockResolvedValue({ data: rawPricedOffer });

    const result = await adapter.getPricedOffer('off_123', services);

    expect(result).toBe(rawPricedOffer);
    expect(reserveAttempt).toHaveBeenCalledTimes(1);
    expect(offersGetPriced).toHaveBeenCalledWith('off_123', {
      intended_payment_methods: [{ type: 'card', card_id: 'mock_card' }],
      intended_services: services,
    });
  });

  it('fails closed with the exhausted budget response before calling the SDK', async () => {
    reserveAttempt.mockResolvedValue({
      ok: false,
      error: 'EXHAUSTED',
      retryAfterSeconds: 37,
      resetAt: '2026-10-02T00:00:00.000Z',
    });

    await expect(adapter.getOfferWithServices('off_123')).rejects.toMatchObject({
      status: 429,
      response: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Daily Duffel API rate limit exceeded',
        retryAfterSeconds: 37,
        resetAt: '2026-10-02T00:00:00.000Z',
      },
    });
    expect(offersGet).not.toHaveBeenCalled();
  });

  it('fails closed with the unavailable budget response before calling seat maps', async () => {
    reserveAttempt.mockResolvedValue({
      ok: false,
      error: 'UNAVAILABLE',
      retryAfterSeconds: 11,
    });

    await expect(adapter.getSeatMaps('off_123')).rejects.toMatchObject({
      status: 429,
      response: {
        code: 'BUDGET_UNAVAILABLE',
        message: 'Duffel rate budget store temporarily unavailable',
        retryAfterSeconds: 11,
      },
    });
    expect(seatMapsGet).not.toHaveBeenCalled();
  });

  it('fails closed with the exhausted budget response before calling repricing', async () => {
    reserveAttempt.mockResolvedValue({
      ok: false,
      error: 'EXHAUSTED',
      retryAfterSeconds: 23,
      resetAt: '2026-10-02T00:00:00.000Z',
    });

    await expect(adapter.getPricedOffer('off_123', [{ id: 'ase_bag_1', quantity: 1 }])).rejects.toMatchObject({
      status: 429,
      response: { code: 'RATE_LIMIT_EXCEEDED', retryAfterSeconds: 23 },
    });
    expect(offersGetPriced).not.toHaveBeenCalled();
  });

  it('keeps the reservation consumed when a supplier attempt fails', async () => {
    const failure = new Error('supplier failed');
    offersGet.mockRejectedValue(failure);

    await expect(adapter.getOfferWithServices('off_123')).rejects.toBe(failure);
    expect(reserveAttempt).toHaveBeenCalledTimes(1);
  });

  it('preserves an empty seat-map response as raw data', async () => {
    const rawSeatMaps: unknown[] = [];
    seatMapsGet.mockResolvedValue({ data: rawSeatMaps });

    const result = await adapter.getSeatMaps('off_123');

    expect(result).toBe(rawSeatMaps);
  });

  it.each([
    ['status', { status: 404, message: 'Seat map not found' }],
    ['statusCode', { statusCode: 404, message: 'Seat map not found' }],
    ['HttpException', new HttpException('Seat map not found', HttpStatus.NOT_FOUND)],
    [
      'Duffel meta.status',
      Object.assign(new Error('Seat map not found'), {
        meta: { status: 404, request_id: 'req_test' },
        errors: [{ title: 'not_found', detail: 'Seat map not found' }],
      }),
    ],
  ])('returns an empty raw map for a supplier %s 404', async (_shape, error) => {
    seatMapsGet.mockRejectedValue(error);

    await expect(adapter.getSeatMaps('off_123')).resolves.toEqual([]);
    expect(reserveAttempt).toHaveBeenCalledTimes(1);
  });

  it('propagates a non-404 SDK-shaped error without swallowing it', async () => {
    const failure = Object.assign(new Error('Seat map service failed'), {
      meta: { status: 503, request_id: 'req_test' },
      errors: [{ title: 'upstream_failure', detail: 'Seat map service failed' }],
    });
    seatMapsGet.mockRejectedValue(failure);

    await expect(adapter.getSeatMaps('off_123')).rejects.toBe(failure);
  });

  it('returns the raw deterministic seat-map fixture in non-Jest mock mode without charging budget', async () => {
    const previousJestWorkerId = process.env.JEST_WORKER_ID;
    const previousNodeEnv = process.env.NODE_ENV;
    const previousDuffelToken = process.env.DUFFEL_ACCESS_TOKEN;
    try {
      delete process.env.JEST_WORKER_ID;
      process.env.NODE_ENV = 'test';
      process.env.DUFFEL_ACCESS_TOKEN = 'mock';

      const result = await adapter.getSeatMaps('off_mock_123');

      expect(result).toMatchObject([
        {
          segment_id: 'seg_mock_1',
          cabins: [
            {
              rows: [
                {
                  sections: [
                    {
                      elements: expect.arrayContaining([
                        expect.objectContaining({
                          designator: '1A',
                          available_services: [
                            expect.objectContaining({
                              id: 'ase_mock_seat_1',
                              passenger_id: 'pas_mock_1',
                              total_amount: '15.00',
                              total_currency: 'USD',
                            }),
                          ],
                        }),
                      ]),
                    },
                  ],
                },
              ],
            },
          ],
        },
      ]);
      expect(seatMapsGet).not.toHaveBeenCalled();
      expect(reserveAttempt).not.toHaveBeenCalled();
    } finally {
      if (previousJestWorkerId === undefined) delete process.env.JEST_WORKER_ID;
      else process.env.JEST_WORKER_ID = previousJestWorkerId;
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousDuffelToken === undefined) delete process.env.DUFFEL_ACCESS_TOKEN;
      else process.env.DUFFEL_ACCESS_TOKEN = previousDuffelToken;
    }
  });

  it('returns the raw deterministic offer fixture with baggage in non-Jest mock mode', async () => {
    const previousJestWorkerId = process.env.JEST_WORKER_ID;
    const previousNodeEnv = process.env.NODE_ENV;
    const previousDuffelToken = process.env.DUFFEL_ACCESS_TOKEN;
    try {
      delete process.env.JEST_WORKER_ID;
      process.env.NODE_ENV = 'test';
      process.env.DUFFEL_ACCESS_TOKEN = 'mock';

      const result = await adapter.getOfferWithServices('off_mock_123');

      expect(result).toMatchObject({
        id: 'off_mock_123',
        slices: [
          {
            segments: [
              {
                id: 'seg_mock_1',
                origin: { iata_code: 'SGN' },
                destination: { iata_code: 'SIN' },
              },
            ],
          },
        ],
        available_services: [
          {
            id: 'ase_mock_bag_1',
            type: 'baggage',
            passenger_ids: ['pas_mock_1'],
            segment_ids: ['seg_mock_1'],
            total_amount: '30.00',
            total_currency: 'USD',
            metadata: {
              type: 'checked',
              weight: 23,
              weight_unit: 'kg',
              maximum_quantity: 2,
            },
          },
        ],
      });
      expect(offersGet).not.toHaveBeenCalled();
      expect(reserveAttempt).not.toHaveBeenCalled();
    } finally {
      if (previousJestWorkerId === undefined) delete process.env.JEST_WORKER_ID;
      else process.env.JEST_WORKER_ID = previousJestWorkerId;
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousDuffelToken === undefined) delete process.env.DUFFEL_ACCESS_TOKEN;
      else process.env.DUFFEL_ACCESS_TOKEN = previousDuffelToken;
    }
  });

  it('returns raw priced-offer fixture values in non-Jest mock mode without charging budget', async () => {
    const previousJestWorkerId = process.env.JEST_WORKER_ID;
    const previousNodeEnv = process.env.NODE_ENV;
    const previousDuffelToken = process.env.DUFFEL_ACCESS_TOKEN;
    try {
      delete process.env.JEST_WORKER_ID;
      process.env.NODE_ENV = 'test';
      process.env.DUFFEL_ACCESS_TOKEN = 'mock';

      const result = await adapter.getPricedOffer('off_mock_123', [
        { id: 'ase_mock_bag_1', quantity: 2 },
        { id: 'ase_mock_other_1', quantity: 1 },
      ]);

      expect(result).toEqual({
        id: 'off_mock_123',
        total_amount: '508.00',
        total_currency: 'USD',
        base_amount: '420.00',
        base_currency: 'USD',
        service_lines: [
          { service_id: 'ase_mock_bag_1', total_amount: '35.00', quantity: 2 },
          { service_id: 'ase_mock_other_1', total_amount: '18.00', quantity: 1 },
        ],
      });
      expect(offersGetPriced).not.toHaveBeenCalled();
      expect(reserveAttempt).not.toHaveBeenCalled();
    } finally {
      if (previousJestWorkerId === undefined) delete process.env.JEST_WORKER_ID;
      else process.env.JEST_WORKER_ID = previousJestWorkerId;
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousDuffelToken === undefined) delete process.env.DUFFEL_ACCESS_TOKEN;
      else process.env.DUFFEL_ACCESS_TOKEN = previousDuffelToken;
    }
  });

  it('keeps invalid mock service identities in an upstream-shaped 400 error', async () => {
    const previousJestWorkerId = process.env.JEST_WORKER_ID;
    const previousNodeEnv = process.env.NODE_ENV;
    const previousDuffelToken = process.env.DUFFEL_ACCESS_TOKEN;
    try {
      delete process.env.JEST_WORKER_ID;
      process.env.NODE_ENV = 'test';
      process.env.DUFFEL_ACCESS_TOKEN = 'mock';

      await expect(
        adapter.getPricedOffer('off_mock_123', [
          { id: 'ase_invalid_seat', quantity: 1 },
          { id: 'ase_mock_bag_1', quantity: 1 },
        ]),
      ).rejects.toMatchObject({
        meta: { status: 400, request_id: 'req_mock_priced' },
        errors: [expect.objectContaining({ detail: expect.stringContaining('ase_invalid_seat') })],
      });
      expect(offersGetPriced).not.toHaveBeenCalled();
      expect(reserveAttempt).not.toHaveBeenCalled();
    } finally {
      if (previousJestWorkerId === undefined) delete process.env.JEST_WORKER_ID;
      else process.env.JEST_WORKER_ID = previousJestWorkerId;
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousDuffelToken === undefined) delete process.env.DUFFEL_ACCESS_TOKEN;
      else process.env.DUFFEL_ACCESS_TOKEN = previousDuffelToken;
    }
  });
});
