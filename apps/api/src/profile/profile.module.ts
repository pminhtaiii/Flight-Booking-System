import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { EncryptionService } from '../common/encryption.service';
import { BookingReadinessMetricsService } from '../common/observability/booking-readiness.metrics';
import { PassportExpiryBackfillService } from './passport-expiry-backfill.service';
import { PassportExpiryBackfillController } from './passport-expiry-backfill.controller';
import { ProfileService } from './profile.service';
import { ProfileController } from './profile.controller';

@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [PassportExpiryBackfillController, ProfileController],
  providers: [PassportExpiryBackfillService, ProfileService, EncryptionService],
  exports: [PassportExpiryBackfillService, ProfileService],
})
export class ProfileModule {}
