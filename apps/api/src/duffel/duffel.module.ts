import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CacheModule } from '@/cache/cache.module';
import { PrismaModule } from '@/prisma/prisma.module';
import { DuffelCoreModule } from '@/supplier/core/duffel-core.module';
import { FULFILLMENT_GATEWAY_PORT } from '@/payment-fulfillment/ports';
import { DuffelService } from './duffel.service';
import { DuffelCleanupService } from './duffel-cleanup.service';
import { DuffelFulfillmentAdapter } from './duffel-fulfillment.adapter';

/**
 * DuffelModule provides legacy Duffel integration services.
 * Note: Offer cleanup cron (@Cron) has been relocated to FlightOfferCleanupService in SupplierSearchModule (T020).
 * DuffelCleanupService remains registered here for backwards-compatibility until T042 monolith deletion.
 */
@Module({
  imports: [ConfigModule, CacheModule, PrismaModule, DuffelCoreModule],
  providers: [
    DuffelService,
    DuffelCleanupService,
    DuffelFulfillmentAdapter,
    {
      provide: FULFILLMENT_GATEWAY_PORT,
      useExisting: DuffelFulfillmentAdapter,
    },
  ],
  exports: [DuffelService, DuffelFulfillmentAdapter, FULFILLMENT_GATEWAY_PORT],
})
export class DuffelModule {}

