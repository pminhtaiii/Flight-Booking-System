import { Module } from '@nestjs/common';
import { IdempotencyModule } from '@/idempotency/idempotency.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PaymentService } from './payment.service';
import { PaymentRefundService } from './payment-refund.service';
import { PaymentMethodsModule } from './payment-methods.module';
import { PaymentController } from './payment.controller';
import { PaymentWebhookController } from './payment-webhook.controller';
import { PaymentWebhookService } from './payment-webhook.service';
import { DuffelModule } from '../duffel/duffel.module';
import { AuditModule } from '../audit/audit.module';
import { PaymentCronService } from './payment-cron.service';
import { BookingLifecycleModule } from '../booking-lifecycle/booking-lifecycle.module';
import { AdminRefundController } from './admin-refund.controller';
import { AncillaryPaymentValidationService } from './ancillary-payment-validation.service';
import { BookingIntentModule } from '../booking-intent/booking-intent.module';
import { RefundModule } from '../refund/refund.module';
import { RefundSettlementModule } from '../refund-settlement/refund-settlement.module';
import { PaymentFulfillmentModule } from '@/payment-fulfillment/payment-fulfillment.module';

@Module({
  imports: [
    PrismaModule,
    DuffelModule,
    AuditModule,
    IdempotencyModule,
    RefundModule,
    RefundSettlementModule,
    BookingLifecycleModule,
    BookingIntentModule,
    PaymentMethodsModule,
    PaymentFulfillmentModule,
  ],
  controllers: [PaymentController, PaymentWebhookController, AdminRefundController],
  providers: [
    PaymentService,
    PaymentRefundService,
    PaymentWebhookService,
    PaymentCronService,
    AncillaryPaymentValidationService,
  ],
  exports: [
    IdempotencyModule,
    PaymentMethodsModule,
    PaymentService,
    PaymentRefundService,
    PaymentWebhookService,
    AncillaryPaymentValidationService,
  ],
})
export class PaymentModule {}

