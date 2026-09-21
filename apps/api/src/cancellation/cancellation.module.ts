import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { DuffelModule } from '@/duffel/duffel.module';
import { PaymentModule } from '@/payment/payment.module';
import { BookingStateModule } from '@/booking-lifecycle/booking-state.module';
import { DomainEventsModule } from '@/domain-events/domain-events.module';
import { CancellationService } from './cancellation.service';
import { CancellationController } from './cancellation.controller';

@Module({
  imports: [PrismaModule, DuffelModule, PaymentModule, BookingStateModule, DomainEventsModule],
  controllers: [CancellationController],
  providers: [CancellationService],
  exports: [CancellationService],
})
export class CancellationModule {}
