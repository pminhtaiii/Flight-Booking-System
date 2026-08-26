import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '@/prisma/prisma.module';
import { AgentGatewayModule } from '@/agent-gateway/agent-gateway.module';
import { DuffelModule } from '@/duffel/duffel.module';
import { RefundModule } from '@/refund/refund.module';
import { RefundSettlementModule } from '@/refund-settlement/refund-settlement.module';
import { StripeModule } from '@/common/stripe.module';
import { BookingLifecycleService } from './booking-lifecycle.service';
import { BookingRecoveryService } from './booking-recovery.service';

@Module({
  imports: [
    PrismaModule,
    AgentGatewayModule,
    DuffelModule,
    RefundModule,
    RefundSettlementModule,
    ScheduleModule,
    StripeModule,
  ],
  providers: [BookingLifecycleService, BookingRecoveryService],
  exports: [BookingLifecycleService, BookingRecoveryService],
})
export class BookingLifecycleModule {}
