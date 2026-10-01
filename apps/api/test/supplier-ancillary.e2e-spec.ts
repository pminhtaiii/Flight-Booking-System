import { Test } from '@nestjs/testing';
import { Duffel } from '@duffel/api';
import { CacheService } from '@/cache/cache.service';
import { DUFFEL_SDK } from '@/supplier/core/duffel-core.module';
import { DuffelAncillaryService } from '@/supplier/ancillary/duffel-ancillary.service';
import { SupplierAncillaryModule } from '@/supplier/ancillary/supplier-ancillary.module';

describe('Supplier ancillary capability (E2E)', () => {
  it('runs cache, missing-seat-map, and authoritative repricing flows through the module', async () => {
    const entries = new Map<string, { value: string; expiresAt: number }>();
    const budgets = new Map<string, number>();
    const cache = {
      get: jest.fn(async (key: string) => {
        const entry = entries.get(key);
        if (!entry || entry.expiresAt <= Date.now()) {
          entries.delete(key);
          return null;
        }
        return entry.value;
      }),
      getTtl: jest.fn(async (key: string) => {
        const entry = entries.get(key);
        return entry ? Math.ceil((entry.expiresAt - Date.now()) / 1000) : -2;
      }),
      set: jest.fn(async (key: string, value: string, ttlSeconds?: number) => {
        entries.set(key, {
          value,
          expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : Number.POSITIVE_INFINITY,
        });
      }),
      checkAndIncrement: jest.fn(async (primary: { key: string; limit: number }) => {
        const current = budgets.get(primary.key) ?? 0;
        if (current >= primary.limit) {
          return { allowed: false, current };
        }
        const next = current + 1;
        budgets.set(primary.key, next);
        return { allowed: true, current: next };
      }),
    };
    const rawOffer = {
      slices: [
        {
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
          metadata: { type: 'checked', weight: 23, weight_unit: 'kg', maximum_quantity: 2 },
        },
      ],
    };
    const seatMapsGet = jest
      .fn<Promise<{ data: unknown }>, [{ offer_id: string }]>()
      .mockRejectedValueOnce({ meta: { status: 404 } })
      .mockResolvedValue({ data: [] });
    const offersGet = jest
      .fn<Promise<{ data: unknown }>, [string, { return_available_services: boolean }]>()
      .mockResolvedValue({ data: rawOffer });
    const offersGetPriced = jest
      .fn<
        Promise<{ data: unknown }>,
        [
          string,
          {
            intended_payment_methods: Array<{ type: 'card'; card_id: string }>;
            intended_services: Array<{ id: string; quantity: number }>;
          },
        ]
      >()
      .mockResolvedValue({
        data: {
          total_amount: '465.00',
          base_amount: '420.00',
          total_currency: 'USD',
          service_lines: [{ service_id: 'ase_bag_1', total_amount: '45.00', quantity: 3 }],
        },
      });
    // The capability uses this SDK subset; the actual adapter remains behind the boundary override.
    const sdk = {
      seatMaps: { get: seatMapsGet },
      offers: { get: offersGet, getPriced: offersGetPriced },
    } as unknown as Duffel;
    const module = await Test.createTestingModule({ imports: [SupplierAncillaryModule] })
      .overrideProvider(DUFFEL_SDK)
      .useValue(sdk)
      .overrideProvider(CacheService)
      .useValue(cache)
      .compile();

    try {
      const service = module.get(DuffelAncillaryService);
      const miss = await service.getSeatMapsAndServices('off_123');
      expect(miss.cache.status).toBe('MISS');
      expect(miss.segments[0].seatMapAvailable).toBe(false);
      expect(miss.baggageServices[0]).toMatchObject({
        serviceId: 'ase_bag_1',
        passengerId: 'pas_1',
        amount: '30.00',
      });

      const hit = await service.getSeatMapsAndServices('off_123');
      expect(hit.cache.status).toBe('HIT');
      expect(seatMapsGet).toHaveBeenCalledTimes(1);
      expect(offersGet).toHaveBeenCalledTimes(1);

      const refreshed = await service.getSeatMapsAndServices('off_123', true);
      expect(refreshed.cache.status).toBe('MISS');
      expect(seatMapsGet).toHaveBeenCalledTimes(2);
      expect(offersGet).toHaveBeenCalledTimes(2);

      const repriced = await service.repriceOffer('off_123', [
        { serviceId: 'ase_bag_1', quantity: 1 },
        { serviceId: 'ase_bag_1', quantity: 2 },
      ]);
      expect(offersGetPriced).toHaveBeenCalledWith('off_123', {
        intended_payment_methods: [{ type: 'card', card_id: 'mock_card' }],
        intended_services: [{ id: 'ase_bag_1', quantity: 3 }],
      });
      expect(repriced.totalAmount).toBe('465.00');
      expect(cache.checkAndIncrement).toHaveBeenCalledTimes(5);
    } finally {
      await module.close();
    }
  });
});
