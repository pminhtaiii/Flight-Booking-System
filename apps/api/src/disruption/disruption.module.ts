import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { DuffelModule } from '@/duffel/duffel.module';
import { SyncClaimService } from './sync/sync-claim.service';
import { SupplierSyncService } from './sync/supplier-sync.service';
import { DisruptionController } from './api/disruption.controller';
import { DuffelWebhookController } from './webhook/duffel-webhook.controller';
import { DuffelSignatureService } from './webhook/duffel-signature.service';
import { DuffelInboxService } from './webhook/duffel-inbox.service';
import { DuffelProcessorHealthService } from './webhook/duffel-processor-health.service';
import { DuffelEventProcessor } from './webhook/duffel-event.processor';

@Module({
  imports: [PrismaModule, DuffelModule],
  controllers: [DisruptionController, DuffelWebhookController],
  providers: [
    SyncClaimService,
    SupplierSyncService,
    DuffelSignatureService,
    DuffelInboxService,
    DuffelProcessorHealthService,
    DuffelEventProcessor,
  ],
  exports: [
    SyncClaimService,
    SupplierSyncService,
    DuffelSignatureService,
    DuffelInboxService,
    DuffelProcessorHealthService,
    DuffelEventProcessor,
  ],
})
export class DisruptionModule {}
