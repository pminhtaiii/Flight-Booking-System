import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';
import { PaymentModule } from '../payment/payment.module';
import { DuffelModule } from '../duffel/duffel.module';

@Module({
  imports: [PrismaModule, DuffelModule, forwardRef(() => PaymentModule)],
  controllers: [BookingController],
  providers: [BookingService],
  exports: [BookingService],
})
export class BookingModule {}
