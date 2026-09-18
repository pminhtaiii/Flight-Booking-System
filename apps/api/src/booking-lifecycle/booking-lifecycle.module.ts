import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '@/prisma/prisma.module';
import { DuffelModule } from '@/duffel/duffel.module';
import { RefundModule } from '@/refund/refund.module';
import { RefundSettlementModule } from '@/refund-settlement/refund-settlement.module';
import { StripeModule } from '@/common/stripe.module';
import { BookingStateModule } from './booking-state.module';
import { BookingRecoveryService } from './booking-recovery.service';
import { DomainEventsModule } from '@/domain-events/domain-events.module';

@Module({
  imports: [
    BookingStateModule,
    PrismaModule,
    DuffelModule,
    RefundModule,
    RefundSettlementModule,
    ScheduleModule,
    StripeModule,
    DomainEventsModule,
  ],
  providers: [BookingRecoveryService],
  exports: [BookingStateModule, BookingRecoveryService],
})
export class BookingLifecycleModule {}
