import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { AgentHealthService } from './agent-health.service';
import { PrismaModule } from '@/prisma/prisma.module';
import { CacheModule } from '@/cache/cache.module';
import { DisruptionModule } from '@/disruption/disruption.module';
import { BookingProjectionModule } from '@/booking-projection/booking-projection.module';

@Module({
  imports: [
    PrismaModule,
    CacheModule,
    DisruptionModule,
    BookingProjectionModule,
  ],
  controllers: [HealthController],
  providers: [AgentHealthService],
  exports: [AgentHealthService],
})
export class HealthModule {}
