import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { RefundTransactionService } from './refund-transaction.service';

@Module({
  imports: [PrismaModule],
  providers: [RefundTransactionService],
  exports: [RefundTransactionService],
})
export class RefundModule {}
