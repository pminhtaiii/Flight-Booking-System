import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CacheModule } from '@/cache/cache.module';
import { PrismaModule } from '@/prisma/prisma.module';
import { DuffelCoreModule } from '@/supplier/core/duffel-core.module';
import { SupplierOrderModule } from '@/supplier/order/supplier-order.module';
import { DuffelService } from './duffel.service';
import { DuffelCleanupService } from './duffel-cleanup.service';

/**
 * DuffelModule provides legacy Duffel integration services.
 * Note: Offer cleanup cron (@Cron) has been relocated to FlightOfferCleanupService in SupplierSearchModule (T020).
 * DuffelCleanupService remains registered here for backwards-compatibility until T042 monolith deletion.
 */
@Module({
  imports: [ConfigModule, CacheModule, PrismaModule, DuffelCoreModule, SupplierOrderModule],
  providers: [DuffelService, DuffelCleanupService],
  exports: [DuffelService, SupplierOrderModule],
})
export class DuffelModule {}
