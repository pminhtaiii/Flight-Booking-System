import { Module } from '@nestjs/common';
import { FlightsController } from './flights.controller';
import { FlightsService } from './flights.service';
import { FlightSearchOrchestratorService } from './flight-search-orchestrator.service';
import { PrismaModule } from '../prisma/prisma.module';
import { CacheModule } from '../cache/cache.module';
import { SupplierSearchModule } from '../supplier/search/supplier-search.module';
import { AuditModule } from '../audit/audit.module';
import { FlightMatchModule } from '../flight-match/flight-match.module';
import { ProfileModule } from '../profile/profile.module';

@Module({
  imports: [
    PrismaModule,
    CacheModule,
    SupplierSearchModule,
    AuditModule,
    FlightMatchModule,
    ProfileModule,
  ],
  controllers: [FlightsController],
  providers: [FlightsService, FlightSearchOrchestratorService],
  exports: [FlightsService, FlightSearchOrchestratorService],
})
export class FlightsModule {}
