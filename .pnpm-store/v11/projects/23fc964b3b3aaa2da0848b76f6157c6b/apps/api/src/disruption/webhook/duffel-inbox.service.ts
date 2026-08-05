import { Injectable, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { DuffelWebhookEvent, DuffelWebhookEventStatus, Prisma } from '@prisma/client';

@Injectable()
export class DuffelInboxService {
  private readonly logger = new Logger(DuffelInboxService.name);

  constructor(private readonly prisma: PrismaService) {}

  async createEvent(
    supplierEventId: string,
    idempotencyKey: string | null,
    duffelOrderId: string | null,
    eventType: string,
    rawPayload: Prisma.InputJsonValue,
  ): Promise<DuffelWebhookEvent> {
    // 1. Check for duplicates
    const existing = await this.prisma.duffelWebhookEvent.findUnique({
      where: { supplierEventId },
    });

    if (existing) {
      this.logger.log(
        JSON.stringify({
          message: `Duplicate webhook event received: ${supplierEventId}. Converging safely.`,
          duffelEventId: supplierEventId,
          status: existing.status,
        }),
      );
      return existing;
    }

    const isSupported = eventType === 'order.airline_initiated_change_detected';
    const status: DuffelWebhookEventStatus = isSupported ? 'PENDING' : 'SKIPPED';

    try {
      // 2. Insert event
      const event = await this.prisma.duffelWebhookEvent.create({
        data: {
          supplierEventId,
          idempotencyKey,
          duffelOrderId,
          eventType,
          status,
          rawPayload,
          processedAt: isSupported ? null : new Date(),
        },
      });

      this.logger.log(
        JSON.stringify({
          message: `Webhook event persisted to inbox. ID: ${event.id}, supplierEventId: ${supplierEventId}, status: ${status}`,
          duffelEventId: supplierEventId,
          inboxEventId: event.id,
          eventType,
          status,
          duffelOrderId,
        }),
      );

      return event;
    } catch (error: unknown) {
      const err = error as { code?: string; meta?: { target?: string[] }; message?: string };
      // Handle unique constraint violation (concurrency race on the same supplierEventId)
      if (err.code === 'P2002' && err.meta?.target?.includes('supplierEventId')) {
        this.logger.log(
          JSON.stringify({
            message: `Concurrently received duplicate webhook event: ${supplierEventId}. Converging safely.`,
            duffelEventId: supplierEventId,
          }),
        );
        const existingAfterRace = await this.prisma.duffelWebhookEvent.findUnique({
          where: { supplierEventId },
        });
        if (existingAfterRace) return existingAfterRace;
      }

      this.logger.error(
        JSON.stringify({
          message: `Failed to persist webhook event ${supplierEventId} to inbox`,
          duffelEventId: supplierEventId,
          error: err.message,
        }),
      );

      throw new HttpException(
        {
          message: 'Durable insert could not be confirmed',
          error: 'WEBHOOK_INBOX_UNAVAILABLE',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }
}
