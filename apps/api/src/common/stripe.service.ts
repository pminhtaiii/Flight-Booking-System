import { Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

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
    const rawUrl = process.env.STRIPE_API_URL;
    if (rawUrl && rawUrl.trim() !== '') {
      let parsed: URL;
      try {
        parsed = new URL(rawUrl);
      } catch {
        this.logger.error(`Invalid STRIPE_API_URL provided`);
        throw new Error('Invalid STRIPE_API_URL');
      }

      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        this.logger.error(`Unsupported STRIPE_API_URL protocol: ${parsed.protocol}`);
        throw new Error(`Unsupported STRIPE_API_URL protocol: ${parsed.protocol}`);
      }

      const stripeConfig: Stripe.StripeConfig = {
        apiVersion: '2026-05-27.dahlia' as Stripe.StripeConfig['apiVersion'],
        protocol: parsed.protocol.replace(':', '') as 'http' | 'https',
        host: parsed.hostname,
      };

      if (parsed.port && parsed.port.trim() !== '') {
        stripeConfig.port = Number(parsed.port);
      }

      this.stripe = new Stripe(apiKey, stripeConfig);
    } else {
      // Instantiate Stripe. We cast the apiVersion as StripeConfig['apiVersion'] to satisfy typing.
      this.stripe = new Stripe(apiKey, {
        apiVersion: '2026-05-27.dahlia' as Stripe.StripeConfig['apiVersion'],
      });
    }
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
    if (!paymentIntentId || typeof paymentIntentId !== 'string' || paymentIntentId.trim() === '') {
      throw new Error('PaymentIntent ID is required');
    }

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
      this.logger.error(
        `Failed to capture PaymentIntent ${paymentIntentId}: ${err.message}`,
        err.stack,
      );
      throw error;
    }
  }

  async cancelPaymentIntent(
    paymentIntentId: string,
    idempotencyKey?: string,
  ): Promise<Stripe.PaymentIntent> {
    if (!paymentIntentId || typeof paymentIntentId !== 'string' || paymentIntentId.trim() === '') {
      throw new Error('PaymentIntent ID is required');
    }

    const options: Stripe.RequestOptions = {};
    if (idempotencyKey) {
      options.idempotencyKey = idempotencyKey;
    }

    try {
      return await this.stripe.paymentIntents.cancel(paymentIntentId, options);
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Failed to cancel PaymentIntent ${paymentIntentId}: ${err.message}`,
        err.stack,
      );
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
    if (!paymentIntentId || typeof paymentIntentId !== 'string' || paymentIntentId.trim() === '') {
      throw new Error('PaymentIntent ID is required');
    }

    try {
      return await this.stripe.paymentIntents.retrieve(paymentIntentId, {
        expand: ['payment_method', 'latest_charge'],
      });
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Failed to retrieve PaymentIntent ${paymentIntentId}: ${err.message}`,
        err.stack,
      );
      throw error;
    }
  }

  async createRefund(
    paymentIntentId: string,
    amount?: number,
    reason?: string,
    idempotencyKey?: string,
  ): Promise<Stripe.Refund> {
    if (!paymentIntentId || typeof paymentIntentId !== 'string' || paymentIntentId.trim() === '') {
      throw new Error('PaymentIntent ID is required');
    }

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
      this.logger.error(
        `Failed to create refund for PaymentIntent ${paymentIntentId}: ${err.message}`,
        err.stack,
      );
      throw error;
    }
  }

  async retrieveRefund(refundId: string): Promise<Stripe.Refund> {
    if (!refundId || typeof refundId !== 'string' || refundId.trim() === '') {
      throw new Error('Refund ID is required');
    }

    try {
      return await this.stripe.refunds.retrieve(refundId);
    } catch (error) {
      const err = toError(error);
      this.logger.error(`Failed to retrieve Refund ${refundId}: ${err.message}`, err.stack);
      throw error;
    }
  }

  async retrieveCharge(chargeId: string): Promise<Stripe.Charge> {
    if (!chargeId || typeof chargeId !== 'string' || chargeId.trim() === '') {
      throw new Error('Charge ID is required');
    }

    try {
      return await this.stripe.charges.retrieve(chargeId);
    } catch (error) {
      const err = toError(error);
      this.logger.error(`Failed to retrieve Charge ${chargeId}: ${err.message}`, err.stack);
      throw error;
    }
  }

  async detachPaymentMethod(paymentMethodId: string): Promise<Stripe.PaymentMethod> {
    if (!paymentMethodId || typeof paymentMethodId !== 'string' || paymentMethodId.trim() === '') {
      throw new Error('PaymentMethod ID is required');
    }

    try {
      return await this.stripe.paymentMethods.detach(paymentMethodId);
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Failed to detach PaymentMethod ${paymentMethodId}: ${err.message}`,
        err.stack,
      );
      throw error;
    }
  }

  constructWebhookEvent(payload: string | Buffer, header: string, secret: string): Stripe.Event {
    try {
      return this.stripe.webhooks.constructEvent(payload, header, secret);
    } catch (error) {
      const err = error as Error;
      this.logger.error(`Webhook signature verification failed: ${err.message}`, err.stack);
      throw error;
    }
  }

  extractAuthorizationExpiry(paymentIntent: unknown): Date | null {
    if (!isRecord(paymentIntent)) {
      return null;
    }

    const latestCharge = paymentIntent['latest_charge'];
    if (isRecord(latestCharge)) {
      const pmd = latestCharge['payment_method_details'];
      if (isRecord(pmd)) {
        const card = pmd['card'];
        if (
          isRecord(card) &&
          typeof card['capture_before'] === 'number' &&
          Number.isFinite(card['capture_before']) &&
          card['capture_before'] > 0
        ) {
          const expiry = new Date(card['capture_before'] * 1000);
          return Number.isFinite(expiry.getTime()) ? expiry : null;
        }
        const cardPresent = pmd['card_present'];
        if (
          isRecord(cardPresent) &&
          typeof cardPresent['capture_before'] === 'number' &&
          Number.isFinite(cardPresent['capture_before']) &&
          cardPresent['capture_before'] > 0
        ) {
          const expiry = new Date(cardPresent['capture_before'] * 1000);
          return Number.isFinite(expiry.getTime()) ? expiry : null;
        }
      }
    }

    return null;
  }

  normalizeCapture(paymentIntent: unknown): {
    succeeded: boolean;
    status: string;
    capturedAmount: number;
    currency?: string;
  } {
    if (!isRecord(paymentIntent)) {
      return {
        succeeded: false,
        status: 'unknown',
        capturedAmount: 0,
      };
    }

    const rawStatus =
      typeof paymentIntent['status'] === 'string' ? paymentIntent['status'] : 'unknown';
    const rawCurrency =
      typeof paymentIntent['currency'] === 'string' &&
      /^[A-Za-z]{3}$/.test(paymentIntent['currency'])
        ? paymentIntent['currency'].toLowerCase()
        : undefined;
    const amount =
      typeof paymentIntent['amount'] === 'number' &&
      Number.isSafeInteger(paymentIntent['amount']) &&
      paymentIntent['amount'] > 0
        ? paymentIntent['amount']
        : 0;
    const amountReceived =
      typeof paymentIntent['amount_received'] === 'number' &&
      Number.isSafeInteger(paymentIntent['amount_received']) &&
      paymentIntent['amount_received'] > 0
        ? paymentIntent['amount_received']
        : 0;

    const isFullCapture = amount > 0 && amountReceived === amount;
    const succeeded = rawStatus === 'succeeded' && isFullCapture && rawCurrency !== undefined;

    return {
      succeeded,
      status: rawStatus,
      capturedAmount: amountReceived,
      currency: rawCurrency,
    };
  }
}
