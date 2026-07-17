import { Module } from '@nestjs/common';
import { StripeService } from '../common/stripe.service';
import { PaymentIdempotencyService } from './payment-idempotency.service';
import { PrismaModule } from '../prisma/prisma.module';
import { PaymentService } from './payment.service';
import { PaymentRefundService } from './payment-refund.service';
import { PaymentController } from './payment.controller';
import { PaymentWebhookController } from './payment-webhook.controller';
import { PaymentWebhookService } from './payment-webhook.service';
import { DuffelModule } from '../duffel/duffel.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [PrismaModule, DuffelModule, AuditModule],
  controllers: [PaymentController, PaymentWebhookController],
  providers: [StripeService, PaymentIdempotencyService, PaymentService, PaymentRefundService, PaymentWebhookService],
  exports: [StripeService, PaymentIdempotencyService, PaymentService, PaymentRefundService, PaymentWebhookService],
})
export class PaymentModule {}
