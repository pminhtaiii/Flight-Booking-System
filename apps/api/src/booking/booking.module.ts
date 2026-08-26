import { Module } from '@nestjs/common';
import { BookingController } from './booking.controller';
import { BookingManagementModule } from '@/booking-management/booking-management.module';
import { BookingLifecycleModule } from '@/booking-lifecycle/booking-lifecycle.module';
import { CancellationModule } from '@/cancellation/cancellation.module';

@Module({
  imports: [
    BookingManagementModule,
    BookingLifecycleModule,
    CancellationModule,
  ],
  controllers: [BookingController],
  providers: [],
  exports: [],
})
export class BookingModule {}


