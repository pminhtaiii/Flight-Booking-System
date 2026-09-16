import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PaymentIdempotencyService } from './payment-idempotency.service';

@Module({
  imports: [PrismaModule],
  providers: [PaymentIdempotencyService],
  exports: [PaymentIdempotencyService],
})
export class IdempotencyModule {}
