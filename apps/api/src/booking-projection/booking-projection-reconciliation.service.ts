import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BookingProjectionRepository } from './booking-projection.repository';
import { BookingProjectionService } from './booking-projection.service';
import { BookingEventHydratorService } from '@/domain-events/booking-event-hydrator.service';
import { BookingProjectionMetrics } from './booking-projection.metrics';

export type CandidateOutcome = 'repaired' | 'current' | 'skipped' | 'failed';

export type ReconciliationPassSummary = {
  processed: number;
  repaired: number;
  current: number;
  skipped: number;
  failed: number;
  nextCursor: string | null;
  reachedEnd: boolean;
};

export const RECONCILIATION_CRON_JOB_NAME =
  'BookingProjectionReconciliationService';

@Injectable()
export class BookingProjectionReconciliationService {
  private readonly logger = new Logger(BookingProjectionReconciliationService.name);
  private isReconciling = false;
  private cursor?: string;

  constructor(
    private readonly repository: BookingProjectionRepository,
    private readonly projectionService: BookingProjectionService,
    private readonly hydrator: BookingEventHydratorService,
    @Optional()
    private readonly metrics: BookingProjectionMetrics = new BookingProjectionMetrics(),
  ) {}

  getCursor(): string | undefined {
    return this.cursor;
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: RECONCILIATION_CRON_JOB_NAME })
  async reconcileBatch(batchSize = 100): Promise<ReconciliationPassSummary | null> {
    if (this.isReconciling) {
      this.logger.warn({
        message: '[reconcileBatch] Reconciliation pass skipped: previous execution still in progress',
      });
      return null;
    }

    this.isReconciling = true;
    const startTime = Date.now();
    try {
      const scanResult = await this.repository.findStaleOrMissingBookingIds(
        batchSize,
        this.cursor,
      );

      const candidateIds = scanResult.bookingIds;
      const outcomes: CandidateOutcome[] = new Array(candidateIds.length);

      if (candidateIds.length > 0) {
        const CONCURRENCY_LIMIT = 5;
        let currentIndex = 0;
        const workerCount = Math.min(CONCURRENCY_LIMIT, candidateIds.length);

        const workers = Array.from({ length: workerCount }, async () => {
          while (currentIndex < candidateIds.length) {
            const index = currentIndex++;
            const bookingId = candidateIds[index];
            outcomes[index] = await this.reconcileCandidate(bookingId);
          }
        });

        await Promise.all(workers);
      }

      // Cursor progression:
      // Sets this.cursor = nextCursor.
      // When reachedEnd is true: resets this.cursor = undefined for the next pass without scanning an extra empty page.
      if (scanResult.reachedEnd) {
        this.cursor = undefined;
      } else {
        this.cursor = scanResult.nextCursor ?? undefined;
      }

      const tallies: Record<CandidateOutcome, number> = {
        repaired: 0,
        current: 0,
        skipped: 0,
        failed: 0,
      };

      for (const outcome of outcomes) {
        tallies[outcome] = (tallies[outcome] ?? 0) + 1;
      }

      const summary: ReconciliationPassSummary = {
        processed: candidateIds.length,
        repaired: tallies.repaired,
        current: tallies.current,
        skipped: tallies.skipped,
        failed: tallies.failed,
        nextCursor: scanResult.nextCursor,
        reachedEnd: scanResult.reachedEnd,
      };

      this.metrics?.incrementReconciliationPassTotal('SUCCESS');
      this.metrics?.incrementReconciliationStaleFoundTotal(candidateIds.length);
      this.metrics?.incrementReconciliationRepairedTotal(tallies.repaired);
      this.metrics?.incrementReconciliationFailedTotal(tallies.failed);
      this.metrics?.incrementReconciliationSkippedTotal(tallies.skipped);
      this.metrics?.incrementReconciliationCurrentTotal(tallies.current);

      this.logger.log({
        message: '[reconcileBatch] Booking projection reconciliation pass completed',
        ...summary,
      });

      return summary;
    } catch (error) {
      this.metrics?.incrementReconciliationPassTotal('ERROR');
      throw error;
    } finally {
      this.metrics?.recordReconciliationDuration(Date.now() - startTime);
      this.isReconciling = false;
    }
  }

  private async reconcileCandidate(bookingId: string): Promise<CandidateOutcome> {
    try {
      let snapshot;
      try {
        snapshot = await this.hydrator.hydrate(bookingId);
      } catch (error) {
        this.logger.warn({
          message: '[reconcileCandidate] Hydration failed during reconciliation',
          bookingId,
          error: error instanceof Error ? error.message : String(error),
        });
        this.metrics?.incrementFailureTotal('HYDRATION_FAILED');
        return 'failed';
      }

      if (!snapshot) {
        this.logger.warn({
          message: '[reconcileCandidate] Booking snapshot not found during reconciliation',
          bookingId,
        });
        return 'skipped';
      }

      let data;
      try {
        data = this.projectionService.extractProjectionData(snapshot);
      } catch (error) {
        this.logger.warn({
          message: '[reconcileCandidate] Projection data extraction failed during reconciliation',
          bookingId,
          error: error instanceof Error ? error.message : String(error),
        });
        this.metrics?.incrementFailureTotal('EXTRACTION_FAILED');
        return 'failed';
      }

      if (!data) {
        this.logger.warn({
          message: '[reconcileCandidate] Projection data null during reconciliation',
          bookingId,
        });
        return 'skipped';
      }

      const upsertResult = await this.repository.upsertGuarded({
        bookingId,
        status: snapshot.status,
        sourceVersion: snapshot.version,
        data,
      });

      if (upsertResult.outcome === 'SUCCESS') {
        return 'repaired';
      }
      return 'current';
    } catch (error) {
      this.logger.error({
        message: '[reconcileCandidate] Unexpected error reconciling booking candidate',
        bookingId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.metrics?.incrementFailureTotal('UNEXPECTED_ERROR');
      return 'failed';
    }
  }
}
