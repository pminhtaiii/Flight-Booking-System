import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { DuffelModule } from '@/duffel/duffel.module';
import { BookingLifecycleModule } from '@/booking-lifecycle/booking-lifecycle.module';
import { AgentGatewayModule } from '@/agent-gateway/agent-gateway.module';
import { SyncClaimService } from './sync/sync-claim.service';
import { SupplierSyncService } from './sync/supplier-sync.service';
import { ReconciliationService } from './sync/reconciliation.service';
import { DisruptionController, TravellerDisruptionController } from './api/disruption.controller';
import { DisruptionService } from './api/disruption.service';
import { DuffelWebhookController } from './webhook/duffel-webhook.controller';
import { DuffelSignatureService } from './webhook/duffel-signature.service';
import { DuffelInboxService } from './webhook/duffel-inbox.service';
import { DuffelProcessorHealthService } from './webhook/duffel-processor-health.service';
import { DuffelEventProcessor } from './webhook/duffel-event.processor';

@Module({
  imports: [
    PrismaModule,
    DuffelModule,
    BookingLifecycleModule,
    forwardRef(() => AgentGatewayModule),
  ],

  controllers: [DisruptionController, TravellerDisruptionController, DuffelWebhookController],
  providers: [
    DisruptionService,
    SyncClaimService,
    SupplierSyncService,
    ReconciliationService,
    DuffelSignatureService,
    DuffelInboxService,
    DuffelProcessorHealthService,
    DuffelEventProcessor,
  ],
  exports: [
    DisruptionService,
    SyncClaimService,
    SupplierSyncService,
    ReconciliationService,
    DuffelSignatureService,
    DuffelInboxService,
    DuffelProcessorHealthService,
    DuffelEventProcessor,
  ],
})
export class DisruptionModule {}
