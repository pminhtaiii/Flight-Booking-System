import { Module, forwardRef } from '@nestjs/common';
import { PaymentIdempotencyService } from './payment-idempotency.service';
import { PrismaModule } from '../prisma/prisma.module';
import { PaymentService } from './payment.service';
import { PaymentRefundService } from './payment-refund.service';
import { PaymentMethodService } from './payment-method.service';
import { PaymentController } from './payment.controller';
import { PaymentWebhookController } from './payment-webhook.controller';
import { PaymentWebhookService } from './payment-webhook.service';
import { DuffelModule } from '../duffel/duffel.module';
import { AuditModule } from '../audit/audit.module';
import { PaymentCronService } from './payment-cron.service';
import { BookingModule } from '../booking/booking.module';
import { AdminRefundController } from './admin-refund.controller';
import { AncillaryPaymentValidationService } from './ancillary-payment-validation.service';
import { BookingIntentModule } from '../booking-intent/booking-intent.module';
import { RefundModule } from '../refund/refund.module';
import { RefundSettlementModule } from '../refund-settlement/refund-settlement.module';

@Module({
  imports: [
    PrismaModule,
    DuffelModule,
    AuditModule,
    RefundModule,
    RefundSettlementModule,
    forwardRef(() => BookingModule),
    forwardRef(() => BookingIntentModule),
  ],
  controllers: [PaymentController, PaymentWebhookController, AdminRefundController],
  providers: [
    PaymentIdempotencyService,
    PaymentService,
    PaymentRefundService,
    PaymentMethodService,
    PaymentWebhookService,
    PaymentCronService,
    AncillaryPaymentValidationService,
  ],
  exports: [
    PaymentIdempotencyService,
    PaymentService,
    PaymentRefundService,
    PaymentMethodService,
    PaymentWebhookService,
    AncillaryPaymentValidationService,
  ],
})
export class PaymentModule {}
