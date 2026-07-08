import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '@/prisma/prisma.service';

@Injectable()
export class DuffelCleanupService {
  private readonly logger = new Logger(DuffelCleanupService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleCleanup(): Promise<void> {
    this.logger.log('Starting daily cleanup of expired flight offers and recoveries...');
    try {
      const parseRetentionDays = (value: string | undefined, fallback: number): number => {
        const parsed = Number(value ?? fallback);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
      };

      const flightRetentionDays = parseRetentionDays(process.env.FLIGHT_OFFERS_RETENTION_DAYS, 7);
      const recoveryRetentionDays = parseRetentionDays(process.env.OFFER_RECOVERY_RETENTION_DAYS, 30);

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

      this.logger.log(
        `Cleanup complete. Purged ${deletedOffers.count} expired flight offers (older than ${flightRetentionDays} days) and ${deletedRecoveries.count} expired offer recoveries (older than ${recoveryRetentionDays} days).`
      );
    } catch (error) {
      this.logger.error('Error occurred during daily cleanup execution:', error);
    }
  }
}
