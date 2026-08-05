const mockSeatMapsGet = jest.fn();
const mockOffersGet = jest.fn();
const mockOffersGetPriced = jest.fn();

jest.mock('@duffel/api', () => ({
  Duffel: jest.fn().mockImplementation(() => ({
    seatMaps: {
      get: mockSeatMapsGet,
    },
    offers: {
      get: mockOffersGet,
      getPriced: mockOffersGetPriced,
    },
  })),
}));

import { CacheService } from '@/cache/cache.service';
import { DuffelService } from './duffel.service';

describe('DuffelService Ancillaries, Normalization, Caching & Repricing', () => {
  let service: DuffelService;
  let mockCacheService: jest.Mocked<CacheService>;
  const mockFetch = jest.fn();

  beforeAll(() => {
    global.fetch = mockFetch;
  });

  beforeEach(() => {
    mockSeatMapsGet.mockReset();
    mockOffersGet.mockReset();
    mockOffersGetPriced.mockReset();
    mockFetch.mockReset();

    mockCacheService = {
      get: jest.fn(),
      set: jest.fn(),
      getTtl: jest.fn(),
      incr: jest.fn(),
      decr: jest.fn(),
      del: jest.fn(),
      keys: jest.fn(),
      onModuleInit: jest.fn(),
      onModuleDestroy: jest.fn(),
    } as unknown as jest.Mocked<CacheService>;

    service = new DuffelService(mockCacheService);
  });

  describe('getSeatMapsAndServices', () => {
    const offerId = 'off_123';
    const mockOfferResponse = {
      data: {
        id: offerId,
        slices: [
          {
            id: 'sli_1',
            segments: [
              {
                id: 'seg_1',
                origin: { iata_code: 'SGN' },
                destination: { iata_code: 'SIN' },
              },
            ],
          },
        ],
        available_services: [
          {
            id: 'ase_bag_1',
            type: 'baggage',
            passenger_ids: ['pas_1'],
            segment_ids: ['seg_1'],
            total_amount: '30.00',
            total_currency: 'USD',
            metadata: {
              type: 'checked',
              weight: 23,
              weight_unit: 'kg',
              maximum_quantity: 2,
            },
          },
          {
            id: 'ase_bag_journey',
            type: 'baggage',
            passenger_ids: ['pas_1'],
            segment_ids: ['seg_1', 'seg_2'],
            total_amount: '50.00',
            total_currency: 'USD',
            metadata: {
              type: 'checked',
              weight: 23,
              weight_unit: 'kg',
              maximum_quantity: 2,
            },
          },
        ],
      },
    };

    const mockSeatMapsResponse = {
      data: [
        {
          id: 'smp_1',
          segment_id: 'seg_1',
          cabins: [
            {
              cabin_class: 'economy',
              rows: [
                {
                  row_number: 1,
                  sections: [
                    {
                      elements: [
                        {
                          type: 'seat',
                          designator: '1A',
                          available_services: [
                            {
                              id: 'ase_seat_1',
                              passenger_id: 'pas_1',
                              total_amount: '15.00',
                              total_currency: 'USD',
                            },
                          ],
                          disclosures: ['restricted'],
                        },
                        {
                          type: 'aisle',
                        },
                        {
                          type: 'seat',
                          designator: '1B',
                          available_services: [
                            {
                              id: 'ase_seat_2',
                              passenger_id: 'pas_1',
                              total_amount: '15.00',
                              total_currency: 'USD',
                            },
                          ],
                          disclosures: ['exit_row', 'overwing'],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    it('successfully normalizes a seat map and baggage services catalog (multi-cabin, exit rows, restricted)', async () => {
      mockCacheService.getTtl.mockResolvedValue(-2); // Cache miss
      mockOffersGet.mockResolvedValue(mockOfferResponse);
      mockSeatMapsGet.mockResolvedValue(mockSeatMapsResponse);

      const catalog = await service.getSeatMapsAndServices(offerId);

      expect(catalog.cache.status).toBe('MISS');
      expect(catalog.segments).toHaveLength(1);
      const seg = catalog.segments[0];
      expect(seg.segmentId).toBe('seg_1');
      expect(seg.origin).toBe('SGN');
      expect(seg.destination).toBe('SIN');
      expect(seg.seatMapAvailable).toBe(true);

      const seatMap = seg.seatMap!;
      expect(seatMap.cabins).toHaveLength(1);
      expect(seatMap.cabins[0].cabinClass).toBe('economy');
      expect(seatMap.cabins[0].rows).toHaveLength(1);
      
      const row = seatMap.cabins[0].rows[0];
      expect(row.rowNumber).toBe(1);
      expect(row.elements).toHaveLength(3);
      
      // Seat 1A (Restricted)
      expect(row.elements[0]).toMatchObject({
        type: 'seat',
        designator: '1A',
        restricted: true,
        availableServices: [
          {
            serviceId: 'ase_seat_1',
            passengerId: 'pas_1',
            amount: '15.00',
            currency: 'USD',
          },
        ],
      });

      // Aisle
      expect(row.elements[1]).toMatchObject({
        type: 'aisle',
      });

      // Seat 1B (Exit row/overwing)
      expect(row.elements[2]).toMatchObject({
        type: 'seat',
        designator: '1B',
        restricted: false,
        availableServices: [
          {
            serviceId: 'ase_seat_2',
            passengerId: 'pas_1',
            amount: '15.00',
            currency: 'USD',
          },
        ],
      });

      // Baggage
      expect(catalog.baggageServices).toHaveLength(2);
      expect(catalog.baggageServices[0]).toEqual({
        serviceId: 'ase_bag_1',
        passengerId: 'pas_1',
        segmentIds: ['seg_1'],
        type: 'checked',
        weightValue: 23,
        weightUnit: 'kg',
        maxQuantity: 2,
        amount: '30.00',
        currency: 'USD',
      });

      expect(catalog.baggageServices[1]).toEqual({
        serviceId: 'ase_bag_journey',
        passengerId: 'pas_1',
        segmentIds: ['seg_1', 'seg_2'],
        type: 'checked',
        weightValue: 23,
        weightUnit: 'kg',
        maxQuantity: 2,
        amount: '50.00',
        currency: 'USD',
      });

      // Verification that normalized catalog contains zero intent-local IDs
      expect(JSON.stringify(catalog)).not.toContain('intent');
    });

    it('sets seatMapAvailable to false and seatMap to null if no seat map is returned', async () => {
      mockCacheService.getTtl.mockResolvedValue(-2);
      mockOffersGet.mockResolvedValue(mockOfferResponse);
      mockSeatMapsGet.mockResolvedValue({ data: [] }); // No seat map for segment

      const catalog = await service.getSeatMapsAndServices(offerId);
      expect(catalog.segments[0].seatMapAvailable).toBe(false);
      expect(catalog.segments[0].seatMap).toBeNull();
    });

    it('quarantines/rejects incomplete available services', async () => {
      mockCacheService.getTtl.mockResolvedValue(-2);
      const mockOfferWithIncompleteService = {
        data: {
          id: offerId,
          slices: mockOfferResponse.data.slices,
          available_services: [
            {
              id: 'incomplete_bag_1',
              type: 'baggage',
              total_amount: '20.00',
              // missing total_currency, passenger_ids
            },
            ...mockOfferResponse.data.available_services,
          ],
        },
      };
      mockOffersGet.mockResolvedValue(mockOfferWithIncompleteService);
      mockSeatMapsGet.mockResolvedValue(mockSeatMapsResponse);

      const catalog = await service.getSeatMapsAndServices(offerId);
      // Verify that incomplete_bag_1 is NOT in the baggage services
      const ids = catalog.baggageServices.map((s) => s.serviceId);
      expect(ids).not.toContain('incomplete_bag_1');
      expect(ids).toContain('ase_bag_1');
    });

    it('hits the cache if TTL is greater than 3 seconds', async () => {
      const mockCachedCatalog = {
        fetchedAt: '2026-07-26T10:00:00.000Z',
        cache: { status: 'MISS', ttlSeconds: 60 },
        segments: [],
        baggageServices: [],
      };
      mockCacheService.getTtl.mockResolvedValue(10); // TTL = 10 > 3
      mockCacheService.get.mockResolvedValue(JSON.stringify(mockCachedCatalog));

      const catalog = await service.getSeatMapsAndServices(offerId);

      expect(catalog.cache.status).toBe('HIT');
      expect(catalog.cache.ttlSeconds).toBe(10);
      expect(mockOffersGet).not.toHaveBeenCalled();
      expect(mockSeatMapsGet).not.toHaveBeenCalled();
    });

    it('misses the cache and calls supplier if TTL is <= 3', async () => {
      mockCacheService.getTtl.mockResolvedValue(2); // TTL = 2 <= 3
      mockOffersGet.mockResolvedValue(mockOfferResponse);
      mockSeatMapsGet.mockResolvedValue(mockSeatMapsResponse);

      const catalog = await service.getSeatMapsAndServices(offerId);

      expect(catalog.cache.status).toBe('MISS');
      expect(mockOffersGet).toHaveBeenCalled();
      expect(mockSeatMapsGet).toHaveBeenCalled();
    });

    it('misses the cache and calls supplier if cache is missing (-2) or no-expiry (-1)', async () => {
      mockCacheService.getTtl.mockResolvedValue(-1); // No expiry (unexpected cache state)
      mockOffersGet.mockResolvedValue(mockOfferResponse);
      mockSeatMapsGet.mockResolvedValue(mockSeatMapsResponse);

      const catalog = await service.getSeatMapsAndServices(offerId);

      expect(catalog.cache.status).toBe('MISS');
      expect(mockOffersGet).toHaveBeenCalled();
    });

    it('bypasses cache when forceRefresh is true', async () => {
      mockCacheService.getTtl.mockResolvedValue(30); // Cache hit state
      mockOffersGet.mockResolvedValue(mockOfferResponse);
      mockSeatMapsGet.mockResolvedValue(mockSeatMapsResponse);

      const catalog = await service.getSeatMapsAndServices(offerId, true);

      expect(catalog.cache.status).toBe('MISS');
      expect(mockOffersGet).toHaveBeenCalled();
      expect(mockSeatMapsGet).toHaveBeenCalled();
    });

    it('falls back to supplier fetch if CacheService read fails', async () => {
      mockCacheService.getTtl.mockRejectedValue(new Error('Redis connection failed'));
      mockOffersGet.mockResolvedValue(mockOfferResponse);
      mockSeatMapsGet.mockResolvedValue(mockSeatMapsResponse);

      const catalog = await service.getSeatMapsAndServices(offerId);

      expect(catalog.cache.status).toBe('MISS');
      expect(mockOffersGet).toHaveBeenCalled();
    });
  });

  describe('repriceOffer', () => {
    const offerId = 'off_123';
    
    it('deduplicates services by summing their quantities and returns repriced totals', async () => {
      const intendedServices = [
        { serviceId: 'ase_bag_1', quantity: 1 },
        { serviceId: 'ase_bag_1', quantity: 1 }, // Duplicate
        { serviceId: 'ase_seat_1', quantity: 1 },
      ];

      const mockPricedOffer = {
        data: {
          id: offerId,
          total_amount: '470.00',
          total_currency: 'USD',
          base_amount: '400.00',
          base_currency: 'USD',
          service_lines: [
            {
              id: 'line_1',
              total_amount: '50.00',
              total_currency: 'USD',
              quantity: 2,
              service_id: 'ase_bag_1',
            },
            {
              id: 'line_2',
              total_amount: '20.00',
              total_currency: 'USD',
              quantity: 1,
              service_id: 'ase_seat_1',
            },
          ],
        },
      };

      mockOffersGetPriced.mockResolvedValue(mockPricedOffer);

      const result = await service.repriceOffer(offerId, intendedServices);

      expect(mockOffersGetPriced).toHaveBeenCalledWith(offerId, {
        intended_payment_methods: [{ type: 'card', card_id: 'mock_card' }],
        intended_services: [
          { id: 'ase_bag_1', quantity: 2 },
          { id: 'ase_seat_1', quantity: 1 },
        ],
      });

      expect(result).toEqual({
        totalAmount: '470.00',
        baseAmount: '400.00',
        currency: 'USD',
        serviceLines: [
          { serviceId: 'ase_bag_1', amount: '50.00', quantity: 2 },
          { serviceId: 'ase_seat_1', amount: '20.00', quantity: 1 },
        ],
        invalidServiceIdentities: [],
      });
    });

    it('catches upstream 400 validation errors and maps them to invalidServiceIdentities', async () => {
      const intendedServices = [
        { serviceId: 'ase_invalid_seat', quantity: 1 },
        { serviceId: 'ase_valid_bag', quantity: 1 },
      ];

      const upstreamError = {
        status: 400,
        message: 'The service ase_invalid_seat is not valid for this offer.',
        errors: [
          {
            message: 'The service ase_invalid_seat is not valid for this offer.',
            code: 'invalid_intended_services',
          },
        ],
      };

      mockOffersGetPriced.mockRejectedValue(upstreamError);

      const result = await service.repriceOffer(offerId, intendedServices);

      expect(result.invalidServiceIdentities).toEqual(['ase_invalid_seat']);
      expect(result.totalAmount).toBe('0.00');
    });
  });

  describe('createOrder', () => {
    const offerId = 'off_123';
    const mockPassengers = [
      {
        id: 'pas_123',
        type: 'adult',
        givenName: 'John',
        familyName: 'Doe',
        born_on: '1990-01-01',
        email: 'john@example.com',
        phoneNumber: '+1234567890',
        dateOfBirth: '1990-01-01',
      },
    ];

    const mockOfferResponse = {
      data: {
        id: offerId,
        passengers: [{ id: 'pas_duffel_1', type: 'adult' }],
      },
    };

    beforeEach(() => {
      mockOffersGet.mockResolvedValue(mockOfferResponse);
    });

    it('passes validated services exactly once under services in the post body', async () => {
      const services = [{ id: 'ase_seat_1', quantity: 1 }];
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: { id: 'ord_123' } }),
      });

      const order = await service.createOrder(offerId, mockPassengers, services, { some: 'meta' }, 'idem_123');

      expect(order).toEqual({ id: 'ord_123' });
      expect(mockFetch).toHaveBeenCalled();
      
      const fetchCall = mockFetch.mock.calls[0];
      const url = fetchCall[0];
      const options = fetchCall[1];
      
      expect(url).toContain('/air/orders');
      expect(options.method).toBe('POST');
      expect(options.headers['Idempotency-Key']).toBe('idem_123-duffel-order');

      const body = JSON.parse(options.body);
      expect(body.data.selected_offers).toEqual([offerId]);
      expect(body.data.services).toEqual(services);
      expect(body.data.metadata).toEqual({ some: 'meta' });
    });

    it('is backward compatible with legacy signature (no services parameter passed)', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: { id: 'ord_123' } }),
      });

      const order = await service.createOrder(offerId, mockPassengers, { some: 'meta' }, 'idem_123');

      expect(order).toEqual({ id: 'ord_123' });
      expect(mockFetch).toHaveBeenCalled();

      const options = mockFetch.mock.calls[0][1];
      const body = JSON.parse(options.body);
      
      expect(body.data.services).toBeUndefined();
      expect(body.data.metadata).toEqual({ some: 'meta' });
      expect(options.headers['Idempotency-Key']).toBe('idem_123-duffel-order');
    });
  });
});
