import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { BookingLifecycleModule } from '@/booking-lifecycle/booking-lifecycle.module';
import { BookingManagementService } from './booking-management.service';
import { BookingManagementController } from './booking-management.controller';

@Module({
  imports: [PrismaModule, BookingLifecycleModule],
  controllers: [BookingManagementController],
  providers: [BookingManagementService],
  exports: [BookingManagementService],
})
export class BookingManagementModule {}
