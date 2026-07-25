import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { DuffelModule } from '@/duffel/duffel.module';
import { SyncClaimService } from './sync/sync-claim.service';
import { SupplierSyncService } from './sync/supplier-sync.service';
import { DisruptionController } from './api/disruption.controller';

@Module({
  imports: [PrismaModule, DuffelModule],
  controllers: [DisruptionController],
  providers: [SyncClaimService, SupplierSyncService],
  exports: [SyncClaimService, SupplierSyncService],
})
export class DisruptionModule {}
