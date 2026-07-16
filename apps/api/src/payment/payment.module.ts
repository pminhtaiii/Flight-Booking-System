import { Module } from '@nestjs/common';
import { StripeService } from '../common/stripe.service';
import { PaymentIdempotencyService } from './payment-idempotency.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [StripeService, PaymentIdempotencyService],
  exports: [StripeService, PaymentIdempotencyService],
})
export class PaymentModule {}
