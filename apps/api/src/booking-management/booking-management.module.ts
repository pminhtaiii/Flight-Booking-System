import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { BookingLifecycleModule } from '@/booking-lifecycle/booking-lifecycle.module';
import { BookingManagementService } from './booking-management.service';

@Module({
  imports: [PrismaModule, BookingLifecycleModule],
  providers: [BookingManagementService],
  exports: [BookingManagementService],
})
export class BookingManagementModule {}
