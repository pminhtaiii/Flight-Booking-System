import {
  Controller,
  Post,
  Req,
  Headers,
  BadRequestException,
  InternalServerErrorException,
  HttpCode,
  HttpStatus,
  RawBodyRequest,
} from '@nestjs/common';
import { Request } from 'express';
import { StripeService } from '@/common/stripe.service';
import { PaymentWebhookService } from './payment-webhook.service';

@Controller('payments')
export class PaymentWebhookController {
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
      throw new InternalServerErrorException(`Webhook processing failed: ${err.message}`);
    }
  }
}
