import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CacheModule } from '@/cache/cache.module';
import { FULFILLMENT_GATEWAY_PORT } from '@/payment-fulfillment/ports';
import { DuffelCoreModule } from '@/supplier/core/duffel-core.module';
import { DuffelCancellationService } from './duffel-cancellation.service';
import { DuffelFulfillmentAdapter } from './duffel-fulfillment.adapter';
import { DuffelOrderAdapter } from './duffel-order.adapter';
import { DuffelRecoveryService } from './duffel-recovery.service';
import { OrderSnapshotNormalizer } from './order-snapshot.normalizer';

@Module({
  imports: [ConfigModule, DuffelCoreModule, CacheModule],
  providers: [
    DuffelOrderAdapter,
    OrderSnapshotNormalizer,
    DuffelCancellationService,
    DuffelRecoveryService,
    DuffelFulfillmentAdapter,
    { provide: FULFILLMENT_GATEWAY_PORT, useExisting: DuffelFulfillmentAdapter },
  ],
  exports: [DuffelCancellationService, DuffelRecoveryService, FULFILLMENT_GATEWAY_PORT],
})
export class SupplierOrderModule {}
