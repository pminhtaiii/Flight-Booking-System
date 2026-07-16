import { Module } from '@nestjs/common';
import { StripeService } from '../common/stripe.service';
import { PaymentIdempotencyService } from './payment-idempotency.service';
import { PrismaModule } from '../prisma/prisma.module';
import { PaymentService } from './payment.service';
import { PaymentController } from './payment.controller';
import { DuffelModule } from '../duffel/duffel.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [PrismaModule, DuffelModule, AuditModule],
  controllers: [PaymentController],
  providers: [StripeService, PaymentIdempotencyService, PaymentService],
  exports: [StripeService, PaymentIdempotencyService, PaymentService],
})
export class PaymentModule {}
