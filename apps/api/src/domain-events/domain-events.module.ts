import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { BookingEventPublisherService } from './booking-event-publisher.service';
import { BookingEventHydratorService } from './booking-event-hydrator.service';

/**
 * DomainEventsModule
 *
 * Provides and exports BookingEventPublisherService and BookingEventHydratorService.
 * Works cleanly with optional EventEmitter2 injection before
 * root EventEmitterModule is registered.
 */
@Module({
  imports: [PrismaModule],
  providers: [BookingEventPublisherService, BookingEventHydratorService],
  exports: [BookingEventPublisherService, BookingEventHydratorService],
})
export class DomainEventsModule {}
