import { Module } from '@nestjs/common';
import { FlightsController } from './flights.controller';
import { FlightsService } from './flights.service';
import { PrismaModule } from '../prisma/prisma.module';
import { CacheModule } from '../cache/cache.module';
import { DuffelModule } from '../duffel/duffel.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [PrismaModule, CacheModule, DuffelModule, AuditModule],
  controllers: [FlightsController],
  providers: [FlightsService],
  exports: [FlightsService],
})
export class FlightsModule {}
