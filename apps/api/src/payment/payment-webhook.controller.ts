import {
  Controller,
  Post,
  Req,
  Headers,
  BadRequestException,
  HttpCode,
  HttpStatus,
  RawBodyRequest,
  Logger,
} from '@nestjs/common';
import { Request } from 'express';
import { StripeService } from '@/common/stripe.service';
import { PaymentWebhookService } from './payment-webhook.service';

@Controller('payments')
export class PaymentWebhookController {
  private readonly logger = new Logger(PaymentWebhookController.name);

  constructor(
    private readonly stripeService: StripeService,
    private readonly webhookService: PaymentWebhookService
  ) {}

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string
  ) {
    if (!signature) {
      throw new BadRequestException('Missing stripe-signature header');
    }

    if (!req.rawBody) {
      throw new BadRequestException('Missing raw request body');
    }

    let event;
    try {
      event = this.stripeService.constructWebhookEvent(req.rawBody, signature);
    } catch (err: any) {
      throw new BadRequestException(`Webhook signature verification failed: ${err.message}`);
    }

    try {
      await this.webhookService.handleWebhookEvent(event);
      return { received: true };
    } catch (err: any) {
      this.logger.error(`Webhook event processing failed: ${err.message}`, err.stack);
      return { received: false, error: err.message };
    }
  }
}
