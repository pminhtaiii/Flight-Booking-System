import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { DomainEventsModule } from '@/domain-events/domain-events.module';
import { BookingEventHydratorService } from '@/domain-events/booking-event-hydrator.service';
import { BookingProjectionService } from './booking-projection.service';
import { BookingProjectionRepository } from './booking-projection.repository';
import { BookingProjectionListener } from './booking-projection.listener';
import { BookingProjectionMetrics } from './booking-projection.metrics';
import { BookingProjectionReconciliationService } from './booking-projection-reconciliation.service';

@Module({
  imports: [PrismaModule, DomainEventsModule],
  providers: [
    BookingEventHydratorService,
    BookingProjectionService,
    BookingProjectionRepository,
    BookingProjectionListener,
    BookingProjectionMetrics,
    BookingProjectionReconciliationService,
  ],
  exports: [
    BookingProjectionService,
    BookingProjectionRepository,
    BookingEventHydratorService,
    BookingProjectionReconciliationService,
    BookingProjectionMetrics,
  ],
})
export class BookingProjectionModule {}
