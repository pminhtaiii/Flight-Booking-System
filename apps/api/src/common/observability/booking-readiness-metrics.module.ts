import { Global, Module } from '@nestjs/common';
import { BookingReadinessMetricsService } from './booking-readiness.metrics';

@Global()
@Module({
  providers: [BookingReadinessMetricsService],
  exports: [BookingReadinessMetricsService],
})
export class BookingReadinessMetricsModule {}
