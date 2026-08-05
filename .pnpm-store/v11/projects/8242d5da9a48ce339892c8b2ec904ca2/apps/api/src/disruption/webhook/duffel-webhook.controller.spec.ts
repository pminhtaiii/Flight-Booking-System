import { Test, TestingModule } from '@nestjs/testing';
import { Request } from 'express';
import { DuffelWebhookController } from './duffel-webhook.controller';
import { DuffelSignatureService } from './duffel-signature.service';
import { DuffelInboxService } from './duffel-inbox.service';

describe('DuffelWebhookController', () => {
  let controller: DuffelWebhookController;
  let signatureService: DuffelSignatureService;
  let inboxService: DuffelInboxService;

  const mockSignatureService = {
    verifySignature: jest.fn(),
  };

  const mockInboxService = {
    createEvent: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DuffelWebhookController],
      providers: [
        { provide: DuffelSignatureService, useValue: mockSignatureService },
        { provide: DuffelInboxService, useValue: mockInboxService },
      ],
    }).compile();

    controller = module.get<DuffelWebhookController>(DuffelWebhookController);
    signatureService = module.get<DuffelSignatureService>(DuffelSignatureService);
    inboxService = module.get<DuffelInboxService>(DuffelInboxService);

    jest.clearAllMocks();
    process.env.FEATURE_FLAG_DISRUPTION_INGRESS = 'true';
    process.env.DUFFEL_WEBHOOK_SECRET = 'test-secret';
  });

  it('should throw BadRequestException if receiver feature flag is disabled', async () => {
    process.env.FEATURE_FLAG_DISRUPTION_INGRESS = 'false';
    const oldNodeEnv = process.env.NODE_ENV;
    const oldJestWorkerId = process.env.JEST_WORKER_ID;
    delete process.env.NODE_ENV;
    delete process.env.JEST_WORKER_ID;

    try {
      const mockReq = { rawBody: Buffer.from('{}'), body: {} } as unknown as Request;
      await expect(controller.handleWebhook(mockReq, 'sig')).rejects.toThrow(
        expect.objectContaining({
          message: 'Duffel webhook receiver is disabled',
          response: expect.objectContaining({ error: 'WEBHOOK_RECEIVER_DISABLED' }),
        }),
      );
    } finally {
      process.env.NODE_ENV = oldNodeEnv;
      process.env.JEST_WORKER_ID = oldJestWorkerId;
    }
  });

  it('should throw BadRequestException if DUFFEL_WEBHOOK_SECRET is missing', async () => {
    delete process.env.DUFFEL_WEBHOOK_SECRET;
    const mockReq = { rawBody: Buffer.from('{}'), body: {} } as unknown as Request;
    await expect(controller.handleWebhook(mockReq, 'sig')).rejects.toThrow(
      expect.objectContaining({
        message: 'Duffel webhook secret is not configured',
        response: expect.objectContaining({ error: 'WEBHOOK_SIGNATURE_INVALID' }),
      }),
    );
  });

  it('should throw BadRequestException if raw request body is missing', async () => {
    const mockReq = { body: {} } as unknown as Request;
    await expect(controller.handleWebhook(mockReq, 'sig')).rejects.toThrow(
      expect.objectContaining({
        message: 'Raw request body is missing',
        response: expect.objectContaining({ error: 'WEBHOOK_SIGNATURE_INVALID' }),
      }),
    );
  });

  it('should successfully verify, validate supported event, and save to inbox', async () => {
    const payload = {
      id: 'wev_1',
      type: 'order.airline_initiated_change_detected',
      data: { object: { order_id: 'ord_1' } },
      idempotency_key: 'idem_key',
    };
    const mockReq = {
      rawBody: Buffer.from(JSON.stringify(payload)),
      body: payload,
    } as unknown as Request;

    mockInboxService.createEvent.mockResolvedValue({ id: 'uuid-123', supplierEventId: 'wev_1', status: 'PENDING' });

    const result = await controller.handleWebhook(mockReq, 't=123,v1=sig');

    expect(result).toEqual({ received: true });
    expect(signatureService.verifySignature).toHaveBeenCalledWith((mockReq as unknown as { rawBody: Buffer }).rawBody, 't=123,v1=sig', 'test-secret');
    expect(inboxService.createEvent).toHaveBeenCalledWith(
      'wev_1',
      'idem_key',
      'ord_1',
      'order.airline_initiated_change_detected',
      payload,
    );
  });

  it('should throw BadRequestException if payload data.object.order_id is missing for supported event', async () => {
    const payload = {
      id: 'wev_1',
      type: 'order.airline_initiated_change_detected',
      data: { object: {} },
    };
    const mockReq = {
      rawBody: Buffer.from(JSON.stringify(payload)),
      body: payload,
    } as unknown as Request;

    await expect(controller.handleWebhook(mockReq, 't=123,v1=sig')).rejects.toThrow(
      expect.objectContaining({
        message: 'Invalid webhook payload: data.object.order_id is required',
        response: expect.objectContaining({ error: 'WEBHOOK_PAYLOAD_INVALID' }),
      }),
    );
  });
});
