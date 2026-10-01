import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CacheModule } from '@/cache/cache.module';
import { DuffelCoreModule } from '@/supplier/core/duffel-core.module';
import { DuffelAncillaryAdapter } from './duffel-ancillary.adapter';
import { AncillaryNormalizer } from './ancillary.normalizer';
import { DuffelAncillaryService } from './duffel-ancillary.service';

@Module({
  imports: [ConfigModule, CacheModule, DuffelCoreModule],
  providers: [DuffelAncillaryService, DuffelAncillaryAdapter, AncillaryNormalizer],
  exports: [DuffelAncillaryService],
})
export class SupplierAncillaryModule {}
