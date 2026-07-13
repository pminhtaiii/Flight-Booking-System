import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { DuffelModule } from '@/duffel/duffel.module';
import { AuditModule } from '@/audit/audit.module';
import { EncryptionService } from '@/common/encryption.service';
import { StripeService } from '@/common/stripe.service';
import { PaymentController } from './payment.controller';
import { PaymentWebhookController } from './payment-webhook.controller';
import { PaymentService } from './payment.service';
import { PaymentWebhookService } from './payment-webhook.service';
import { PaymentIdempotencyService } from './payment-idempotency.service';
import { PaymentLedgerService } from './payment-ledger.service';
import { PaymentMethodService } from './payment-method.service';
import { PaymentRefundService } from './payment-refund.service';
import { PaymentCronService } from './payment-cron.service';

@Module({
  imports: [PrismaModule, DuffelModule, AuditModule],
  controllers: [PaymentController, PaymentWebhookController],
  providers: [
    PaymentService,
    PaymentWebhookService,
    PaymentIdempotencyService,
    PaymentLedgerService,
    PaymentMethodService,
    PaymentRefundService,
    PaymentCronService,
    StripeService,
    EncryptionService,
  ],
  exports: [PaymentService, StripeService, PaymentMethodService, PaymentRefundService, PaymentCronService],
})
export class PaymentModule {}
