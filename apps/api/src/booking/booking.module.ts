import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';
import { PaymentModule } from '@/payment/payment.module';
import { DuffelModule } from '@/duffel/duffel.module';
import { AgentGatewayModule } from '@/agent-gateway/agent-gateway.module';
import { BookingManagementModule } from '@/booking-management/booking-management.module';
import { BookingLifecycleModule } from '@/booking-lifecycle/booking-lifecycle.module';
import { CancellationModule } from '@/cancellation/cancellation.module';

@Module({
  imports: [
    PrismaModule,
    DuffelModule,
    forwardRef(() => PaymentModule),
    forwardRef(() => AgentGatewayModule),
    BookingManagementModule,
    BookingLifecycleModule,
    CancellationModule,
  ],
  controllers: [BookingController],
  providers: [BookingService],
  exports: [BookingService],
})
export class BookingModule {}


