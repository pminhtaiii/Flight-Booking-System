import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { EncryptionService } from '../common/encryption.service';
import { PassportExpiryBackfillService } from './passport-expiry-backfill.service';
import { PassportExpiryBackfillController } from './passport-expiry-backfill.controller';

@Module({
  imports: [PrismaModule],
  controllers: [PassportExpiryBackfillController],
  providers: [PassportExpiryBackfillService, EncryptionService],
  exports: [PassportExpiryBackfillService],
})
export class ProfileModule {}
