import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { AuditModule } from '@/audit/audit.module';
import { BookingStateModule } from '@/booking-lifecycle/booking-state.module';
import { DomainEventsModule } from '@/domain-events/domain-events.module';
import { RefundSettlementService } from './refund-settlement.service';

@Module({
  imports: [PrismaModule, AuditModule, BookingStateModule, DomainEventsModule],
  providers: [RefundSettlementService],
  exports: [RefundSettlementService],
})
export class RefundSettlementModule {}
