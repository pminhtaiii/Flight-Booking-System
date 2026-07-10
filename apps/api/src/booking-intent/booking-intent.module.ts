import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { DuffelModule } from '@/duffel/duffel.module';
import { AuditModule } from '@/audit/audit.module';
import { EncryptionService } from '@/common/encryption.service';
import { BookingIntentController } from './booking-intent.controller';
import { BookingIntentService } from './booking-intent.service';

@Module({
  imports: [PrismaModule, DuffelModule, AuditModule],
  controllers: [BookingIntentController],
  providers: [BookingIntentService, EncryptionService],
  exports: [BookingIntentService],
})
export class BookingIntentModule {}
