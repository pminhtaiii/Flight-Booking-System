import { Global, Module } from '@nestjs/common';
import { StripeService } from './stripe.service';
import { StripePaymentAdapter } from './stripe-payment.adapter';
import { PAYMENT_GATEWAY_PORT } from '@/payment-fulfillment/ports';

@Global()
@Module({
  providers: [
    StripeService,
    StripePaymentAdapter,
    {
      provide: PAYMENT_GATEWAY_PORT,
      useClass: StripePaymentAdapter,
    },
  ],
  exports: [StripeService, StripePaymentAdapter, PAYMENT_GATEWAY_PORT],
})
export class StripeModule {}
