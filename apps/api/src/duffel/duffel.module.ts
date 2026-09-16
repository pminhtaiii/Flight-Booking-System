import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CacheModule } from '@/cache/cache.module';
import { PrismaModule } from '@/prisma/prisma.module';
import { FULFILLMENT_GATEWAY_PORT } from '@/payment-fulfillment/ports';
import { DuffelService } from './duffel.service';
import { DuffelCleanupService } from './duffel-cleanup.service';
import { DuffelFulfillmentAdapter } from './duffel-fulfillment.adapter';

@Module({
  imports: [ConfigModule, CacheModule, PrismaModule],
  providers: [
    DuffelService,
    DuffelCleanupService,
    DuffelFulfillmentAdapter,
    {
      provide: FULFILLMENT_GATEWAY_PORT,
      useClass: DuffelFulfillmentAdapter,
    },
  ],
  exports: [DuffelService, DuffelFulfillmentAdapter, FULFILLMENT_GATEWAY_PORT],
})
export class DuffelModule {}

