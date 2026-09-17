import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { DomainEventsModule } from '@/domain-events/domain-events.module';
import { BookingEventHydratorService } from '@/domain-events/booking-event-hydrator.service';
import { BookingProjectionService } from './booking-projection.service';
import { BookingProjectionRepository } from './booking-projection.repository';
import { BookingProjectionListener } from './booking-projection.listener';
import { BookingProjectionMetrics } from './booking-projection.metrics';

@Module({
  imports: [PrismaModule, DomainEventsModule],
  providers: [
    BookingEventHydratorService,
    BookingProjectionService,
    BookingProjectionRepository,
    BookingProjectionListener,
    BookingProjectionMetrics,
  ],
  exports: [
    BookingProjectionService,
    BookingProjectionRepository,
    BookingEventHydratorService,
  ],
})
export class BookingProjectionModule {}
