import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { CacheModule } from '@/cache/cache.module';
import { PrismaModule } from '@/prisma/prisma.module';
import { DuffelCoreModule } from '../core/duffel-core.module';
import { FLIGHT_SEARCH_PORT } from './flight-search.port';
import { DuffelSearchService } from './duffel-search.service';
import { DuffelSearchAdapter } from './duffel-search.adapter';
import { FlightOfferNormalizer } from './flight-offer.normalizer';
import { FlightOfferCleanupService } from './flight-offer-cleanup.service';

@Module({
  imports: [ConfigModule, CacheModule, PrismaModule, DuffelCoreModule, ScheduleModule],
  providers: [
    DuffelSearchService,
    DuffelSearchAdapter,
    FlightOfferNormalizer,
    FlightOfferCleanupService,
    {
      provide: FLIGHT_SEARCH_PORT,
      useExisting: DuffelSearchService,
    },
  ],
  exports: [FLIGHT_SEARCH_PORT],
})
export class SupplierSearchModule {}
