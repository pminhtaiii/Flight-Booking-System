import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { DuffelModule } from '@/duffel/duffel.module';
import { SyncClaimService } from './sync/sync-claim.service';
import { SupplierSyncService } from './sync/supplier-sync.service';

@Module({
  imports: [PrismaModule, DuffelModule],
  providers: [SyncClaimService, SupplierSyncService],
  exports: [SyncClaimService, SupplierSyncService],
})
export class DisruptionModule {}
