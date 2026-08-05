import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BookingIntentService } from './booking-intent.service';

@Injectable()
export class BookingIntentCron {
  private readonly logger = new Logger(BookingIntentCron.name);

  constructor(private readonly bookingIntentService: BookingIntentService) {}

  @Cron('*/5 * * * *')
  async handleExpiration(): Promise<void> {
    const startTime = Date.now();
    this.logger.log('Starting booking intent expiration cron (Phase 1: PENDING -> EXPIRED)...');

    try {
      const { expiredCount } = await this.bookingIntentService.expireExpiredIntents();
      const duration = Date.now() - startTime;

      this.logger.log(
        `Phase 1 cron complete. Expired ${expiredCount} intents in ${duration}ms.`
      );
    } catch (error) {
      this.logger.error('Error occurred during booking intent expiration execution:', error);
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleHardDelete(): Promise<void> {
    const startTime = Date.now();
    this.logger.log('Starting booking intent hard-delete cron (Phase 2: EXPIRED -> deleted)...');

    try {
      const { deletedCount } = await this.bookingIntentService.deleteExpiredIntents();
      const duration = Date.now() - startTime;

      this.logger.log(
        `Phase 2 cron complete. Hard-deleted ${deletedCount} intents in ${duration}ms.`
      );
    } catch (error) {
      this.logger.error('Error occurred during booking intent hard-delete execution:', error);
    }
  }
}
