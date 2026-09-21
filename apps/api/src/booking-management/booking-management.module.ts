import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { BookingStateModule } from '@/booking-lifecycle/booking-state.module';
import { BookingManagementService } from './booking-management.service';
import { BookingManagementController } from './booking-management.controller';

@Module({
  imports: [PrismaModule, BookingStateModule],
  controllers: [BookingManagementController],
  providers: [BookingManagementService],
  exports: [BookingManagementService],
})
export class BookingManagementModule {}
