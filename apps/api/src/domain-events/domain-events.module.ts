import { Module } from '@nestjs/common';
import { BookingEventPublisherService } from './booking-event-publisher.service';

/**
 * DomainEventsModule
 *
 * Provides and exports BookingEventPublisherService.
 * Works cleanly with optional EventEmitter2 injection before
 * root EventEmitterModule is registered.
 */
@Module({
  providers: [BookingEventPublisherService],
  exports: [BookingEventPublisherService],
})
export class DomainEventsModule {}
