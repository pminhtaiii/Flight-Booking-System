const mockGetOrder = jest.fn();
const mockConfirmCancellation = jest.fn();
const mockOffersGet = jest.fn();
const mockOfferRequestsCreate = jest.fn();

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
    offerRequests: {
      create: mockOfferRequestsCreate,
    },
  })),
}));

import { CacheService } from '@/cache/cache.service';
import { HttpStatus } from '@nestjs/common';
import { Duffel } from '@duffel/api';
import * as crypto from 'crypto';
import { DuffelService, DuffelTimeoutError } from './duffel.service';
import { DuffelOfferRequest } from './duffel.types';

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
              },
            ],
          },
        ],
        passengers: [
          {
            id: 'pas_123',
            type: 'adult',
            title: 'Mr',
            given_name: 'John',
            family_name: 'Doe',
            born_on: '1990-01-01',
            email: 'john@example.com',
            phone_number: '+12345678',
          },
        ],
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
              },
            ],
          },
        ],
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

  describe('searchFlights characterization (T001)', () => {
    type MockCacheService = {
      get: jest.Mock<Promise<string | null>, [key: string]>;
      set: jest.Mock<Promise<void>, [key: string, value: string, ttlSeconds?: number]>;
      incr: jest.Mock<Promise<number>, [key: string, ttlSeconds?: number]>;
      decr: jest.Mock<Promise<number>, [key: string]>;
      getTtl: jest.Mock<Promise<number>, [key: string]>;
      del: jest.Mock<Promise<void>, [key: string]>;
    };

    let searchService: DuffelService;
    let mockCache: MockCacheService;

    const createMockOfferRequest = (id = 'or_test_123'): DuffelOfferRequest => ({
      id,
      slices: [
        {
          id: 'sli_1',
          duration: 'PT2H10M',
          origin: { id: 'HAN', name: 'Noi Bai Airport', iata_code: 'HAN', type: 'airport' },
          destination: { id: 'SGN', name: 'Tan Son Nhat Airport', iata_code: 'SGN', type: 'airport' },
          segments: [
            {
              id: 'seg_1',
              duration: 'PT2H10M',
              departing_at: '2026-10-01T08:00:00',
              arriving_at: '2026-10-01T10:10:00',
              origin: { id: 'HAN', name: 'Noi Bai Airport', iata_code: 'HAN', type: 'airport' },
              destination: { id: 'SGN', name: 'Tan Son Nhat Airport', iata_code: 'SGN', type: 'airport' },
              marketing_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
              operating_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
              marketing_carrier_flight_number: '123',
              aircraft: { id: 'arc_1', name: 'Airbus A321', iata_code: '321' },
              passengers: [
                {
                  passenger_id: 'pas_1',
                  cabin_class: 'economy',
                  baggages: [{ type: 'checked', quantity: 1 }],
                },
              ],
            },
          ],
        },
      ],
      passengers: [{ id: 'pas_1', type: 'adult' }],
      offers: [
        {
          id: 'off_test_123',
          total_amount: '125.50',
          total_currency: 'USD',
          slices: [],
          passengers: [{ id: 'pas_1', type: 'adult' }],
          passenger_identity_documents_required: false,
        },
      ],
    });

    const getSearchHash = (query: {
      origin: string;
      destination: string;
      departureDate: string;
      returnDate?: string;
      adults: number;
      children?: number;
      infants?: number;
      cabinClass?: string;
    }): string => {
      const normalizedQuery = {
        origin: query.origin.trim().toUpperCase(),
        destination: query.destination.trim().toUpperCase(),
        departureDate: query.departureDate,
        returnDate: query.returnDate || null,
        adults: Number(query.adults),
        children: Number(query.children || 0),
        infants: Number(query.infants || 0),
        cabinClass: query.cabinClass || 'economy',
      };
      return crypto.createHash('sha256').update(JSON.stringify(normalizedQuery)).digest('hex');
    };

    beforeEach(() => {
      mockOfferRequestsCreate.mockReset();
      mockCache = {
        get: jest.fn<Promise<string | null>, [string]>().mockResolvedValue(null),
        set: jest.fn<Promise<void>, [string, string, number?]>().mockResolvedValue(undefined),
        incr: jest.fn<Promise<number>, [string, number?]>().mockResolvedValue(1),
        decr: jest.fn<Promise<number>, [string]>().mockResolvedValue(0),
        getTtl: jest.fn<Promise<number>, [string]>().mockResolvedValue(-1),
        del: jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined),
      };
      searchService = new DuffelService(mockCache as unknown as CacheService);
    });

    it('executes raw search for user caller on cache miss, reserving budget and caching result with 900s TTL', async () => {
      const query = {
        origin: 'HAN',
        destination: 'SGN',
        departureDate: '2026-10-01',
        adults: 1,
        children: 0,
        infants: 0,
        cabinClass: 'economy',
      };
      const expectedHash = getSearchHash(query);
      const mockOfferRequest = createMockOfferRequest('or_user_raw');
      mockOfferRequestsCreate.mockResolvedValue({ data: mockOfferRequest });

      const result = await searchService.searchFlights(query, 'user');

      expect(result.cached).toBe(false);
      expect(result.searchHash).toBe(expectedHash);
      expect(result.offerRequest).toEqual(mockOfferRequest);

      expect(mockCache.get).toHaveBeenCalledWith(`flights:raw:${expectedHash}`);
      expect(mockCache.get).toHaveBeenCalledWith(expect.stringMatching(/^budget:duffel:\d{4}-\d{2}$/));
      expect(mockCache.incr).toHaveBeenCalledWith(
        expect.stringMatching(/^budget:duffel:\d{4}-\d{2}$/),
        expect.any(Number),
      );
      expect(mockOfferRequestsCreate).toHaveBeenCalledTimes(1);
      expect(mockOfferRequestsCreate).toHaveBeenCalledWith({
        slices: [
          {
            origin: 'HAN',
            destination: 'SGN',
            departure_date: '2026-10-01',
            arrival_time: null,
            departure_time: null,
          },
        ],
        passengers: [{ type: 'adult' }],
        cabin_class: 'economy',
      });
      expect(mockCache.set).toHaveBeenCalledWith(
        `flights:raw:${expectedHash}`,
        JSON.stringify(mockOfferRequest),
        900,
      );
    });

    it('executes raw search for agent caller on cache miss with round-trip and multi-passenger mapping', async () => {
      const query = {
        origin: 'SGN',
        destination: 'HAN',
        departureDate: '2026-10-05',
        returnDate: '2026-10-12',
        adults: 2,
        children: 1,
        infants: 1,
        cabinClass: 'business',
      };
      const expectedHash = getSearchHash(query);
      const mockOfferRequest = createMockOfferRequest('or_agent_raw');
      mockOfferRequestsCreate.mockResolvedValue({ data: mockOfferRequest });

      const result = await searchService.searchFlights(query, 'agent');

      expect(result.cached).toBe(false);
      expect(result.searchHash).toBe(expectedHash);
      expect(mockOfferRequestsCreate).toHaveBeenCalledWith({
        slices: [
          {
            origin: 'SGN',
            destination: 'HAN',
            departure_date: '2026-10-05',
            arrival_time: null,
            departure_time: null,
          },
          {
            origin: 'HAN',
            destination: 'SGN',
            departure_date: '2026-10-12',
            arrival_time: null,
            departure_time: null,
          },
        ],
        passengers: [
          { type: 'adult' },
          { type: 'adult' },
          { type: 'child' },
          { type: 'infant_without_seat' },
        ],
        cabin_class: 'business',
      });
    });

    it('returns cached search result for user caller with 0 upstream Duffel calls and 0 budget increments', async () => {
      const query = {
        origin: 'HAN',
        destination: 'SGN',
        departureDate: '2026-10-01',
        adults: 1,
      };
      const expectedHash = getSearchHash(query);
      const cachedOfferRequest = createMockOfferRequest('or_cached_user');

      mockCache.get.mockImplementation(async (key: string) => {
        if (key === `flights:raw:${expectedHash}`) {
          return JSON.stringify(cachedOfferRequest);
        }
        return null;
      });

      const result = await searchService.searchFlights(query, 'user');

      expect(result.cached).toBe(true);
      expect(result.searchHash).toBe(expectedHash);
      expect(result.offerRequest).toEqual(cachedOfferRequest);
      expect(mockOfferRequestsCreate).not.toHaveBeenCalled();
      expect(mockCache.incr).not.toHaveBeenCalled();
    });

    it('returns cached search result for agent caller with 0 upstream Duffel calls and 0 budget increments', async () => {
      const query = {
        origin: 'SGN',
        destination: 'HAN',
        departureDate: '2026-10-05',
        returnDate: '2026-10-12',
        adults: 2,
      };
      const expectedHash = getSearchHash(query);
      const cachedOfferRequest = createMockOfferRequest('or_cached_agent');

      mockCache.get.mockImplementation(async (key: string) => {
        if (key === `flights:raw:${expectedHash}`) {
          return JSON.stringify(cachedOfferRequest);
        }
        return null;
      });

      const result = await searchService.searchFlights(query, 'agent');

      expect(result.cached).toBe(true);
      expect(result.searchHash).toBe(expectedHash);
      expect(result.offerRequest).toEqual(cachedOfferRequest);
      expect(mockOfferRequestsCreate).not.toHaveBeenCalled();
      expect(mockCache.incr).not.toHaveBeenCalled();
    });

    it('enforces caller budget limit for user caller (1800) and throws RATE_LIMIT_EXCEEDED 429 without calling Duffel', async () => {
      const query = {
        origin: 'HAN',
        destination: 'SGN',
        departureDate: '2026-10-01',
        adults: 1,
      };

      mockCache.get.mockImplementation(async (key: string) => {
        if (key.startsWith('budget:duffel:')) {
          return '1800';
        }
        return null;
      });

      await expect(searchService.searchFlights(query, 'user')).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
        response: {
          code: 'RATE_LIMIT_EXCEEDED',
        },
      });

      expect(mockOfferRequestsCreate).not.toHaveBeenCalled();
      expect(mockCache.incr).not.toHaveBeenCalled();
    });

    it('enforces caller budget limit for agent caller (1200) while permitting user search below user limit (1800)', async () => {
      const agentQuery = {
        origin: 'SGN',
        destination: 'HAN',
        departureDate: '2026-10-05',
        adults: 1,
      };
      const userQuery = {
        origin: 'HAN',
        destination: 'SGN',
        departureDate: '2026-10-01',
        adults: 1,
      };

      mockCache.get.mockImplementation(async (key: string) => {
        if (key.startsWith('budget:duffel:')) {
          return '1200';
        }
        return null;
      });

      await expect(searchService.searchFlights(agentQuery, 'agent')).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
        response: {
          code: 'RATE_LIMIT_EXCEEDED',
        },
      });
      expect(mockOfferRequestsCreate).not.toHaveBeenCalled();

      const mockOfferRequest = createMockOfferRequest('or_user_below_limit');
      mockOfferRequestsCreate.mockResolvedValueOnce({ data: mockOfferRequest });

      const userResult = await searchService.searchFlights(userQuery, 'user');
      expect(userResult.cached).toBe(false);
      expect(mockOfferRequestsCreate).toHaveBeenCalledTimes(1);
    });

    it('enforces total budget limit (2000) and throws RATE_LIMIT_EXCEEDED 429 for all callers', async () => {
      const query = {
        origin: 'HAN',
        destination: 'SGN',
        departureDate: '2026-10-01',
        adults: 1,
      };

      mockCache.get.mockImplementation(async (key: string) => {
        if (key.startsWith('budget:duffel:')) {
          return '2000';
        }
        return null;
      });

      await expect(searchService.searchFlights(query, 'user')).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
        response: {
          code: 'RATE_LIMIT_EXCEEDED',
        },
      });

      await expect(searchService.searchFlights(query, 'agent')).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
        response: {
          code: 'RATE_LIMIT_EXCEEDED',
        },
      });

      expect(mockOfferRequestsCreate).not.toHaveBeenCalled();
    });

    it('permits raw search when increment reaches exactly the caller limit (boundary test)', async () => {
      const query = {
        origin: 'HAN',
        destination: 'SGN',
        departureDate: '2026-10-01',
        adults: 1,
      };

      mockCache.get.mockImplementation(async (key: string) => {
        if (key.startsWith('budget:duffel:')) {
          return '1799';
        }
        return null;
      });
      mockCache.incr.mockResolvedValueOnce(1800);

      const mockOfferRequest = createMockOfferRequest('or_exact_limit');
      mockOfferRequestsCreate.mockResolvedValueOnce({ data: mockOfferRequest });

      const result = await searchService.searchFlights(query, 'user');
      expect(result.cached).toBe(false);
      expect(mockOfferRequestsCreate).toHaveBeenCalledTimes(1);
      expect(mockCache.decr).not.toHaveBeenCalled();
    });

    it('compensates and decrements budget when concurrent check-and-increment overshoots caller limit', async () => {
      const query = {
        origin: 'HAN',
        destination: 'SGN',
        departureDate: '2026-10-01',
        adults: 1,
      };

      mockCache.get.mockImplementation(async (key: string) => {
        if (key.startsWith('budget:duffel:')) {
          return '1799';
        }
        return null;
      });
      mockCache.incr.mockResolvedValueOnce(1801);

      await expect(searchService.searchFlights(query, 'user')).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
        response: {
          code: 'RATE_LIMIT_EXCEEDED',
        },
      });

      expect(mockCache.decr).toHaveBeenCalledWith(expect.stringMatching(/^budget:duffel:\d{4}-\d{2}$/));
      expect(mockOfferRequestsCreate).not.toHaveBeenCalled();
    });

    it('compensates and decrements budget when concurrent check-and-increment overshoots total limit', async () => {
      const query = {
        origin: 'HAN',
        destination: 'SGN',
        departureDate: '2026-10-01',
        adults: 1,
      };

      // 1799 passes both user limit (1800) and total limit (2000) at pre-check
      mockCache.get.mockImplementation(async (key: string) => {
        if (key.startsWith('budget:duffel:')) {
          return '1799';
        }
        return null;
      });
      // Concurrent bursts cause incr to return 2001, exceeding total limit (2000)
      mockCache.incr.mockResolvedValueOnce(2001);

      await expect(searchService.searchFlights(query, 'user')).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
        response: {
          code: 'RATE_LIMIT_EXCEEDED',
        },
      });

      expect(mockCache.decr).toHaveBeenCalledWith(expect.stringMatching(/^budget:duffel:\d{4}-\d{2}$/));
      expect(mockOfferRequestsCreate).not.toHaveBeenCalled();
    });

    it('maps upstream failure to 502 UPSTREAM_UNAVAILABLE when Duffel API throws generic error', async () => {
      const query = {
        origin: 'HAN',
        destination: 'SGN',
        departureDate: '2026-10-01',
        adults: 1,
      };

      mockOfferRequestsCreate.mockRejectedValueOnce(new Error('Upstream connection reset'));

      await expect(searchService.searchFlights(query, 'user')).rejects.toMatchObject({
        status: HttpStatus.BAD_GATEWAY,
        response: {
          code: 'UPSTREAM_UNAVAILABLE',
        },
      });
    });
  });

  describe('getOfferById live offer detail characterization (T001)', () => {
    let detailService: DuffelService;

    beforeEach(() => {
      mockOffersGet.mockReset();
      detailService = new DuffelService({} as CacheService);
    });

    it('successfully retrieves live offer details by ID', async () => {
      const mockPayload = {
        id: 'off_detail_1',
        total_amount: '220.00',
        total_currency: 'USD',
      };
      mockOffersGet.mockResolvedValue({ data: mockPayload });

      const result = await detailService.getOfferById('off_detail_1');

      expect(result).toEqual(mockPayload);
      expect(mockOffersGet).toHaveBeenCalledWith('off_detail_1');
    });

    it('propagates upstream 404 error when offer is not found', async () => {
      const upstreamError = { status: 404, message: 'Offer not found' };
      mockOffersGet.mockRejectedValue(upstreamError);

      await expect(detailService.getOfferById('off_expired_404')).rejects.toEqual(upstreamError);
    });

    it('propagates upstream 410 error when offer has expired', async () => {
      const upstreamError = { status: 410, message: 'Offer gone' };
      mockOffersGet.mockRejectedValue(upstreamError);

      await expect(detailService.getOfferById('off_expired_410')).rejects.toEqual(upstreamError);
    });

    it('times out with DuffelTimeoutError when upstream call exceeds timeout limit', async () => {
      let timer: NodeJS.Timeout;
      mockOffersGet.mockImplementation(
        () =>
          new Promise((resolve) => {
            timer = setTimeout(resolve, 200);
          }),
      );

      try {
        await expect(detailService.getOfferById('off_slow', 15)).rejects.toThrow(DuffelTimeoutError);
      } finally {
        clearTimeout(timer!);
      }
    });
  });
});

