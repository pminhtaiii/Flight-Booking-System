import { Module, forwardRef } from '@nestjs/common';
import { StripeService } from '../common/stripe.service';
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

@Module({
  imports: [PrismaModule, DuffelModule, AuditModule, forwardRef(() => BookingModule)],
  controllers: [PaymentController, PaymentWebhookController, AdminRefundController],
  providers: [
    StripeService,
    PaymentIdempotencyService,
    PaymentService,
    PaymentRefundService,
    PaymentMethodService,
    PaymentWebhookService,
    PaymentCronService,
    AncillaryPaymentValidationService,
  ],
  exports: [
    StripeService,
    PaymentIdempotencyService,
    PaymentService,
    PaymentRefundService,
    PaymentMethodService,
    PaymentWebhookService,
    AncillaryPaymentValidationService,
  ],
})
export class PaymentModule {}
