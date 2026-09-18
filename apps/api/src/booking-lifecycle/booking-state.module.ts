import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { DomainEventsModule } from '@/domain-events/domain-events.module';
import { BookingLifecycleService } from './booking-lifecycle.service';

@Module({
  imports: [PrismaModule, DomainEventsModule],
  providers: [BookingLifecycleService],
  exports: [BookingLifecycleService],
})
export class BookingStateModule {}
