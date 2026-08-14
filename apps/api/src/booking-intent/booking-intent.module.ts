import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { DuffelModule } from '@/duffel/duffel.module';
import { AuditModule } from '@/audit/audit.module';
import { AirportsModule } from '@/airports/airports.module';
import { ProfileModule } from '@/profile/profile.module';
import { ChatHandoffModule } from '@/chat-handoff/chat-handoff.module';
import { EncryptionService } from '@/common/encryption.service';
import { BookingIntentController, BookingIntentLegacyController } from './booking-intent.controller';
import { BookingIntentService } from './booking-intent.service';
import { BookingIntentCron } from './booking-intent.cron';
import { BookingReadinessEvaluator } from './booking-readiness.evaluator';
import { BookingReadinessObservability } from './booking-readiness.observability';
import { BookingReadinessService } from './booking-readiness.service';
import { PassengerSourceResolverService } from './passenger-source-resolver.service';
import { PassengerSnapshotService } from './passenger-snapshot.service';
import { HandoffFastFailGuard } from './guards/handoff-fast-fail.guard';

@Module({
  imports: [PrismaModule, DuffelModule, AuditModule, AirportsModule, ProfileModule, forwardRef(() => ChatHandoffModule)],
  controllers: [BookingIntentController, BookingIntentLegacyController],
  providers: [
    BookingIntentService,
    BookingReadinessService,
    BookingReadinessEvaluator,
    BookingReadinessObservability,
    PassengerSourceResolverService,
    PassengerSnapshotService,
    EncryptionService,
    BookingIntentCron,
    HandoffFastFailGuard,
  ],
  exports: [
    BookingIntentService,
    BookingReadinessService,
    BookingReadinessObservability,
    PassengerSourceResolverService,
    PassengerSnapshotService,
    HandoffFastFailGuard,
  ],
})
export class BookingIntentModule {}
