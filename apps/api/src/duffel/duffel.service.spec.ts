const mockGetOrder = jest.fn();
const mockConfirmCancellation = jest.fn();
const mockCreateCancellation = jest.fn();
const mockOffersGet = jest.fn();
const mockOffersGetPriced = jest.fn();
const mockOfferRequestsCreate = jest.fn();
const mockSeatMapsGet = jest.fn();

jest.mock('@duffel/api', () => ({
  Duffel: jest.fn().mockImplementation(() => ({
    orders: {
      get: mockGetOrder,
    },
    orderCancellations: {
      create: mockCreateCancellation,
      confirm: mockConfirmCancellation,
    },
    offers: {
      get: mockOffersGet,
      getPriced: mockOffersGetPriced,
    },
    offerRequests: {
      create: mockOfferRequestsCreate,
    },
    seatMaps: {
      get: mockSeatMapsGet,
    },
  })),
}));

import { CacheService } from '@/cache/cache.service';
import { HttpStatus } from '@nestjs/common';
import { Duffel } from '@duffel/api';
import * as crypto from 'crypto';
import { DuffelService, DuffelTimeoutError } from './duffel.service';
import { DuffelOfferRequest } from './duffel.types';
import {
  DuffelRateBudgetService,
  BudgetReservationResult,
} from '@/supplier/core/duffel-rate-budget.service';

type MockRateBudgetService = {
  reserveAttempt: jest.Mock<
    Promise<BudgetReservationResult>,
    [extraConstraint?: { key: string; limit: number }]
  >;
};

const createMockRateBudgetService = (): MockRateBudgetService => ({
  reserveAttempt: jest
    .fn<Promise<BudgetReservationResult>, [extraConstraint?: { key: string; limit: number }]>()
    .mockResolvedValue({ ok: true }),
});

const getUtcDateString = (): string => {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

describe('DuffelService cancellation recovery adapter', () => {
  let service: DuffelService;
  let mockRateBudget: MockRateBudgetService;

  beforeEach(() => {
    mockGetOrder.mockReset();
    mockConfirmCancellation.mockReset();
    mockRateBudget = createMockRateBudgetService();
    service = new DuffelService(
      {} as CacheService,
      mockRateBudget as unknown as DuffelRateBudgetService,
    );
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
    expect(mockRateBudget.reserveAttempt).toHaveBeenCalledTimes(1);
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
    expect(mockRateBudget.reserveAttempt).toHaveBeenCalledTimes(1);
  });

  it('rejects retrieveOrder with 429 RATE_LIMIT_EXCEEDED when rate budget is exhausted', async () => {
    mockRateBudget.reserveAttempt.mockResolvedValueOnce({
      ok: false,
      error: 'EXHAUSTED',
      retryAfterSeconds: 60,
      resetAt: '2026-09-30T00:00:00.000Z',
    });

    await expect(service.retrieveOrder('ord_123')).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
      response: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Daily Duffel API rate limit exceeded',
      },
    });
    expect(mockGetOrder).not.toHaveBeenCalled();
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
    expect(mockRateBudget.reserveAttempt).toHaveBeenCalledTimes(1);
    expect(mockConfirmCancellation).toHaveBeenCalledWith('oc_123');
  });

  it('rejects confirmCancellationQuote with 429 RATE_LIMIT_EXCEEDED when rate budget is exhausted', async () => {
    mockRateBudget.reserveAttempt.mockResolvedValueOnce({
      ok: false,
      error: 'EXHAUSTED',
      retryAfterSeconds: 60,
      resetAt: '2026-09-30T00:00:00.000Z',
    });

    await expect(service.confirmCancellationQuote('oc_123')).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
      response: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Daily Duffel API rate limit exceeded',
      },
    });
    expect(mockConfirmCancellation).not.toHaveBeenCalled();
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
      expect(mockRateBudget.reserveAttempt).toHaveBeenCalledTimes(1);
      expect(mockGetOrder).toHaveBeenCalledWith('ord_complete_123');
    });

    it('rejects retrieveCompleteOrder with 429 RATE_LIMIT_EXCEEDED when rate budget is exhausted', async () => {
      mockRateBudget.reserveAttempt.mockResolvedValueOnce({
        ok: false,
        error: 'EXHAUSTED',
        retryAfterSeconds: 60,
        resetAt: '2026-09-30T00:00:00.000Z',
      });

      await expect(service.retrieveCompleteOrder('ord_complete_123')).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
        response: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Daily Duffel API rate limit exceeded',
          retryAfterSeconds: 60,
          resetAt: '2026-09-30T00:00:00.000Z',
        },
      });
      expect(mockGetOrder).not.toHaveBeenCalled();
    });

    it('rejects retrieveCompleteOrder with 429 BUDGET_UNAVAILABLE when budget store is unavailable', async () => {
      mockRateBudget.reserveAttempt.mockResolvedValueOnce({
        ok: false,
        error: 'UNAVAILABLE',
        retryAfterSeconds: 30,
      });

      await expect(service.retrieveCompleteOrder('ord_complete_123')).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
        response: {
          code: 'BUDGET_UNAVAILABLE',
          message: 'Duffel rate budget store temporarily unavailable',
          retryAfterSeconds: 30,
        },
      });
      expect(mockGetOrder).not.toHaveBeenCalled();
    });
  });

  describe('cancelOrder', () => {
    beforeEach(() => {
      mockCreateCancellation.mockReset();
      mockConfirmCancellation.mockReset();
    });

    it('meters 2 reservations and cancels order successfully', async () => {
      mockCreateCancellation.mockResolvedValue({ data: { id: 'oc_quote_1' } });
      mockConfirmCancellation.mockResolvedValue({ data: { id: 'oc_quote_1', status: 'confirmed' } });

      const result = await service.cancelOrder('ord_to_cancel');
      expect(result).toEqual({ id: 'oc_quote_1', status: 'confirmed' });
      expect(mockRateBudget.reserveAttempt).toHaveBeenCalledTimes(2);
      expect(mockCreateCancellation).toHaveBeenCalledWith({ order_id: 'ord_to_cancel' });
      expect(mockConfirmCancellation).toHaveBeenCalledWith('oc_quote_1');
    });

    it('rejects cancelOrder if initial quote reservation is denied', async () => {
      mockRateBudget.reserveAttempt.mockResolvedValueOnce({
        ok: false,
        error: 'EXHAUSTED',
        retryAfterSeconds: 60,
        resetAt: '2026-09-30T00:00:00.000Z',
      });

      await expect(service.cancelOrder('ord_to_cancel')).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
        response: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Daily Duffel API rate limit exceeded',
        },
      });
      expect(mockCreateCancellation).not.toHaveBeenCalled();
      expect(mockConfirmCancellation).not.toHaveBeenCalled();
    });

    it('rejects cancelOrder if confirmation reservation is denied after quote created', async () => {
      mockCreateCancellation.mockResolvedValue({ data: { id: 'oc_quote_1' } });
      mockRateBudget.reserveAttempt
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({
          ok: false,
          error: 'EXHAUSTED',
          retryAfterSeconds: 60,
          resetAt: '2026-09-30T00:00:00.000Z',
        });

      await expect(service.cancelOrder('ord_to_cancel')).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
        response: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Daily Duffel API rate limit exceeded',
        },
      });
      expect(mockCreateCancellation).toHaveBeenCalledTimes(1);
      expect(mockConfirmCancellation).not.toHaveBeenCalled();
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
      new DuffelService(
        {} as CacheService,
        mockRateBudget as unknown as DuffelRateBudgetService,
      );
      expect(Duffel).toHaveBeenCalledWith(
        expect.objectContaining({
          basePath: 'https://api.duffel.com',
        }),
      );
    });

    it('uses injectedDuffel if provided in constructor', async () => {
      const customOrdersGet = jest.fn().mockResolvedValue({
        data: { id: 'ord_injected', cancelled_at: null, cancellation: null },
      });
      const customDuffel = {
        orders: { get: customOrdersGet },
      } as unknown as Duffel;

      const customService = new DuffelService(
        {} as CacheService,
        mockRateBudget as unknown as DuffelRateBudgetService,
        customDuffel,
      );

      await customService.retrieveOrder('ord_injected');
      expect(customOrdersGet).toHaveBeenCalledWith('ord_injected');
      expect(mockGetOrder).not.toHaveBeenCalled();
    });

    it('initializes Duffel SDK and creates order with valid loopback override', async () => {
      process.env.DUFFEL_API_URL = 'http://127.0.0.1:4010';
      const overrideService = new DuffelService(
        {} as CacheService,
        mockRateBudget as unknown as DuffelRateBudgetService,
      );

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
      expect(mockRateBudget.reserveAttempt).toHaveBeenCalledTimes(2);
    });

    it('normalizes trailing slashes for DUFFEL_API_URL', () => {
      process.env.DUFFEL_API_URL = 'http://127.0.0.1:4010/';
      new DuffelService(
        {} as CacheService,
        mockRateBudget as unknown as DuffelRateBudgetService,
      );

      expect(Duffel).toHaveBeenCalledWith(
        expect.objectContaining({
          basePath: 'http://127.0.0.1:4010',
        }),
      );
    });

    it('rejects invalid URL syntax during initialization', () => {
      process.env.DUFFEL_API_URL = 'not-a-valid-url';
      expect(
        () =>
          new DuffelService(
            {} as CacheService,
            mockRateBudget as unknown as DuffelRateBudgetService,
          ),
      ).toThrow();
    });

    it('rejects unsupported protocols during initialization', () => {
      process.env.DUFFEL_API_URL = 'ftp://127.0.0.1:4010';
      expect(
        () =>
          new DuffelService(
            {} as CacheService,
            mockRateBudget as unknown as DuffelRateBudgetService,
          ),
      ).toThrow();
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
    let searchRateBudget: MockRateBudgetService;

    const createMockOfferRequest = (id = 'or_test_123'): DuffelOfferRequest => ({
      id,
      slices: [
        {
          id: 'sli_1',
          duration: 'PT2H10M',
          origin: { id: 'HAN', name: 'Noi Bai Airport', iata_code: 'HAN', type: 'airport' },
          destination: {
            id: 'SGN',
            name: 'Tan Son Nhat Airport',
            iata_code: 'SGN',
            type: 'airport',
          },
          segments: [
            {
              id: 'seg_1',
              duration: 'PT2H10M',
              departing_at: '2026-10-01T08:00:00',
              arriving_at: '2026-10-01T10:10:00',
              origin: { id: 'HAN', name: 'Noi Bai Airport', iata_code: 'HAN', type: 'airport' },
              destination: {
                id: 'SGN',
                name: 'Tan Son Nhat Airport',
                iata_code: 'SGN',
                type: 'airport',
              },
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
      searchRateBudget = createMockRateBudgetService();
      searchService = new DuffelService(
        mockCache as unknown as CacheService,
        searchRateBudget as unknown as DuffelRateBudgetService,
      );
    });

    it('executes raw search for user caller on cache miss, reserving budget with user sub-limit (1000) and caching result with 900s TTL', async () => {
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
      expect(searchRateBudget.reserveAttempt).toHaveBeenCalledTimes(1);
      expect(searchRateBudget.reserveAttempt).toHaveBeenCalledWith({
        key: `budget:duffel:daily:user:${getUtcDateString()}`,
        limit: 1000,
      });
      expect(mockCache.incr).not.toHaveBeenCalled();
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

    it('executes raw search for agent caller on cache miss with agent sub-limit (500), round-trip and multi-passenger mapping', async () => {
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
      expect(searchRateBudget.reserveAttempt).toHaveBeenCalledTimes(1);
      expect(searchRateBudget.reserveAttempt).toHaveBeenCalledWith({
        key: `budget:duffel:daily:agent:${getUtcDateString()}`,
        limit: 500,
      });
      expect(mockCache.incr).not.toHaveBeenCalled();
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

    it('returns cached search result for user caller with 0 upstream Duffel calls and 0 budget reservations', async () => {
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
      expect(searchRateBudget.reserveAttempt).not.toHaveBeenCalled();
      expect(mockCache.incr).not.toHaveBeenCalled();
    });

    it('returns cached search result for agent caller with 0 upstream Duffel calls and 0 budget reservations', async () => {
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
      expect(searchRateBudget.reserveAttempt).not.toHaveBeenCalled();
      expect(mockCache.incr).not.toHaveBeenCalled();
    });

    it('enforces caller budget limit for user caller and throws RATE_LIMIT_EXCEEDED 429 without calling Duffel', async () => {
      const query = {
        origin: 'HAN',
        destination: 'SGN',
        departureDate: '2026-10-01',
        adults: 1,
      };

      searchRateBudget.reserveAttempt.mockResolvedValueOnce({
        ok: false,
        error: 'EXHAUSTED',
        retryAfterSeconds: 3600,
        resetAt: '2026-09-30T00:00:00.000Z',
      });

      await expect(searchService.searchFlights(query, 'user')).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
        response: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Daily Duffel API rate limit exceeded',
        },
      });

      expect(searchRateBudget.reserveAttempt).toHaveBeenCalledWith({
        key: `budget:duffel:daily:user:${getUtcDateString()}`,
        limit: 1000,
      });
      expect(mockOfferRequestsCreate).not.toHaveBeenCalled();
      expect(mockCache.incr).not.toHaveBeenCalled();
    });

    it('enforces caller budget limit for agent caller and throws RATE_LIMIT_EXCEEDED 429 without calling Duffel', async () => {
      const query = {
        origin: 'SGN',
        destination: 'HAN',
        departureDate: '2026-10-05',
        adults: 1,
      };

      searchRateBudget.reserveAttempt.mockResolvedValueOnce({
        ok: false,
        error: 'EXHAUSTED',
        retryAfterSeconds: 3600,
        resetAt: '2026-09-30T00:00:00.000Z',
      });

      await expect(searchService.searchFlights(query, 'agent')).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
        response: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Daily Duffel API rate limit exceeded',
        },
      });

      expect(searchRateBudget.reserveAttempt).toHaveBeenCalledWith({
        key: `budget:duffel:daily:agent:${getUtcDateString()}`,
        limit: 500,
      });
      expect(mockOfferRequestsCreate).not.toHaveBeenCalled();
      expect(mockCache.incr).not.toHaveBeenCalled();
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
    let detailRateBudget: MockRateBudgetService;

    beforeEach(() => {
      mockOffersGet.mockReset();
      detailRateBudget = createMockRateBudgetService();
      detailService = new DuffelService(
        {} as CacheService,
        detailRateBudget as unknown as DuffelRateBudgetService,
      );
    });

    it('successfully retrieves live offer details by ID and meters 1 reservation', async () => {
      const mockPayload = {
        id: 'off_detail_1',
        total_amount: '220.00',
        total_currency: 'USD',
      };
      mockOffersGet.mockResolvedValue({ data: mockPayload });

      const result = await detailService.getOfferById('off_detail_1');

      expect(result).toEqual(mockPayload);
      expect(detailRateBudget.reserveAttempt).toHaveBeenCalledTimes(1);
      expect(mockOffersGet).toHaveBeenCalledWith('off_detail_1');
    });

    it('rejects getOfferById with 429 RATE_LIMIT_EXCEEDED when rate budget is exhausted', async () => {
      detailRateBudget.reserveAttempt.mockResolvedValueOnce({
        ok: false,
        error: 'EXHAUSTED',
        retryAfterSeconds: 60,
        resetAt: '2026-09-30T00:00:00.000Z',
      });

      await expect(detailService.getOfferById('off_detail_1')).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
        response: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Daily Duffel API rate limit exceeded',
        },
      });
      expect(mockOffersGet).not.toHaveBeenCalled();
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
        await expect(detailService.getOfferById('off_slow', 15)).rejects.toThrow(
          DuffelTimeoutError,
        );
      } finally {
        clearTimeout(timer!);
      }
    });
  });

  describe('metered remote upstream attempts', () => {
    let testService: DuffelService;
    let mockCache: {
      get: jest.Mock<Promise<string | null>, [string]>;
      set: jest.Mock<Promise<void>, [string, string, number?]>;
      getTtl: jest.Mock<Promise<number>, [string]>;
    };
    let testRateBudget: MockRateBudgetService;

    beforeEach(() => {
      mockOffersGet.mockReset();
      mockOffersGetPriced.mockReset();
      mockSeatMapsGet.mockReset();
      mockCreateCancellation.mockReset();
      mockConfirmCancellation.mockReset();

      mockCache = {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue(undefined),
        getTtl: jest.fn().mockResolvedValue(-1),
      };
      testRateBudget = createMockRateBudgetService();
      testService = new DuffelService(
        mockCache as unknown as CacheService,
        testRateBudget as unknown as DuffelRateBudgetService,
      );
    });

    it('meters both seatMaps.get and offers.get separately in getSeatMapsAndServices', async () => {
      mockSeatMapsGet.mockResolvedValue({ data: [] });
      mockOffersGet.mockResolvedValue({
        data: { slices: [], available_services: [] },
      });

      const catalog = await testService.getSeatMapsAndServices('off_seatmap_test', true);

      expect(catalog).toBeDefined();
      expect(testRateBudget.reserveAttempt).toHaveBeenCalledTimes(2);
      expect(mockSeatMapsGet).toHaveBeenCalledWith({ offer_id: 'off_seatmap_test' });
      expect(mockOffersGet).toHaveBeenCalledWith('off_seatmap_test', {
        return_available_services: true,
      });
    });

    it('rejects getSeatMapsAndServices with 429 RATE_LIMIT_EXCEEDED when budget is exhausted', async () => {
      testRateBudget.reserveAttempt.mockResolvedValue({
        ok: false,
        error: 'EXHAUSTED',
        retryAfterSeconds: 60,
        resetAt: '2026-09-30T00:00:00.000Z',
      });

      await expect(
        testService.getSeatMapsAndServices('off_seatmap_test', true),
      ).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
        response: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Daily Duffel API rate limit exceeded',
        },
      });
      expect(mockSeatMapsGet).not.toHaveBeenCalled();
      expect(mockOffersGet).not.toHaveBeenCalled();
    });

    it('aborts getSeatMapsAndServices before making any Duffel SDK calls when second reservation is exhausted', async () => {
      testRateBudget.reserveAttempt
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({
          ok: false,
          error: 'EXHAUSTED',
          retryAfterSeconds: 60,
          resetAt: '2026-09-30T00:00:00.000Z',
        });

      await expect(
        testService.getSeatMapsAndServices('off_seatmap_test', true),
      ).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
        response: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Daily Duffel API rate limit exceeded',
        },
      });
      expect(mockSeatMapsGet).not.toHaveBeenCalled();
      expect(mockOffersGet).not.toHaveBeenCalled();
    });

    it('meters 1 reservation in repriceOffer before offers.getPriced', async () => {
      mockOffersGetPriced.mockResolvedValue({
        data: {
          total_amount: '100.00',
          base_amount: '80.00',
          total_currency: 'USD',
          service_lines: [],
        },
      });

      const result = await testService.repriceOffer('off_reprice_test', [
        { serviceId: 'srv_1', quantity: 1 },
      ]);

      expect(result).toBeDefined();
      expect(testRateBudget.reserveAttempt).toHaveBeenCalledTimes(1);
      expect(mockOffersGetPriced).toHaveBeenCalledTimes(1);
    });

    it('rejects repriceOffer with 429 RATE_LIMIT_EXCEEDED when budget is exhausted', async () => {
      testRateBudget.reserveAttempt.mockResolvedValueOnce({
        ok: false,
        error: 'EXHAUSTED',
        retryAfterSeconds: 60,
        resetAt: '2026-09-30T00:00:00.000Z',
      });

      await expect(
        testService.repriceOffer('off_reprice_test', [{ serviceId: 'srv_1', quantity: 1 }]),
      ).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
        response: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Daily Duffel API rate limit exceeded',
        },
      });
      expect(mockOffersGetPriced).not.toHaveBeenCalled();
    });

    it('meters 1 reservation before orderCancellations.create in createCancellationQuote when not mocked', async () => {
      const prevJest = process.env.JEST_WORKER_ID;
      const prevNodeEnv = process.env.NODE_ENV;
      const prevToken = process.env.DUFFEL_ACCESS_TOKEN;

      try {
        delete process.env.JEST_WORKER_ID;
        process.env.NODE_ENV = 'production';
        process.env.DUFFEL_ACCESS_TOKEN = 'real-duffel-token';

        mockCreateCancellation.mockResolvedValue({
          data: { id: 'oc_unmocked_1' },
        });

        const unmockedService = new DuffelService(
          mockCache as unknown as CacheService,
          testRateBudget as unknown as DuffelRateBudgetService,
        );

        const quote = await unmockedService.createCancellationQuote('ord_unmocked');
        expect(quote).toEqual({ id: 'oc_unmocked_1' });
        expect(testRateBudget.reserveAttempt).toHaveBeenCalledTimes(1);
        expect(mockCreateCancellation).toHaveBeenCalledWith({ order_id: 'ord_unmocked' });
      } finally {
        if (prevJest !== undefined) {
          process.env.JEST_WORKER_ID = prevJest;
        } else {
          delete process.env.JEST_WORKER_ID;
        }
        process.env.NODE_ENV = prevNodeEnv;
        if (prevToken !== undefined) {
          process.env.DUFFEL_ACCESS_TOKEN = prevToken;
        } else {
          delete process.env.DUFFEL_ACCESS_TOKEN;
        }
      }
    });

    it('rejects createCancellationQuote with 429 RATE_LIMIT_EXCEEDED when not mocked and budget is exhausted', async () => {
      const prevJest = process.env.JEST_WORKER_ID;
      const prevNodeEnv = process.env.NODE_ENV;
      const prevToken = process.env.DUFFEL_ACCESS_TOKEN;

      try {
        delete process.env.JEST_WORKER_ID;
        process.env.NODE_ENV = 'production';
        process.env.DUFFEL_ACCESS_TOKEN = 'real-duffel-token';

        testRateBudget.reserveAttempt.mockResolvedValueOnce({
          ok: false,
          error: 'EXHAUSTED',
          retryAfterSeconds: 60,
          resetAt: '2026-09-30T00:00:00.000Z',
        });

        const unmockedService = new DuffelService(
          mockCache as unknown as CacheService,
          testRateBudget as unknown as DuffelRateBudgetService,
        );

        await expect(unmockedService.createCancellationQuote('ord_unmocked')).rejects.toMatchObject({
          status: HttpStatus.TOO_MANY_REQUESTS,
          response: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Daily Duffel API rate limit exceeded',
          },
        });
        expect(mockCreateCancellation).not.toHaveBeenCalled();
      } finally {
        if (prevJest !== undefined) {
          process.env.JEST_WORKER_ID = prevJest;
        } else {
          delete process.env.JEST_WORKER_ID;
        }
        process.env.NODE_ENV = prevNodeEnv;
        if (prevToken !== undefined) {
          process.env.DUFFEL_ACCESS_TOKEN = prevToken;
        } else {
          delete process.env.DUFFEL_ACCESS_TOKEN;
        }
      }
    });
  });
});
