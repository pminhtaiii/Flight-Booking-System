import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { EncryptionService } from '../common/encryption.service';
import {
  BookingReadinessMetricsService,
  BOOKING_READINESS_METRIC_COUNTERS,
} from '../common/observability/booking-readiness.metrics';

export interface BackfillOptions {
  batchSize?: number;
  abortThresholdRatio?: number;
}

export interface BackfillResult {
  processed: number;
  skipped: number;
  quarantined: number;
}

@Injectable()
export class PassportExpiryBackfillService {
  private readonly logger = new Logger(PassportExpiryBackfillService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryptionService: EncryptionService,
    @Optional() private readonly metricsService?: BookingReadinessMetricsService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleScheduledBackfill(): Promise<void> {
    this.logger.log('Starting scheduled passport expiry backfill...');
    try {
      const result = await this.backfill({ batchSize: 100 });
      this.logger.log(
        `Scheduled backfill completed: processed=${result.processed}, skipped=${result.skipped}, quarantined=${result.quarantined}`,
      );
    } catch (error) {
      this.logger.error('Error in scheduled backfill:', error);
    }
  }

  async backfill(options?: BackfillOptions): Promise<BackfillResult> {
    this.metricsService?.increment(BOOKING_READINESS_METRIC_COUNTERS.PASSPORT_EXPIRY_BACKFILL_RUNS);
    const batchSize = options?.batchSize ?? 100;
    const abortThresholdRatio = options?.abortThresholdRatio ?? 0.1;

    const profiles = await this.prisma.travelerProfile.findMany({
      where: {
        passportExpiry: { not: null },
        passportExpiryCiphertext: null,
      },
      take: batchSize,
    });

    if (profiles.length === 0) {
      this.logger.log({
        message: 'No profiles found requiring passport expiry backfill.',
        operation: 'passport_expiry_backfill',
        status: 'success',
        processed: 0,
        skipped: 0,
        quarantined: 0,
      });
      return { processed: 0, skipped: 0, quarantined: 0 };
    }

    let processed = 0;
    let skipped = 0;
    let quarantined = 0;
    let attempted = 0;

    for (const profile of profiles) {
      if (!profile.passportExpiry) {
        skipped++;
        continue;
      }

      const legacyDateString = profile.passportExpiry.toISOString();
      const context = {
        travelerProfileId: profile.id,
        fieldName: 'passportExpiry',
      };
      const ciphertext = this.encryptionService.encryptBound(legacyDateString, context);

      const updateResult = await this.prisma.travelerProfile.updateMany({
        where: {
          id: profile.id,
          revision: profile.revision,
          passportExpiry: profile.passportExpiry,
          passportExpiryCiphertext: null,
        },
        data: {
          passportExpiryCiphertext: ciphertext,
        },
      });

      if (updateResult.count === 0) {
        skipped++;
        continue;
      }

      attempted++;

      try {
        const decrypted = this.encryptionService.decryptBound(ciphertext, context);
        const decryptedDate = new Date(decrypted);
        const legacyTime = new Date(profile.passportExpiry).getTime();
        const decryptedTime = decryptedDate.getTime();

        if (isNaN(decryptedTime) || legacyTime !== decryptedTime) {
          quarantined++;
          this.metricsService?.increment(BOOKING_READINESS_METRIC_COUNTERS.PASSPORT_EXPIRY_BACKFILL_QUARANTINED);
          this.logger.warn({
            message: `Quarantine profile ${profile.id} due to date mismatch.`,
            profileId: profile.id,
            operation: 'passport_expiry_backfill_verification',
            status: 'quarantined',
            reason: 'date_mismatch',
          });
        } else {
          processed++;
        }
      } catch (err) {
        quarantined++;
        this.metricsService?.increment(BOOKING_READINESS_METRIC_COUNTERS.PASSPORT_EXPIRY_BACKFILL_QUARANTINED);
        this.logger.warn({
          message: `Quarantine profile ${profile.id} due to decryption failure.`,
          profileId: profile.id,
          operation: 'passport_expiry_backfill_verification',
          status: 'quarantined',
          reason: 'decryption_failure',
        });
      }

      if (attempted > 0) {
        const quarantineRatio = quarantined / attempted;
        if (quarantineRatio > abortThresholdRatio) {
          const errorMsg = `Backfill aborted due to high quarantine ratio: ${quarantineRatio * 100}% (threshold: ${abortThresholdRatio * 100}%)`;
          this.logger.error({
            message: errorMsg,
            operation: 'passport_expiry_backfill',
            status: 'aborted',
            attempted,
            quarantined,
            processed,
            skipped,
          });
          throw new Error(errorMsg);
        }
      }
    }

    this.logger.log({
      message: 'Passport expiry backfill batch completed.',
      operation: 'passport_expiry_backfill',
      status: 'success',
      processed,
      skipped,
      quarantined,
    });

    return { processed, skipped, quarantined };
  }
}
