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

import { HttpStatus } from '@nestjs/common';
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

    it('misses the cache and calls supplier if TTL is exact boundary 3s (requires strictly > 3s)', async () => {
      mockCacheService.getTtl.mockResolvedValue(3); // Boundary condition: 3 > 3 is false
      mockOffersGet.mockResolvedValue(mockOfferResponse);
      mockSeatMapsGet.mockResolvedValue(mockSeatMapsResponse);

      const catalog = await service.getSeatMapsAndServices(offerId);

      expect(catalog.cache.status).toBe('MISS');
      expect(mockOffersGet).toHaveBeenCalled();
      expect(mockSeatMapsGet).toHaveBeenCalled();
    });

    it('hits the cache if TTL is exact boundary 4s (first integer > 3s)', async () => {
      const mockCachedCatalog = {
        fetchedAt: '2026-07-26T10:00:00.000Z',
        cache: { status: 'MISS', ttlSeconds: 60 },
        segments: [],
        baggageServices: [],
      };
      mockCacheService.getTtl.mockResolvedValue(4); // 4 > 3 is true
      mockCacheService.get.mockResolvedValue(JSON.stringify(mockCachedCatalog));

      const catalog = await service.getSeatMapsAndServices(offerId);

      expect(catalog.cache.status).toBe('HIT');
      expect(catalog.cache.ttlSeconds).toBe(4);
      expect(mockOffersGet).not.toHaveBeenCalled();
      expect(mockSeatMapsGet).not.toHaveBeenCalled();
    });

    it('falls back to supplier fetch if cache returns null despite TTL > 3', async () => {
      mockCacheService.getTtl.mockResolvedValue(10);
      mockCacheService.get.mockResolvedValue(null); // Evicted or expired race
      mockOffersGet.mockResolvedValue(mockOfferResponse);
      mockSeatMapsGet.mockResolvedValue(mockSeatMapsResponse);

      const catalog = await service.getSeatMapsAndServices(offerId);

      expect(catalog.cache.status).toBe('MISS');
      expect(mockOffersGet).toHaveBeenCalled();
      expect(mockSeatMapsGet).toHaveBeenCalled();
    });

    it('falls back to supplier fetch if cached JSON is malformed', async () => {
      mockCacheService.getTtl.mockResolvedValue(10);
      mockCacheService.get.mockResolvedValue('invalid-json-data');
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

    it('writes normalized catalog to cache with 60s TTL on cache miss', async () => {
      mockCacheService.getTtl.mockResolvedValue(-2);
      mockOffersGet.mockResolvedValue(mockOfferResponse);
      mockSeatMapsGet.mockResolvedValue(mockSeatMapsResponse);

      const catalog = await service.getSeatMapsAndServices(offerId);

      expect(mockCacheService.set).toHaveBeenCalledTimes(1);
      expect(mockCacheService.set).toHaveBeenCalledWith(
        `seatmap:${offerId}`,
        JSON.stringify(catalog),
        60,
      );
    });

    it('handles cache write failure gracefully without throwing', async () => {
      mockCacheService.getTtl.mockResolvedValue(-2);
      mockOffersGet.mockResolvedValue(mockOfferResponse);
      mockSeatMapsGet.mockResolvedValue(mockSeatMapsResponse);
      mockCacheService.set.mockRejectedValue(new Error('Redis connection failed on set'));

      const catalog = await service.getSeatMapsAndServices(offerId);

      expect(catalog).toBeDefined();
      expect(catalog.segments).toHaveLength(1);
      expect(catalog.baggageServices).toHaveLength(2);
    });

    it('handles missing seat maps when supplier returns undefined or null data', async () => {
      mockCacheService.getTtl.mockResolvedValue(-2);
      mockOffersGet.mockResolvedValue(mockOfferResponse);
      mockSeatMapsGet.mockResolvedValue({ data: undefined });

      const catalog = await service.getSeatMapsAndServices(offerId);

      expect(catalog.segments[0].segmentId).toBe('seg_1');
      expect(catalog.segments[0].seatMapAvailable).toBe(false);
      expect(catalog.segments[0].seatMap).toBeNull();
    });

    it('handles missing seat maps when supplier returns explicit null data', async () => {
      mockCacheService.getTtl.mockResolvedValue(-2);
      mockOffersGet.mockResolvedValue(mockOfferResponse);
      mockSeatMapsGet.mockResolvedValue({ data: null });

      const catalog = await service.getSeatMapsAndServices(offerId);

      expect(catalog.segments[0].segmentId).toBe('seg_1');
      expect(catalog.segments[0].seatMapAvailable).toBe(false);
      expect(catalog.segments[0].seatMap).toBeNull();
    });

    it('throws UPSTREAM_RATE_LIMITED (429) when seat maps fetch is rate limited by supplier', async () => {
      mockCacheService.getTtl.mockResolvedValue(-2);
      mockOffersGet.mockResolvedValue(mockOfferResponse);
      mockSeatMapsGet.mockRejectedValue({ status: 429, message: 'Duffel API rate limit exceeded' });

      await expect(service.getSeatMapsAndServices(offerId)).rejects.toMatchObject({
        response: {
          code: 'UPSTREAM_RATE_LIMITED',
          message: 'Duffel API rate limit exceeded',
        },
        status: HttpStatus.TOO_MANY_REQUESTS,
      });
    });

    it('throws UPSTREAM_UNAVAILABLE (502) when seat maps fetch encounters upstream 500 error', async () => {
      mockCacheService.getTtl.mockResolvedValue(-2);
      mockOffersGet.mockResolvedValue(mockOfferResponse);
      mockSeatMapsGet.mockRejectedValue({ status: 500, message: 'Supplier internal failure' });

      await expect(service.getSeatMapsAndServices(offerId)).rejects.toMatchObject({
        response: {
          code: 'UPSTREAM_UNAVAILABLE',
        },
        status: HttpStatus.BAD_GATEWAY,
      });
    });

    it('throws UPSTREAM_UNAVAILABLE (504) when seat map lookup times out past 4500ms', async () => {
      jest.useFakeTimers();
      try {
        mockCacheService.getTtl.mockResolvedValue(-2);
        mockOffersGet.mockReturnValue(new Promise(() => {}));
        mockSeatMapsGet.mockReturnValue(new Promise(() => {}));

        const promise = service.getSeatMapsAndServices(offerId);
        const rejectionAssertion = expect(promise).rejects.toMatchObject({
          response: {
            code: 'UPSTREAM_UNAVAILABLE',
            message: 'Duffel seatmaps lookup timed out.',
          },
          status: HttpStatus.GATEWAY_TIMEOUT,
        });

        await jest.advanceTimersByTimeAsync(4500);
        await rejectionAssertion;
      } finally {
        jest.useRealTimers();
      }
    });

    it('handles multi-segment journey where some segments have seat maps and others do not', async () => {
      mockCacheService.getTtl.mockResolvedValue(-2);
      const multiSegmentOffer = {
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
                {
                  id: 'seg_2',
                  origin: { iata_code: 'SIN' },
                  destination: { iata_code: 'LHR' },
                },
              ],
            },
          ],
          available_services: [],
        },
      };

      const partialSeatMaps = {
        data: [
          {
            id: 'smp_1',
            segment_id: 'seg_1',
            cabins: [],
          },
        ],
      };

      mockOffersGet.mockResolvedValue(multiSegmentOffer);
      mockSeatMapsGet.mockResolvedValue(partialSeatMaps);

      const catalog = await service.getSeatMapsAndServices(offerId);

      expect(catalog.segments).toHaveLength(2);
      expect(catalog.segments[0].segmentId).toBe('seg_1');
      expect(catalog.segments[0].seatMapAvailable).toBe(true);
      expect(catalog.segments[0].seatMap).toEqual({ cabins: [] });

      expect(catalog.segments[1].segmentId).toBe('seg_2');
      expect(catalog.segments[1].seatMapAvailable).toBe(false);
      expect(catalog.segments[1].seatMap).toBeNull();
    });

    it('handles empty slices and slices without segments gracefully', async () => {
      mockCacheService.getTtl.mockResolvedValue(-2);
      const emptySlicesOffer = {
        data: {
          id: offerId,
          slices: [],
          available_services: [],
        },
      };
      mockOffersGet.mockResolvedValue(emptySlicesOffer);
      mockSeatMapsGet.mockResolvedValue({ data: [] });

      const catalog = await service.getSeatMapsAndServices(offerId);

      expect(catalog.segments).toEqual([]);
      expect(catalog.baggageServices).toEqual([]);
    });

    it('handles seat maps with empty cabins, empty rows, or empty sections gracefully', async () => {
      mockCacheService.getTtl.mockResolvedValue(-2);
      mockOffersGet.mockResolvedValue(mockOfferResponse);
      const sparseSeatMapResponse = {
        data: [
          {
            id: 'smp_sparse',
            segment_id: 'seg_1',
            cabins: [
              {
                cabin_class: 'business',
                rows: [
                  {
                    row_number: 1,
                    sections: [],
                  },
                ],
              },
            ],
          },
        ],
      };
      mockSeatMapsGet.mockResolvedValue(sparseSeatMapResponse);

      const catalog = await service.getSeatMapsAndServices(offerId);

      expect(catalog.segments[0].seatMapAvailable).toBe(true);
      const cabins = catalog.segments[0].seatMap?.cabins;
      expect(cabins).toHaveLength(1);
      expect(cabins?.[0].cabinClass).toBe('business');
      expect(cabins?.[0].rows[0].elements).toEqual([]);
    });
  });

  describe('passenger-scoped ancillary catalog generation', () => {
    const offerId = 'off_multi_pax';

    it('generates distinct passenger-scoped baggage services when service.passenger_ids contains multiple passengers', async () => {
      mockCacheService.getTtl.mockResolvedValue(-2);
      const multiPaxOffer = {
        data: {
          id: offerId,
          slices: [
            {
              id: 'sli_1',
              segments: [
                {
                  id: 'seg_1',
                  origin: { iata_code: 'JFK' },
                  destination: { iata_code: 'LHR' },
                },
              ],
            },
          ],
          available_services: [
            {
              id: 'ase_shared_bag',
              type: 'baggage',
              passenger_ids: ['pas_adult_1', 'pas_adult_2'],
              segment_ids: ['seg_1'],
              total_amount: '45.00',
              total_currency: 'USD',
              metadata: {
                type: 'checked',
                weight: 23,
                weight_unit: 'kg',
                maximum_quantity: 2,
              },
            },
            {
              id: 'ase_pax1_carryon',
              type: 'baggage',
              passenger_ids: ['pas_adult_1'],
              segment_ids: ['seg_1'],
              total_amount: '25.00',
              total_currency: 'USD',
              metadata: {
                type: 'carry_on',
                weight: 10,
                weight_unit: 'kg',
                maximum_quantity: 1,
              },
            },
          ],
        },
      };

      mockOffersGet.mockResolvedValue(multiPaxOffer);
      mockSeatMapsGet.mockResolvedValue({ data: [] });

      const catalog = await service.getSeatMapsAndServices(offerId);

      // Shared baggage service should expand into two distinct passenger-scoped records
      expect(catalog.baggageServices).toHaveLength(3);

      const pax1Services = catalog.baggageServices.filter((b) => b.passengerId === 'pas_adult_1');
      const pax2Services = catalog.baggageServices.filter((b) => b.passengerId === 'pas_adult_2');

      expect(pax1Services).toHaveLength(2);
      expect(pax2Services).toHaveLength(1);

      // Both passengers have an entry for the shared checked bag
      expect(pax1Services.find((b) => b.serviceId === 'ase_shared_bag')).toEqual({
        serviceId: 'ase_shared_bag',
        passengerId: 'pas_adult_1',
        segmentIds: ['seg_1'],
        type: 'checked',
        weightValue: 23,
        weightUnit: 'kg',
        maxQuantity: 2,
        amount: '45.00',
        currency: 'USD',
      });

      expect(pax2Services.find((b) => b.serviceId === 'ase_shared_bag')).toEqual({
        serviceId: 'ase_shared_bag',
        passengerId: 'pas_adult_2',
        segmentIds: ['seg_1'],
        type: 'checked',
        weightValue: 23,
        weightUnit: 'kg',
        maxQuantity: 2,
        amount: '45.00',
        currency: 'USD',
      });

      // Only passenger 1 has carry-on
      expect(pax1Services.find((b) => b.serviceId === 'ase_pax1_carryon')).toBeDefined();
      expect(pax2Services.find((b) => b.serviceId === 'ase_pax1_carryon')).toBeUndefined();
    });

    it('generates distinct passenger-scoped seat services in seat map elements for multiple passengers', async () => {
      mockCacheService.getTtl.mockResolvedValue(-2);
      const offerWithSegments = {
        data: {
          id: offerId,
          slices: [
            {
              id: 'sli_1',
              segments: [
                {
                  id: 'seg_1',
                  origin: { iata_code: 'JFK' },
                  destination: { iata_code: 'LHR' },
                },
              ],
            },
          ],
          available_services: [],
        },
      };

      const multiPaxSeatMap = {
        data: [
          {
            id: 'smp_multi',
            segment_id: 'seg_1',
            cabins: [
              {
                cabin_class: 'economy',
                rows: [
                  {
                    row_number: 12,
                    sections: [
                      {
                        elements: [
                          {
                            type: 'seat',
                            designator: '12A',
                            available_services: [
                              {
                                id: 'ase_seat_12a_p1',
                                passenger_id: 'pas_adult_1',
                                total_amount: '20.00',
                                total_currency: 'USD',
                              },
                              {
                                id: 'ase_seat_12a_p2',
                                passenger_id: 'pas_adult_2',
                                total_amount: '20.00',
                                total_currency: 'USD',
                              },
                            ],
                            disclosures: [],
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

      mockOffersGet.mockResolvedValue(offerWithSegments);
      mockSeatMapsGet.mockResolvedValue(multiPaxSeatMap);

      const catalog = await service.getSeatMapsAndServices(offerId);

      const seg = catalog.segments[0];
      expect(seg.seatMapAvailable).toBe(true);
      const seat12A = seg.seatMap?.cabins[0].rows[0].elements[0];
      expect(seat12A?.designator).toBe('12A');
      expect(seat12A?.availableServices).toHaveLength(2);

      expect(seat12A?.availableServices).toEqual([
        {
          serviceId: 'ase_seat_12a_p1',
          passengerId: 'pas_adult_1',
          amount: '20.00',
          currency: 'USD',
        },
        {
          serviceId: 'ase_seat_12a_p2',
          passengerId: 'pas_adult_2',
          amount: '20.00',
          currency: 'USD',
        },
      ]);
    });

    it('quarantines seat services missing passenger_id or required fields', async () => {
      mockCacheService.getTtl.mockResolvedValue(-2);
      const offerWithSegments = {
        data: {
          id: offerId,
          slices: [
            {
              id: 'sli_1',
              segments: [
                {
                  id: 'seg_1',
                  origin: { iata_code: 'JFK' },
                  destination: { iata_code: 'LHR' },
                },
              ],
            },
          ],
          available_services: [],
        },
      };

      const seatMapWithInvalidServices = {
        data: [
          {
            id: 'smp_quarantine',
            segment_id: 'seg_1',
            cabins: [
              {
                cabin_class: 'economy',
                rows: [
                  {
                    row_number: 15,
                    sections: [
                      {
                        elements: [
                          {
                            type: 'seat',
                            designator: '15C',
                            available_services: [
                              // Missing passenger_id
                              {
                                id: 'ase_no_pax',
                                total_amount: '10.00',
                                total_currency: 'USD',
                              },
                              // Missing total_amount
                              {
                                id: 'ase_no_amount',
                                passenger_id: 'pas_adult_1',
                                total_currency: 'USD',
                              },
                              // Missing total_currency
                              {
                                id: 'ase_no_currency',
                                passenger_id: 'pas_adult_1',
                                total_amount: '10.00',
                              },
                              // Valid service
                              {
                                id: 'ase_valid_pax1',
                                passenger_id: 'pas_adult_1',
                                total_amount: '10.00',
                                total_currency: 'USD',
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
          },
        ],
      };

      mockOffersGet.mockResolvedValue(offerWithSegments);
      mockSeatMapsGet.mockResolvedValue(seatMapWithInvalidServices);

      const catalog = await service.getSeatMapsAndServices(offerId);

      const seat = catalog.segments[0].seatMap?.cabins[0].rows[0].elements[0];
      expect(seat?.availableServices).toHaveLength(1);
      expect(seat?.availableServices?.[0].serviceId).toBe('ase_valid_pax1');
    });

    it('quarantines baggage services missing passenger_ids or with empty passenger_ids array', async () => {
      mockCacheService.getTtl.mockResolvedValue(-2);
      const offerWithInvalidBaggage = {
        data: {
          id: offerId,
          slices: [
            {
              id: 'sli_1',
              segments: [
                {
                  id: 'seg_1',
                  origin: { iata_code: 'JFK' },
                  destination: { iata_code: 'LHR' },
                },
              ],
            },
          ],
          available_services: [
            {
              id: 'ase_empty_pax',
              type: 'baggage',
              passenger_ids: [],
              segment_ids: ['seg_1'],
              total_amount: '30.00',
              total_currency: 'USD',
              metadata: { type: 'checked', weight: 23, weight_unit: 'kg' },
            },
            {
              id: 'ase_valid_pax',
              type: 'baggage',
              passenger_ids: ['pas_adult_1'],
              segment_ids: ['seg_1'],
              total_amount: '30.00',
              total_currency: 'USD',
              metadata: { type: 'checked', weight: 23, weight_unit: 'kg' },
            },
          ],
        },
      };

      mockOffersGet.mockResolvedValue(offerWithInvalidBaggage);
      mockSeatMapsGet.mockResolvedValue({ data: [] });

      const catalog = await service.getSeatMapsAndServices(offerId);

      expect(catalog.baggageServices).toHaveLength(1);
      expect(catalog.baggageServices[0].serviceId).toBe('ase_valid_pax');
    });

    it('normalizes non-seat elements (galley, lavatory, empty) retaining only element type', async () => {
      mockCacheService.getTtl.mockResolvedValue(-2);
      const offerWithSegments = {
        data: {
          id: offerId,
          slices: [
            {
              id: 'sli_1',
              segments: [
                {
                  id: 'seg_1',
                  origin: { iata_code: 'JFK' },
                  destination: { iata_code: 'LHR' },
                },
              ],
            },
          ],
          available_services: [],
        },
      };

      const seatMapWithFacilities = {
        data: [
          {
            id: 'smp_facilities',
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
                          { type: 'galley' },
                          { type: 'lavatory' },
                          { type: 'empty' },
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

      mockOffersGet.mockResolvedValue(offerWithSegments);
      mockSeatMapsGet.mockResolvedValue(seatMapWithFacilities);

      const catalog = await service.getSeatMapsAndServices(offerId);

      const elements = catalog.segments[0].seatMap?.cabins[0].rows[0].elements;
      expect(elements).toEqual([
        { type: 'galley' },
        { type: 'lavatory' },
        { type: 'empty' },
      ]);
    });

    it('ignores available services that are not of type baggage (e.g. meal or lounge)', async () => {
      mockCacheService.getTtl.mockResolvedValue(-2);
      const offerWithNonBaggage = {
        data: {
          id: offerId,
          slices: [],
          available_services: [
            {
              id: 'ase_meal_1',
              type: 'meal',
              passenger_ids: ['pas_adult_1'],
              segment_ids: ['seg_1'],
              total_amount: '15.00',
              total_currency: 'USD',
            },
          ],
        },
      };

      mockOffersGet.mockResolvedValue(offerWithNonBaggage);
      mockSeatMapsGet.mockResolvedValue({ data: [] });

      const catalog = await service.getSeatMapsAndServices(offerId);

      expect(catalog.baggageServices).toEqual([]);
    });

    it('defaults baggage weight to null and maxQuantity to 1 when metadata omits them', async () => {
      mockCacheService.getTtl.mockResolvedValue(-2);
      const offerWithSparseBaggage = {
        data: {
          id: offerId,
          slices: [],
          available_services: [
            {
              id: 'ase_bag_sparse',
              type: 'baggage',
              passenger_ids: ['pas_adult_1'],
              segment_ids: ['seg_1'],
              total_amount: '25.00',
              total_currency: 'USD',
              metadata: {
                type: 'checked',
              },
            },
          ],
        },
      };

      mockOffersGet.mockResolvedValue(offerWithSparseBaggage);
      mockSeatMapsGet.mockResolvedValue({ data: [] });

      const catalog = await service.getSeatMapsAndServices(offerId);

      expect(catalog.baggageServices).toHaveLength(1);
      expect(catalog.baggageServices[0]).toEqual({
        serviceId: 'ase_bag_sparse',
        passengerId: 'pas_adult_1',
        segmentIds: ['seg_1'],
        type: 'checked',
        weightValue: null,
        weightUnit: null,
        maxQuantity: 1,
        amount: '25.00',
        currency: 'USD',
      });
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

    it('aggregates quantities across multiple passenger selections for shared services', async () => {
      // 3 passengers selecting the same baggage service, and 2 distinct seat services
      const multiPassengerServices = [
        { serviceId: 'ase_shared_bag_1', quantity: 1 }, // Passenger 1
        { serviceId: 'ase_shared_bag_1', quantity: 2 }, // Passenger 2 (2 bags)
        { serviceId: 'ase_shared_bag_1', quantity: 1 }, // Passenger 3
        { serviceId: 'ase_seat_12a', quantity: 1 },     // Passenger 1 seat
        { serviceId: 'ase_seat_12b', quantity: 1 },     // Passenger 2 seat
      ];

      const mockPricedOffer = {
        data: {
          id: offerId,
          total_amount: '620.00',
          total_currency: 'USD',
          base_amount: '450.00',
          base_currency: 'USD',
          service_lines: [
            {
              id: 'line_bag',
              total_amount: '120.00',
              total_currency: 'USD',
              quantity: 4,
              service_id: 'ase_shared_bag_1',
            },
            {
              id: 'line_seat_a',
              total_amount: '25.00',
              total_currency: 'USD',
              quantity: 1,
              service_id: 'ase_seat_12a',
            },
            {
              id: 'line_seat_b',
              total_amount: '25.00',
              total_currency: 'USD',
              quantity: 1,
              service_id: 'ase_seat_12b',
            },
          ],
        },
      };

      mockOffersGetPriced.mockResolvedValue(mockPricedOffer);

      const result = await service.repriceOffer(offerId, multiPassengerServices);

      expect(mockOffersGetPriced).toHaveBeenCalledWith(offerId, {
        intended_payment_methods: [{ type: 'card', card_id: 'mock_card' }],
        intended_services: [
          { id: 'ase_shared_bag_1', quantity: 4 },
          { id: 'ase_seat_12a', quantity: 1 },
          { id: 'ase_seat_12b', quantity: 1 },
        ],
      });

      expect(result.serviceLines).toHaveLength(3);
      expect(result.totalAmount).toBe('620.00');
      expect(result.baseAmount).toBe('450.00');
    });

    it('rethrows unexpected upstream errors (such as 500 internal server error)', async () => {
      const intendedServices = [{ serviceId: 'ase_bag_1', quantity: 1 }];
      const serverError = new Error('Upstream 500 Internal Server Error');
      mockOffersGetPriced.mockRejectedValue(serverError);

      await expect(service.repriceOffer(offerId, intendedServices)).rejects.toThrow(
        'Upstream 500 Internal Server Error',
      );
    });

    it('falls back to all intended services when upstream 400 error does not mention specific service IDs', async () => {
      const intendedServices = [
        { serviceId: 'ase_bag_1', quantity: 1 },
        { serviceId: 'ase_seat_1', quantity: 1 },
      ];

      const upstreamError = {
        status: 400,
        message: 'The requested services are no longer available for this offer.',
        errors: [
          {
            message: 'Services unavailable',
            code: 'services_unavailable',
          },
        ],
      };

      mockOffersGetPriced.mockRejectedValue(upstreamError);

      const result = await service.repriceOffer(offerId, intendedServices);

      expect(result.invalidServiceIdentities).toEqual(['ase_bag_1', 'ase_seat_1']);
      expect(result.totalAmount).toBe('0.00');
    });

    it('throws UPSTREAM_RATE_LIMITED (429) when repricing is rate limited by supplier', async () => {
      const intendedServices = [{ serviceId: 'ase_bag_1', quantity: 1 }];
      mockOffersGetPriced.mockRejectedValue({ status: 429, message: 'Duffel API rate limit exceeded' });

      await expect(service.repriceOffer(offerId, intendedServices)).rejects.toMatchObject({
        response: {
          code: 'UPSTREAM_RATE_LIMITED',
          message: 'Duffel API rate limit exceeded',
        },
        status: HttpStatus.TOO_MANY_REQUESTS,
      });
    });

    it('handles empty intended services array returning base amounts with zero service lines', async () => {
      mockOffersGetPriced.mockResolvedValue({
        data: {
          id: offerId,
          total_amount: '420.00',
          total_currency: 'USD',
          base_amount: '420.00',
          base_currency: 'USD',
          service_lines: [],
        },
      });

      const result = await service.repriceOffer(offerId, []);

      expect(mockOffersGetPriced).toHaveBeenCalledWith(offerId, {
        intended_payment_methods: [{ type: 'card', card_id: 'mock_card' }],
        intended_services: [],
      });
      expect(result).toEqual({
        totalAmount: '420.00',
        baseAmount: '420.00',
        currency: 'USD',
        serviceLines: [],
        invalidServiceIdentities: [],
      });
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

      const order = await service.createOrder(
        offerId,
        mockPassengers,
        services,
        { some: 'meta' },
        'idem_123',
      );

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

      const order = await service.createOrder(
        offerId,
        mockPassengers,
        { some: 'meta' },
        'idem_123',
      );

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
