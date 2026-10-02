import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';

/**
 * Legacy Duffel cleanup service.
 * Note: Midnight @Cron has been relocated to FlightOfferCleanupService in SupplierSearchModule (T020).
 * This service retains handleCleanup() for explicit callers and E2E test harness backward-compatibility.
 * In accordance with strict port encapsulation, SupplierSearchModule exports strictly FLIGHT_SEARCH_PORT;
 * DuffelModule does not import internal services. This file will be decommissioned in T042 (monolith deletion).
 */
@Injectable()
export class DuffelCleanupService {
  private readonly logger = new Logger(DuffelCleanupService.name);

  constructor(private readonly prisma: PrismaService) {}

  async handleCleanup(): Promise<void> {
    this.logger.log('Starting daily cleanup of expired flight offers and recoveries...');
    try {
      const parseRetentionDays = (value: string | undefined, fallback: number): number => {
        const parsed = Number(value ?? fallback);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
      };

      const flightRetentionDays = parseRetentionDays(process.env.FLIGHT_OFFERS_RETENTION_DAYS, 7);
      const recoveryRetentionDays = parseRetentionDays(
        process.env.OFFER_RECOVERY_RETENTION_DAYS,
        30,
      );

      const now = new Date();

      const flightCutoff = new Date(now);
      flightCutoff.setDate(now.getDate() - flightRetentionDays);

      const recoveryCutoff = new Date(now);
      recoveryCutoff.setDate(now.getDate() - recoveryRetentionDays);

      const [deletedOffers, deletedRecoveries] = await Promise.all([
        this.prisma.flightOffer.deleteMany({
          where: {
            createdAt: {
              lt: flightCutoff,
            },
          },
        }),
        this.prisma.offerRecovery.deleteMany({
          where: {
            createdAt: {
              lt: recoveryCutoff,
            },
          },
        }),
      ]);

      const searchHistoryCount = await this.prisma.searchHistory.count();

      this.logger.log(
        `Cleanup complete. Purged ${deletedOffers.count} expired flight offers (older than ${flightRetentionDays} days) and ${deletedRecoveries.count} expired offer recoveries (older than ${recoveryRetentionDays} days). Preserved ${searchHistoryCount} search history entries indefinitely.`,
      );
    } catch (error) {
      this.logger.error('Error occurred during daily cleanup execution:', error);
    }
  }
}
