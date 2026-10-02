import { Test } from '@nestjs/testing';
import { CacheService } from '@/cache/cache.service';
import { FULFILLMENT_GATEWAY_PORT, FulfillmentGatewayPort } from '@/payment-fulfillment/ports';
import { DUFFEL_SDK, DUFFEL_SDK_CONFIGURATION } from '@/supplier/core/duffel-core.module';
import { DuffelCancellationService } from './duffel-cancellation.service';
import { DuffelFulfillmentAdapter } from './duffel-fulfillment.adapter';
import { DuffelRecoveryService } from './duffel-recovery.service';
import { SupplierOrderModule } from './supplier-order.module';

describe('SupplierOrderModule', () => {
  it('exports one gateway binding and the concrete cancellation and recovery capabilities', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [SupplierOrderModule] })
      .overrideProvider(DUFFEL_SDK)
      .useValue({ offers: { get: jest.fn() } })
      .overrideProvider(DUFFEL_SDK_CONFIGURATION)
      .useValue({ token: 'test-token', basePath: 'http://127.0.0.1:4010' })
      .overrideProvider(CacheService)
      .useValue({ checkAndIncrement: jest.fn() })
      .compile();

    try {
      const gateway = moduleRef.get<FulfillmentGatewayPort>(FULFILLMENT_GATEWAY_PORT);
      expect(gateway).toBe(moduleRef.get(DuffelFulfillmentAdapter, { strict: false }));
      expect(moduleRef.get(DuffelCancellationService)).toBeDefined();
      expect(moduleRef.get(DuffelRecoveryService)).toBeDefined();
    } finally {
      await moduleRef.close();
    }
  });
});
