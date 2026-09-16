import { Injectable, Optional } from '@nestjs/common';
import { StripeService } from './stripe.service';
import {
  PaymentGatewayPort,
  PortInvocationControl,
  AuthorizeHoldOutcome,
  CapturePaymentOutcome,
  VoidHoldOutcome,
  PaymentAuthorizationStatus,
} from '@/payment-fulfillment/ports';
import {
  BoundedSemaphore,
  parsePositiveIntegerSetting,
} from '@/payment-fulfillment/utils/bounded-semaphore';

@Injectable()
export class StripePaymentAdapter implements PaymentGatewayPort {
  private readonly _semaphore: BoundedSemaphore;

  constructor(
    private readonly stripeService: StripeService,
    @Optional() semaphore?: BoundedSemaphore,
  ) {
    if (semaphore) {
      this._semaphore = semaphore;
    } else {
      const activeLimit = parsePositiveIntegerSetting(
        process.env.STRIPE_ADMISSION_ACTIVE_LIMIT,
        20,
        'STRIPE_ADMISSION_ACTIVE_LIMIT',
      );
      const queueLimit = parsePositiveIntegerSetting(
        process.env.STRIPE_ADMISSION_QUEUE_LIMIT,
        100,
        'STRIPE_ADMISSION_QUEUE_LIMIT',
      );
      const timeoutMs = parsePositiveIntegerSetting(
        process.env.STRIPE_ADMISSION_TIMEOUT_MS,
        5000,
        'STRIPE_ADMISSION_TIMEOUT_MS',
      );
      this._semaphore = new BoundedSemaphore(activeLimit, queueLimit, timeoutMs);
    }
  }

  get semaphore(): BoundedSemaphore {
    return this._semaphore;
  }

  async authorizeHold(
    intentId: string,
    control: PortInvocationControl,
  ): Promise<AuthorizeHoldOutcome> {
    const release = await this._semaphore.acquire();
    try {
      await control.beforeInvoke();
      const pi = await this.stripeService.retrievePaymentIntent(intentId);
      const status = this.normalizeStatus(pi.status);
      return {
        status,
        intentId,
        amount: pi.amount,
        currency: pi.currency,
        rawStatus: pi.status,
      };
    } finally {
      release();
    }
  }

  async capturePayment(
    intentId: string,
    captureKey: string,
    control: PortInvocationControl,
  ): Promise<CapturePaymentOutcome> {
    const release = await this._semaphore.acquire();
    try {
      await control.beforeInvoke();
      const pi = await this.stripeService.capturePaymentIntent(intentId, undefined, captureKey);
      return {
        success: pi.status === 'succeeded',
        intentId,
        status: pi.status,
        capturedAmount: pi.amount_received ?? pi.amount,
        currency: pi.currency,
      };
    } finally {
      release();
    }
  }

  async voidHold(
    intentId: string,
    control: PortInvocationControl,
  ): Promise<VoidHoldOutcome> {
    const release = await this._semaphore.acquire();
    try {
      await control.beforeInvoke();
      const voidKey = `${intentId}-stripe-void`;
      const pi = await this.stripeService.cancelPaymentIntent(intentId, voidKey);
      return {
        success: true,
        intentId,
        status: pi.status,
      };
    } finally {
      release();
    }
  }

  private normalizeStatus(rawStatus: string): PaymentAuthorizationStatus {
    switch (rawStatus) {
      case 'requires_capture':
        return 'authorized';
      case 'succeeded':
        return 'captured';
      case 'canceled':
        return 'voided';
      case 'requires_payment_method':
        return 'invalid';
      case 'processing':
      case 'requires_action':
      case 'requires_confirmation':
        return 'nonfinal';
      default:
        return 'invalid';
    }
  }
}
