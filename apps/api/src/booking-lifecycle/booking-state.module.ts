import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { DomainEventsModule } from '@/domain-events/domain-events.module';
import { BookingLifecycleService } from './booking-lifecycle.service';

/**
 * BookingStateModule
 *
 * Isolated module providing and exporting BookingLifecycleService.
 * Extracted from BookingLifecycleModule to enable downstream consumers
 * (such as refund-settlement, cancellation, and disruption) to interact
 * with booking state transitions without introducing circular dependencies.
 */
@Module({
  imports: [PrismaModule, DomainEventsModule],
  providers: [BookingLifecycleService],
  exports: [BookingLifecycleService],
})
export class BookingStateModule {}
