import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';

@Injectable()
export class DuffelProcessorHealthService {
  private lastHeartbeat: Date | null = null;
  private lastSuccessfulProcessing: Date | null = null;

  constructor(private readonly prisma: PrismaService) {}

  recordHeartbeat() {
    this.lastHeartbeat = new Date();
  }

  recordSuccess() {
    this.lastSuccessfulProcessing = new Date();
  }

  async getHealthMetrics() {
    const now = new Date();
    const leaseDurationMs = 5 * 60 * 1000;
    const staleCutoff = new Date(now.getTime() - leaseDurationMs);

    const [
      pendingCount,
      retryScheduledCount,
      staleProcessingCount,
      failedNeedsAttentionCount,
    ] = await Promise.all([
      this.prisma.duffelWebhookEvent.count({
        where: { status: 'PENDING' },
      }),
      this.prisma.duffelWebhookEvent.count({
        where: { status: 'RETRY_SCHEDULED' },
      }),
      this.prisma.duffelWebhookEvent.count({
        where: {
          status: 'PROCESSING',
          processingStartedAt: { lt: staleCutoff },
        },
      }),
      this.prisma.duffelWebhookEvent.count({
        where: { status: 'FAILED_NEEDS_ATTENTION' },
      }),
    ]);

    const isProcessorEnabled = process.env.ENABLE_DUFFEL_WEBHOOK_PROCESSOR === 'true';

    return {
      lastHeartbeat: this.lastHeartbeat ? this.lastHeartbeat.toISOString() : null,
      lastSuccessfulProcessing: this.lastSuccessfulProcessing ? this.lastSuccessfulProcessing.toISOString() : null,
      pendingCount,
      retryScheduledCount,
      staleProcessingCount,
      failedNeedsAttentionCount,
      processorEnabled: isProcessorEnabled,
    };
  }
}
