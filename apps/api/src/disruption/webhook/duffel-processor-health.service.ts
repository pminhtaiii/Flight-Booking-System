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

    const [pendingCount, retryScheduledCount, staleProcessingCount, failedNeedsAttentionCount] =
      await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe('SET LOCAL statement_timeout = 5000');
          return Promise.all([
            tx.duffelWebhookEvent.count({
              where: { status: 'PENDING' },
            }),
            tx.duffelWebhookEvent.count({
              where: { status: 'RETRY_SCHEDULED' },
            }),
            tx.duffelWebhookEvent.count({
              where: {
                status: 'PROCESSING',
                processingStartedAt: { lt: staleCutoff },
              },
            }),
            tx.duffelWebhookEvent.count({
              where: { status: 'FAILED_NEEDS_ATTENTION' },
            }),
          ]);
        },
        {
          maxWait: 5000,
          timeout: 5000,
        },
      );

    const isProcessorEnabled = process.env.FEATURE_FLAG_DISRUPTION_PROCESSOR === 'true';

    return {
      lastHeartbeat: this.lastHeartbeat ? this.lastHeartbeat.toISOString() : null,
      lastSuccessfulProcessing: this.lastSuccessfulProcessing
        ? this.lastSuccessfulProcessing.toISOString()
        : null,
      pendingCount,
      retryScheduledCount,
      staleProcessingCount,
      failedNeedsAttentionCount,
      processorEnabled: isProcessorEnabled,
    };
  }
}
