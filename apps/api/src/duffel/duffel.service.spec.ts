const mockGetOrder = jest.fn();
const mockConfirmCancellation = jest.fn();
const mockOffersGet = jest.fn();

jest.mock('@duffel/api', () => ({
  Duffel: jest.fn().mockImplementation(() => ({
    orders: {
      get: mockGetOrder,
    },
    orderCancellations: {
      confirm: mockConfirmCancellation,
    },
    offers: {
      get: mockOffersGet,
    },
  })),
}));

import { CacheService } from '@/cache/cache.service';
import { HttpStatus } from '@nestjs/common';
import { Duffel } from '@duffel/api';
import { DuffelService } from './duffel.service';

describe('DuffelService cancellation recovery adapter', () => {
  let service: DuffelService;

  beforeEach(() => {
    mockGetOrder.mockReset();
    mockConfirmCancellation.mockReset();
    service = new DuffelService({} as CacheService);
  });

  it('retrieves an order and normalizes a remotely confirmed cancellation', async () => {
    mockGetOrder.mockResolvedValue({
      data: {
        id: 'ord_123',
        cancelled_at: '2026-07-22T10:00:00.000Z',
        cancellation: { id: 'oc_123', confirmed_at: '2026-07-22T10:00:00.000Z' },
      },
    });

    await expect(service.retrieveOrder('ord_123')).resolves.toEqual({
      id: 'ord_123',
      order_id: 'ord_123',
      status: 'CANCELLED',
      cancelled_at: '2026-07-22T10:00:00.000Z',
      cancellation_id: 'oc_123',
    });
    expect(mockGetOrder).toHaveBeenCalledWith('ord_123');
  });

  it('normalizes an uncancelled order as active when Duffel omits cancelled_at', async () => {
    mockGetOrder.mockResolvedValue({
      data: {
        id: 'ord_active',
        cancellation: null,
      },
    });

    await expect(service.retrieveOrder('ord_active')).resolves.toMatchObject({
      id: 'ord_active',
      status: 'ACTIVE',
      cancelled_at: null,
      cancellation_id: null,
    });
  });

  it('confirms the supplied cancellation quote without creating another quote', async () => {
    mockConfirmCancellation.mockResolvedValue({
      data: {
        id: 'oc_123',
        order_id: 'ord_123',
        confirmed_at: '2026-07-22T10:00:00.000Z',
        refund_amount: '75.00',
        refund_currency: 'GBP',
      },
    });

    await expect(service.confirmCancellationQuote('oc_123')).resolves.toEqual({
      id: 'oc_123',
      order_id: 'ord_123',
      status: 'CONFIRMED',
      refund_amount: '75.00',
      refund_currency: 'GBP',
      refundable: true,
      confirmed_at: '2026-07-22T10:00:00.000Z',
    });
    expect(mockConfirmCancellation).toHaveBeenCalledWith('oc_123');
  });

  it('translates upstream order retrieval failures into a PII-safe gateway error', async () => {
    mockGetOrder.mockRejectedValue(new Error('Duffel unavailable'));

    await expect(service.retrieveOrder('ord_123')).rejects.toMatchObject({
      status: HttpStatus.BAD_GATEWAY,
      response: {
        code: 'UPSTREAM_ORDER_RETRIEVAL_FAILED',
      },
    });
  });

  describe('mapDuffelOrderToSnapshots', () => {
    it('correctly maps Duffel order and retains duffelSegmentId', () => {
      const mockDuffelOrder = {
        slices: [
          {
            duration: 'PT2H30M',
            segments: [
              {
                id: 'seg_new_id',
                marketing_carrier: { name: 'Test Airline', iata_code: 'TA' },
                marketing_carrier_flight_number: '123',
                origin: { name: 'Origin Airport', iata_code: 'ORG', city_name: 'Origin City' },
                destination: { name: 'Dest Airport', iata_code: 'DST', city_name: 'Dest City' },
                departing_at: '2026-08-20T10:00:00Z',
                arriving_at: '2026-08-20T12:30:00Z',
                duration: 'PT2H30M',
                aircraft: { name: 'Boeing 737' },
                passengers: [{ cabin_class: 'economy' }],
              }
            ]
          }
        ],
        passengers: [
          { id: 'pas_123', type: 'adult', title: 'Mr', given_name: 'John', family_name: 'Doe', born_on: '1990-01-01', email: 'john@example.com', phone_number: '+12345678' }
        ]
      };

      const result = service.mapDuffelOrderToSnapshots(mockDuffelOrder);
      expect(result.flightSnapshot.segments[0]).toMatchObject({
        duffelSegmentId: 'seg_new_id',
        sliceOrder: 0,
        segmentOrder: 0,
        globalOrder: 0,
      });
      expect(result.passengerSnapshot.contactEmail).toBe('john@example.com');
    });

    it('remains backward compatible with legacy Duffel order missing segment IDs and metadata', () => {
      const mockLegacyDuffelOrder = {
        slices: [
          {
            duration: 'PT2H30M',
            segments: [
              {
                marketing_carrier: { name: 'Test Airline', iata_code: 'TA' },
                marketing_carrier_flight_number: '123',
                origin: { name: 'Origin Airport', iata_code: 'ORG', city_name: 'Origin City' },
                destination: { name: 'Dest Airport', iata_code: 'DST', city_name: 'Dest City' },
                departing_at: '2026-08-20T10:00:00Z',
                arriving_at: '2026-08-20T12:30:00Z',
                duration: 'PT2H30M',
              }
            ]
          }
        ]
      };

      const result = service.mapDuffelOrderToSnapshots(mockLegacyDuffelOrder);
      expect(result.flightSnapshot.segments[0].duffelSegmentId).toBeUndefined();
      expect(result.flightSnapshot.segments[0].sliceOrder).toBe(0);
      expect(result.passengerSnapshot.passengers.length).toBe(0);
    });
  });

  describe('retrieveCompleteOrder', () => {
    it('retrieves the complete Duffel order and returns it with DuffelOrder type', async () => {
      const mockOrderPayload = {
        id: 'ord_complete_123',
        slices: [],
        passengers: [],
        cancelled_at: null,
      };
      mockGetOrder.mockResolvedValue({ data: mockOrderPayload });

      const result = await service.retrieveCompleteOrder('ord_complete_123');
      expect(result).toEqual(mockOrderPayload);
      expect(mockGetOrder).toHaveBeenCalledWith('ord_complete_123');
    });
  });

  describe('DUFFEL_API_URL override and initialization', () => {
    const originalEnv = process.env.DUFFEL_API_URL;
    const originalFetch = global.fetch;
    const mockFetch = jest.fn();

    beforeAll(() => {
      global.fetch = mockFetch;
    });

    afterAll(() => {
      global.fetch = originalFetch;
    });

    beforeEach(() => {
      (Duffel as unknown as jest.Mock).mockClear();
      mockFetch.mockReset();
      mockOffersGet.mockReset();
    });

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env.DUFFEL_API_URL = originalEnv;
      } else {
        delete process.env.DUFFEL_API_URL;
      }
    });

    it('initializes Duffel SDK with default basePath when DUFFEL_API_URL is undefined', () => {
      delete process.env.DUFFEL_API_URL;
      new DuffelService({} as CacheService);
      expect(Duffel).toHaveBeenCalledWith(
        expect.objectContaining({
          basePath: 'https://api.duffel.com',
        }),
      );
    });

    it('initializes Duffel SDK and creates order with valid loopback override', async () => {
      process.env.DUFFEL_API_URL = 'http://127.0.0.1:4010';
      const overrideService = new DuffelService({} as CacheService);

      expect(Duffel).toHaveBeenCalledWith(
        expect.objectContaining({
          basePath: 'http://127.0.0.1:4010',
        }),
      );

      mockOffersGet.mockResolvedValue({
        data: {
          passengers: [{ id: 'pas_1', type: 'adult' }],
        },
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: { id: 'ord_mock_123' } }),
      });

      const passengers = [
        {
          type: 'adult',
          givenName: 'John',
          familyName: 'Doe',
          born_on: '1990-01-01',
          email: 'john@example.com',
          phoneNumber: '+1234567890',
          dateOfBirth: '1990-01-01',
        },
      ];

      await overrideService.createOrder('off_123', passengers);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://127.0.0.1:4010/air/orders',
        expect.objectContaining({
          method: 'POST',
        }),
      );
    });

    it('normalizes trailing slashes for DUFFEL_API_URL', () => {
      process.env.DUFFEL_API_URL = 'http://127.0.0.1:4010/';
      new DuffelService({} as CacheService);

      expect(Duffel).toHaveBeenCalledWith(
        expect.objectContaining({
          basePath: 'http://127.0.0.1:4010',
        }),
      );
    });

    it('rejects invalid URL syntax during initialization', () => {
      process.env.DUFFEL_API_URL = 'not-a-valid-url';
      expect(() => new DuffelService({} as CacheService)).toThrow();
    });

    it('rejects unsupported protocols during initialization', () => {
      process.env.DUFFEL_API_URL = 'ftp://127.0.0.1:4010';
      expect(() => new DuffelService({} as CacheService)).toThrow();
    });
  });
});

