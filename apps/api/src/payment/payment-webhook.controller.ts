import {
  Controller,
  Post,
  Req,
  Headers,
  BadRequestException,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request } from 'express';
import { StripeService } from '../common/stripe.service';
import { PaymentWebhookService } from './payment-webhook.service';

@Controller('payments')
export class PaymentWebhookController {
  private readonly logger = new Logger(PaymentWebhookController.name);

  constructor(
    private readonly stripeService: StripeService,
    private readonly webhookService: PaymentWebhookService,
  ) {}

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async handleWebhook(@Req() req: Request, @Headers('stripe-signature') signature: string) {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      this.logger.error('STRIPE_WEBHOOK_SECRET is not configured');
      throw new BadRequestException('Stripe webhook secret is not configured');
    }

    if (!signature) {
      this.logger.error('stripe-signature header is missing');
      throw new BadRequestException('stripe-signature header is missing');
    }

    const rawBody = (req as any).rawBody;
    if (!rawBody) {
      this.logger.error('Raw request body is missing. Ensure rawBody: true is enabled in main.ts');
      throw new BadRequestException('Raw request body is missing');
    }

    let event;
    try {
      event = this.stripeService.constructWebhookEvent(rawBody, signature, webhookSecret);
    } catch (err) {
      const error = err as Error;
      this.logger.error(`Signature verification failed: ${error.message}`);
      throw new BadRequestException(`Webhook signature verification failed: ${error.message}`);
    }

    await this.webhookService.handleWebhookEvent(event);
    return { received: true };
  }
}
