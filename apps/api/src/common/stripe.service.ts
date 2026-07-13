import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;

  constructor(private readonly configService: ConfigService) {
    const secretKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    const webhookSecret = this.configService.get<string>('STRIPE_WEBHOOK_SECRET');

    if (!secretKey) {
      this.logger.error('STRIPE_SECRET_KEY is missing');
      throw new Error('STRIPE_SECRET_KEY is missing');
    }
    if (!webhookSecret) {
      this.logger.error('STRIPE_WEBHOOK_SECRET is missing');
      throw new Error('STRIPE_WEBHOOK_SECRET is missing');
    }

    this.webhookSecret = webhookSecret;

    this.stripe = new Stripe(secretKey, {
      apiVersion: '2024-04-10',
    });
  }

  async createPaymentIntent(params: {
    amount: number;
    currency: string;
    customerId?: string;
    metadata?: Record<string, string>;
    idempotencyKey: string;
    setupFutureUsage?: 'off_session';
    paymentMethodId?: string;
  }): Promise<Stripe.PaymentIntent> {
    const { amount, currency, customerId, metadata, idempotencyKey, setupFutureUsage, paymentMethodId } = params;

    const requestParams: Stripe.PaymentIntentCreateParams = {
      amount,
      currency,
      capture_method: 'manual',
    };

    if (customerId) {
      requestParams.customer = customerId;
    }
    if (metadata) {
      requestParams.metadata = metadata;
    }
    if (setupFutureUsage) {
      requestParams.setup_future_usage = setupFutureUsage;
    }
    if (paymentMethodId) {
      requestParams.payment_method = paymentMethodId;
      requestParams.confirm = true;
      requestParams.off_session = true;
    }

    return this.stripe.paymentIntents.create(requestParams, {
      idempotencyKey,
    });
  }

  async capturePaymentIntent(
    paymentIntentId: string,
    idempotencyKey: string
  ): Promise<Stripe.PaymentIntent> {
    return this.stripe.paymentIntents.capture(
      paymentIntentId,
      undefined,
      { idempotencyKey }
    );
  }

  async cancelPaymentIntent(
    paymentIntentId: string,
    idempotencyKey: string
  ): Promise<Stripe.PaymentIntent> {
    return this.stripe.paymentIntents.cancel(
      paymentIntentId,
      undefined,
      { idempotencyKey }
    );
  }

  async createCustomer(params: {
    email?: string;
    name?: string;
    metadata?: Record<string, string>;
    idempotencyKey: string;
  }): Promise<Stripe.Customer> {
    const { email, name, metadata, idempotencyKey } = params;
    return this.stripe.customers.create(
      {
        email,
        name,
        metadata,
      },
      {
        idempotencyKey,
      }
    );
  }

  async retrievePaymentIntent(paymentIntentId: string): Promise<Stripe.PaymentIntent> {
    return this.stripe.paymentIntents.retrieve(paymentIntentId);
  }

  async retrievePaymentMethod(paymentMethodId: string): Promise<Stripe.PaymentMethod> {
    return this.stripe.paymentMethods.retrieve(paymentMethodId);
  }

  async detachPaymentMethod(paymentMethodId: string): Promise<Stripe.PaymentMethod> {
    return this.stripe.paymentMethods.detach(paymentMethodId);
  }

  async createRefund(params: {
    paymentIntentId: string;
    amount: number;
    reason?: Stripe.RefundCreateParams.Reason;
    idempotencyKey: string;
  }): Promise<Stripe.Refund> {
    const { paymentIntentId, amount, reason, idempotencyKey } = params;
    const refundParams: Stripe.RefundCreateParams = {
      payment_intent: paymentIntentId,
      amount,
    };
    if (reason) {
      refundParams.reason = reason;
    }
    return this.stripe.refunds.create(refundParams, {
      idempotencyKey,
    });
  }

  constructWebhookEvent(payload: string | Buffer, signature: string): Stripe.Event {
    return this.stripe.webhooks.constructEvent(payload, signature, this.webhookSecret);
  }
}
