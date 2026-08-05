import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { PaymentWebhookController } from './payment-webhook.controller';
import { StripeService } from '../common/stripe.service';
import { PaymentWebhookService } from './payment-webhook.service';
import { BadRequestException } from '@nestjs/common';
import { Request } from 'express';

describe('PaymentWebhookController', () => {
  let controller: PaymentWebhookController;
  let mockStripeService: any;
  let mockWebhookService: any;

  beforeEach(async () => {
    mockStripeService = {
      constructWebhookEvent: jest.fn(),
    };

    mockWebhookService = {
      handleWebhookEvent: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentWebhookController],
      providers: [
        { provide: StripeService, useValue: mockStripeService },
        { provide: PaymentWebhookService, useValue: mockWebhookService },
      ],
    }).compile();

    controller = module.get<PaymentWebhookController>(PaymentWebhookController);
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  });

  afterEach(() => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  it('T001: throws BadRequestException if STRIPE_WEBHOOK_SECRET is not configured', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const req = {} as Request;

    await expect(controller.handleWebhook(req, 'sig')).rejects.toThrow(
      new BadRequestException('Stripe webhook secret is not configured'),
    );
  });

  it('T001: throws BadRequestException if stripe-signature header is missing', async () => {
    const req = {} as Request;

    await expect(controller.handleWebhook(req, '')).rejects.toThrow(
      new BadRequestException('stripe-signature header is missing'),
    );
  });

  it('T001: throws BadRequestException if rawBody is missing', async () => {
    const req = {} as Request;

    await expect(controller.handleWebhook(req, 'sig')).rejects.toThrow(
      new BadRequestException('Raw request body is missing'),
    );
  });

  it('T001: throws BadRequestException if signature verification fails', async () => {
    const req = { rawBody: Buffer.from('payload') } as any as Request;
    mockStripeService.constructWebhookEvent.mockImplementationOnce(() => {
      throw new Error('Invalid signature');
    });

    await expect(controller.handleWebhook(req, 'invalid_sig')).rejects.toThrow(
      new BadRequestException('Webhook signature verification failed: Invalid signature'),
    );
  });

  it('T001: calls webhookService.handleWebhookEvent and returns received: true when signature verified', async () => {
    const rawBodyBuffer = Buffer.from('payload');
    const req = { rawBody: rawBodyBuffer } as any as Request;
    const mockEvent = { id: 'evt_123', type: 'payment_intent.succeeded' };
    mockStripeService.constructWebhookEvent.mockReturnValueOnce(mockEvent);

    const result = await controller.handleWebhook(req, 'valid_sig');

    expect(mockStripeService.constructWebhookEvent).toHaveBeenCalledWith(
      rawBodyBuffer,
      'valid_sig',
      'whsec_test',
    );
    expect(mockWebhookService.handleWebhookEvent).toHaveBeenCalledWith(mockEvent);
    expect(result).toEqual({ received: true });
  });
});
