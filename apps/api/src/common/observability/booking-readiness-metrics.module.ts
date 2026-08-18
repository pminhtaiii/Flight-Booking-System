import { Global, Module } from '@nestjs/common';
import { BookingReadinessMetricsService } from './booking-readiness.metrics';
import { CacheModule } from '@/cache/cache.module';
import { PrismaModule } from '@/prisma/prisma.module';

@Global()
@Module({
  imports: [CacheModule, PrismaModule],
  providers: [BookingReadinessMetricsService],
  exports: [BookingReadinessMetricsService],
})
export class BookingReadinessMetricsModule {}
