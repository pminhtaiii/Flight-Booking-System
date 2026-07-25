import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '@/prisma/prisma.service';
import { SupplierSyncService } from './supplier-sync.service';
import { CacheService } from '@/cache/cache.service';
import { BookingService, BookingWithRelations } from '@/booking/booking.service';

export interface ReconciliationResult {
  selected: number;
  processed: number;
  unchanged: number;
  changed: number;
  failed: number;
  deferred: number;
  stale: number;
  budgetBlocked: number;
}

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly supplierSyncService: SupplierSyncService,
    private readonly cacheService: CacheService,
    private readonly bookingService: BookingService,
  ) {}

  @Cron(process.env.DUFFEL_RECONCILIATION_CRON || '*/30 * * * *')
  async handleCron(): Promise<void> {
    const isReconciliationEnabled = process.env.FEATURE_FLAG_DISRUPTION_RECONCILIATION === 'true';
    const isTestEnv = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;
    if (!isReconciliationEnabled && !isTestEnv) {
      return;
    }

    this.logger.log('Starting reconciliation cron job...');
    try {
      const result = await this.reconcile();
      this.logger.log(
        `Reconciliation cron complete. Result: ${JSON.stringify(result)}`
      );
    } catch (error) {
      this.logger.error('Error occurred during reconciliation cron execution:', error);
    }
  }

  async reconcile(): Promise<ReconciliationResult> {
    const now = new Date();
    const seventyTwoHoursLater = new Date(now.getTime() + 72 * 60 * 60 * 1000);
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
    const batchSize = Number(process.env.DUFFEL_RECONCILIATION_BATCH_SIZE || 20);

    // 1. Complete stale bookings that have passed their final arrival
    const staleBookings = await this.prisma.booking.findMany({
      where: {
        status: 'CONFIRMED',
        OR: [
          { currentFinalArrivalAt: { lte: now } },
          {
            AND: [
              { currentFinalArrivalAt: null },
              { departureAt: { lte: now } },
            ],
          },
        ],
      },
      include: {
        payment: { select: { id: true, status: true, stripePaymentIntentId: true } },
        bookingIntent: { select: { id: true, duffelOfferId: true } },
      },
    });

    let stale = 0;
    for (const booking of staleBookings) {
      try {
        const completedBooking = await this.bookingService.checkAndCompleteBooking(booking as BookingWithRelations);
        if (completedBooking.status === 'COMPLETED') {
          stale++;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Failed to process completion for booking ${booking.id}: ${msg}`);
      }
    }

    // 2. Fetch eligible bookings for sync
    const eligibleBookings = await this.prisma.booking.findMany({
      where: {
        status: 'CONFIRMED',
        duffelOrderId: { not: null },
        nextUnflownDepartureAt: {
          gt: now,
          lte: seventyTwoHoursLater,
        },
        AND: [
          {
            OR: [
              { nextDuffelSyncAt: null },
              { nextDuffelSyncAt: { lte: now } },
            ],
          },
          {
            OR: [
              { syncLockedAt: null },
              { syncLockedAt: { lt: fiveMinutesAgo } },
            ],
          },
        ],
      },
      take: batchSize,
      orderBy: [
        { lastDuffelSyncedAt: { sort: 'asc', nulls: 'first' } },
        { nextUnflownDepartureAt: 'asc' },
        { id: 'asc' },
      ],
    });

    const selected = eligibleBookings.length;
    let processed = 0;
    let unchanged = 0;
    let changed = 0;
    let failed = 0;
    let deferred = 0;
    let budgetBlocked = 0;

    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const budgetKey = `budget:duffel:${year}-${month}`;
    const totalLimit = Number(process.env.DUFFEL_BUDGET_LIMIT_TOTAL || 2000);

    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    const ttlSeconds = Math.max(0, Math.ceil((endOfMonth.getTime() - Date.now()) / 1000));

    this.logger.log(`Selected ${selected} bookings for reconciliation.`);

    for (const booking of eligibleBookings) {
      // Budget Check
      const currentBudgetStr = await this.cacheService.get(budgetKey);
      const currentBudget = currentBudgetStr ? parseInt(currentBudgetStr, 10) : 0;

      if (currentBudget >= totalLimit) {
        this.logger.warn(
          JSON.stringify({
            message: 'Duffel budget capacity reached. Deferring reconciliation.',
            bookingId: booking.id,
            currentBudget,
            limit: totalLimit,
            metric: 'budget_blocked',
          })
        );
        budgetBlocked++;
        continue;
      }

      // Increment budget before claim & process
      const newBudget = await this.cacheService.incr(budgetKey, ttlSeconds);
      if (newBudget > totalLimit) {
        this.logger.warn(
          JSON.stringify({
            message: 'Duffel budget capacity reached after increment. Deferring reconciliation.',
            bookingId: booking.id,
            newBudget,
            limit: totalLimit,
            metric: 'budget_blocked',
          })
        );
        await this.cacheService.decr(budgetKey);
        budgetBlocked++;
        continue;
      }

      try {
        const result = await this.supplierSyncService.syncBooking(booking.id, 'RECONCILIATION');

        if (result.status === 'SKIPPED_LOCKED' || result.status === 'SKIPPED_INELIGIBLE') {
          // No API call was made, decrement budget
          await this.cacheService.decr(budgetKey);
          deferred++;
        } else {
          if (result.status === 'REVISION_CREATED') {
            changed++;
          } else {
            unchanged++;
          }
          processed++;

          // Clear failures on success
          await this.cacheService.del(`reconciliation:failures:${booking.id}`);
        }

        this.logger.log(
          JSON.stringify({
            message: 'Reconciliation sync completed for booking.',
            bookingId: booking.id,
            status: result.status,
            metric: 'reconciliation_success',
          })
        );
      } catch (error: unknown) {
        failed++;
        const err = error instanceof Error ? error : new Error(String(error));

        // Exponential backoff setup
        const failureKey = `reconciliation:failures:${booking.id}`;
        const currentFailuresStr = await this.cacheService.get(failureKey);
        const currentFailures = currentFailuresStr ? parseInt(currentFailuresStr, 10) : 0;
        const newFailures = currentFailures + 1;

        await this.cacheService.set(failureKey, String(newFailures), 48 * 60 * 60);

        const backoffMinutes = 15 * Math.pow(2, newFailures - 1);
        const nextSyncAt = new Date(Date.now() + backoffMinutes * 60 * 1000);

        await this.prisma.booking.updateMany({
          where: { id: booking.id },
          data: {
            nextDuffelSyncAt: nextSyncAt,
            syncLockedAt: null,
            syncLockToken: null,
          },
        });

        this.logger.error(
          JSON.stringify({
            message: 'Reconciliation sync failed for booking.',
            bookingId: booking.id,
            error: err.message,
            nextDuffelSyncAt: nextSyncAt.toISOString(),
            metric: 'reconciliation_failure',
          }),
          err.stack
        );
      }
    }

    const summary = { selected, processed, unchanged, changed, failed, deferred, stale, budgetBlocked };
    this.logger.log(`Reconciliation run summary: ${JSON.stringify(summary)}`);
    return summary;
  }
}
