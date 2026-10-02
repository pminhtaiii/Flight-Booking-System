import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { Duffel } from '@duffel/api';
import { CacheService } from '@/cache/cache.service';
import { DUFFEL_SDK, DUFFEL_SDK_CONFIGURATION } from '@/supplier/core/duffel-core.module';
import { DuffelRateBudgetService } from '@/supplier/core/duffel-rate-budget.service';
import { DuffelAncillaryAdapter } from './duffel-ancillary.adapter';
import { AncillaryNormalizer } from './ancillary.normalizer';
import { DuffelAncillaryService } from './duffel-ancillary.service';
import { SupplierAncillaryModule } from './supplier-ancillary.module';

describe('SupplierAncillaryModule', () => {
  it('exports only the concrete ancillary service', () => {
    // Reflect metadata is untyped; narrow its result to the provider-list shape for this assertion.
    const exports = Reflect.getMetadata('exports', SupplierAncillaryModule) as unknown[];

    expect(exports).toEqual([DuffelAncillaryService]);
    expect(exports).not.toContain(DuffelAncillaryAdapter);
    expect(exports).not.toContain(AncillaryNormalizer);
    expect(exports).not.toContain(DUFFEL_SDK);
    expect(exports).not.toContain(DuffelRateBudgetService);
  });

  it('resolves and exercises the service through the actual module', async () => {
    const cache = {
      get: jest.fn<Promise<string | null>, [string]>().mockResolvedValue(null),
      getTtl: jest.fn<Promise<number>, [string]>().mockResolvedValue(-2),
      set: jest.fn<Promise<void>, [string, string, number?]>().mockResolvedValue(undefined),
      checkAndIncrement: jest
        .fn<
          Promise<{ allowed: boolean; current: number; storeError?: boolean }>,
          [
            { key: string; limit: number; ttlSeconds: number },
            { key: string; limit: number; ttlSeconds: number }?,
          ]
        >()
        .mockResolvedValue({ allowed: true, current: 1 }),
    };
    // This module test overrides the broad SDK surface while keeping real ancillary providers wired.
    const sdk = {
      seatMaps: {
        get: jest
          .fn<Promise<{ data: unknown }>, [{ offer_id: string }]>()
          .mockResolvedValue({ data: [] }),
      },
      offers: {
        get: jest
          .fn<Promise<{ data: unknown }>, [string, { return_available_services: boolean }]>()
          .mockResolvedValue({
            data: {
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
              available_services: [],
            },
          }),
        getPriced: jest.fn<Promise<{ data: unknown }>, [string, unknown]>(),
      },
    } as unknown as Duffel;
    const module = await Test.createTestingModule({ imports: [SupplierAncillaryModule] })
      .overrideProvider(DUFFEL_SDK)
      .useValue(sdk)
      // human2026-10-02 approval: keep module compilation independent of DUFFEL_ACCESS_TOKEN.
      .overrideProvider(DUFFEL_SDK_CONFIGURATION)
      .useValue({ token: 'duffel-test-token', basePath: 'http://127.0.0.1:4010' })
      .overrideProvider(CacheService)
      .useValue(cache)
      .compile();

    try {
      const service = module.get(DuffelAncillaryService);
      const catalog = await service.getSeatMapsAndServices('off_test', true);

      expect(catalog.segments[0]).toEqual({
        segmentId: 'seg_1',
        origin: 'SGN',
        destination: 'SIN',
        seatMapAvailable: false,
        seatMap: null,
      });
      expect(cache.checkAndIncrement).toHaveBeenCalledTimes(2);
    } finally {
      await module.close();
    }
  });
});
