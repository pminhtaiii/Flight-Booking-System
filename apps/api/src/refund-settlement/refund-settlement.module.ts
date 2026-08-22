import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { AuditModule } from '@/audit/audit.module';
import { RefundSettlementService } from './refund-settlement.service';

@Module({
  imports: [PrismaModule, AuditModule],
  providers: [RefundSettlementService],
  exports: [RefundSettlementService],
})
export class RefundSettlementModule {}
