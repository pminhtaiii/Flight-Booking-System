import { Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';

@Injectable()
export class StripeService {
  private readonly stripe: Stripe;
  private readonly logger = new Logger(StripeService.name);

  constructor() {
    const apiKey = process.env.STRIPE_SECRET_KEY;
    if (!apiKey) {
      this.logger.error('STRIPE_SECRET_KEY environment variable is not defined');
      throw new Error('STRIPE_SECRET_KEY is missing');
    }
    if (apiKey.startsWith('sk_')) {
      this.logger.warn(
        'Stripe secret key (sk_) detected. It is highly recommended to use a restricted API key (rk_) with minimum scopes for security.',
      );
    }
    // Instantiate Stripe. We cast the apiVersion as StripeConfig['apiVersion'] to satisfy typing.
    this.stripe = new Stripe(apiKey, {
      apiVersion: '2026-05-27.dahlia' as Stripe.StripeConfig['apiVersion'],
    });
  }

  async createPaymentIntent(
    amount: number,
    currency: string,
    customerId?: string,
    metadata?: Record<string, string>,
    idempotencyKey?: string,
    paymentMethodId?: string,
    setupFutureUsage?: 'off_session' | 'on_session',
  ): Promise<Stripe.PaymentIntent> {
    const params: Stripe.PaymentIntentCreateParams = {
      amount,
      currency: currency.toLowerCase(),
      capture_method: 'manual',
      metadata,
    };

    if (customerId) {
      params.customer = customerId;
    }

    if (paymentMethodId) {
      params.payment_method = paymentMethodId;
    }

    if (setupFutureUsage) {
      params.setup_future_usage = setupFutureUsage;
    }

    const options: Stripe.RequestOptions = {};
    if (idempotencyKey) {
      options.idempotencyKey = idempotencyKey;
    }

    try {
      return await this.stripe.paymentIntents.create(params, options);
    } catch (error) {
      const err = error as Error;
      this.logger.error(`Failed to create PaymentIntent: ${err.message}`, err.stack);
      throw error;
    }
  }

  async capturePaymentIntent(
    paymentIntentId: string,
    amount?: number,
    idempotencyKey?: string,
  ): Promise<Stripe.PaymentIntent> {
    const params: Stripe.PaymentIntentCaptureParams = {};
    if (amount !== undefined) {
      params.amount_to_capture = amount;
    }

    const options: Stripe.RequestOptions = {};
    if (idempotencyKey) {
      options.idempotencyKey = idempotencyKey;
    }

    try {
      return await this.stripe.paymentIntents.capture(paymentIntentId, params, options);
    } catch (error) {
      const err = error as Error;
      this.logger.error(`Failed to capture PaymentIntent ${paymentIntentId}: ${err.message}`, err.stack);
      throw error;
    }
  }

  async cancelPaymentIntent(
    paymentIntentId: string,
    idempotencyKey?: string,
  ): Promise<Stripe.PaymentIntent> {
    const options: Stripe.RequestOptions = {};
    if (idempotencyKey) {
      options.idempotencyKey = idempotencyKey;
    }

    try {
      return await this.stripe.paymentIntents.cancel(paymentIntentId, options);
    } catch (error) {
      const err = error as Error;
      this.logger.error(`Failed to cancel PaymentIntent ${paymentIntentId}: ${err.message}`, err.stack);
      throw error;
    }
  }

  async createCustomer(
    email: string,
    name?: string,
    idempotencyKey?: string,
  ): Promise<Stripe.Customer> {
    const params: Stripe.CustomerCreateParams = {
      email,
    };
    if (name) {
      params.name = name;
    }

    const options: Stripe.RequestOptions = {};
    if (idempotencyKey) {
      options.idempotencyKey = idempotencyKey;
    }

    try {
      return await this.stripe.customers.create(params, options);
    } catch (error) {
      const err = error as Error;
      this.logger.error(`Failed to create Stripe Customer for ${email}: ${err.message}`, err.stack);
      throw error;
    }
  }

  async retrievePaymentIntent(paymentIntentId: string): Promise<Stripe.PaymentIntent> {
    try {
      return await this.stripe.paymentIntents.retrieve(paymentIntentId);
    } catch (error) {
      const err = error as Error;
      this.logger.error(`Failed to retrieve PaymentIntent ${paymentIntentId}: ${err.message}`, err.stack);
      throw error;
    }
  }

  async createRefund(
    paymentIntentId: string,
    amount?: number,
    reason?: string,
    idempotencyKey?: string,
  ): Promise<Stripe.Refund> {
    const params: Stripe.RefundCreateParams = {
      payment_intent: paymentIntentId,
    };
    if (amount !== undefined) {
      params.amount = amount;
    }
    if (reason) {
      params.reason = reason as Stripe.RefundCreateParams.Reason;
    }

    const options: Stripe.RequestOptions = {};
    if (idempotencyKey) {
      options.idempotencyKey = idempotencyKey;
    }

    try {
      return await this.stripe.refunds.create(params, options);
    } catch (error) {
      const err = error as Error;
      this.logger.error(`Failed to create refund for PaymentIntent ${paymentIntentId}: ${err.message}`, err.stack);
      throw error;
    }
  }

  constructWebhookEvent(
    payload: string | Buffer,
    header: string,
    secret: string,
  ): Stripe.Event {
    try {
      return this.stripe.webhooks.constructEvent(payload, header, secret);
    } catch (error) {
      const err = error as Error;
      this.logger.error(`Webhook signature verification failed: ${err.message}`, err.stack);
      throw error;
    }
  }
}
