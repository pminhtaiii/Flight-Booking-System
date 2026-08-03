import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { DuffelModule } from '@/duffel/duffel.module';
import { AuditModule } from '@/audit/audit.module';
import { AirportsModule } from '@/airports/airports.module';
import { ProfileModule } from '@/profile/profile.module';
import { EncryptionService } from '@/common/encryption.service';
import { BookingIntentController, BookingReadinessController } from './booking-intent.controller';
import { BookingIntentService } from './booking-intent.service';
import { BookingIntentCron } from './booking-intent.cron';
import { BookingReadinessEvaluator } from './booking-readiness.evaluator';
import { BookingReadinessObservability } from './booking-readiness.observability';
import { BookingReadinessService } from './booking-readiness.service';

@Module({
  imports: [PrismaModule, DuffelModule, AuditModule, AirportsModule, ProfileModule],
  controllers: [BookingIntentController, BookingReadinessController],
  providers: [
    BookingIntentService,
    BookingReadinessService,
    BookingReadinessEvaluator,
    BookingReadinessObservability,
    EncryptionService,
    BookingIntentCron,
  ],
  exports: [BookingIntentService],
})
export class BookingIntentModule {}
