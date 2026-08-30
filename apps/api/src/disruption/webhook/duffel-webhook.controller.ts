import {
  Controller,
  Post,
  Req,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { Request } from 'express';
import { DuffelSignatureService } from './duffel-signature.service';
import { DuffelInboxService } from './duffel-inbox.service';
import { Prisma } from '@prisma/client';

interface RequestWithRawBody extends Request {
  rawBody?: Buffer;
}

interface DuffelWebhookPayload {
  id?: string;
  type?: string;
  idempotency_key?: string | null;
  data?: {
    object?: {
      order_id?: string;
    };
  };
}

@Controller('duffel/webhook')
export class DuffelWebhookController {
  private readonly logger = new Logger(DuffelWebhookController.name);

  constructor(
    private readonly signatureService: DuffelSignatureService,
    private readonly inboxService: DuffelInboxService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @Req() req: Request,
    @Headers('x-duffel-signature') signatureHeader: string | undefined,
  ): Promise<{ received: boolean }> {
    // 1. Feature flag control
    const isReceiverEnabled = process.env.FEATURE_FLAG_DISRUPTION_INGRESS === 'true';
    if (!isReceiverEnabled) {
      this.logger.warn('Duffel webhook receiver request rejected (receiver disabled)');
      throw new BadRequestException({
        message: 'Duffel webhook receiver is disabled',
        error: 'WEBHOOK_RECEIVER_DISABLED',
      });
    }

    // 2. Secret validation configuration check
    const secret = process.env.DUFFEL_WEBHOOK_SECRET;
    if (!secret) {
      this.logger.error('DUFFEL_WEBHOOK_SECRET is not configured');
      throw new BadRequestException({
        message: 'Duffel webhook secret is not configured',
        error: 'WEBHOOK_SIGNATURE_INVALID',
      });
    }

    // 3. Raw request body verification
    const rawBody = (req as RequestWithRawBody).rawBody;
    if (!rawBody) {
      this.logger.error('Raw request body is missing');
      throw new BadRequestException({
        message: 'Raw request body is missing',
        error: 'WEBHOOK_SIGNATURE_INVALID',
      });
    }

    // 4. Cryptographic signature check
    this.signatureService.verifySignature(rawBody, signatureHeader, secret);

    // 5. Ingestion validation
    const payload = req.body as DuffelWebhookPayload;
    if (!payload) {
      throw new BadRequestException({
        message: 'Invalid webhook payload: request body is missing',
        error: 'WEBHOOK_PAYLOAD_INVALID',
      });
    }

    const { id, type, data, idempotency_key: idempotencyKey } = payload;
    if (!id || typeof id !== 'string' || !type || typeof type !== 'string') {
      throw new BadRequestException({
        message: 'Invalid webhook payload: id and type are required',
        error: 'WEBHOOK_PAYLOAD_INVALID',
      });
    }

    let duffelOrderId: string | null = null;

    // Supported event types: 'order.airline_initiated_change_detected'
    if (type === 'order.airline_initiated_change_detected') {
      const orderId = data?.object?.order_id;
      if (!orderId || typeof orderId !== 'string') {
        throw new BadRequestException({
          message: 'Invalid webhook payload: data.object.order_id is required',
          error: 'WEBHOOK_PAYLOAD_INVALID',
        });
      }
      duffelOrderId = orderId;
    }

    await this.inboxService.createEvent(
      id,
      idempotencyKey || null,
      duffelOrderId,
      type,
      payload as unknown as Prisma.InputJsonValue,
    );

    return { received: true };
  }
}
