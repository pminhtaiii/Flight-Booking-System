import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EncryptionService } from '../common/encryption.service';

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
  ) {}

  async backfill(options?: BackfillOptions): Promise<BackfillResult> {
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
      const ciphertext = this.encryptionService.encrypt(legacyDateString);

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
        const decrypted = this.encryptionService.decrypt(ciphertext);
        const decryptedDate = new Date(decrypted);
        const legacyTime = new Date(profile.passportExpiry).getTime();
        const decryptedTime = decryptedDate.getTime();

        if (isNaN(decryptedTime) || legacyTime !== decryptedTime) {
          quarantined++;
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
