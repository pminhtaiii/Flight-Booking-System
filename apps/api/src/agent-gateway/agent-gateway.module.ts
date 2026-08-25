import { Module, forwardRef } from '@nestjs/common';
import { AgentGatewayService } from './agent-gateway.service';
import { AgentGatewayController } from './agent-gateway.controller';
import { AgentAuthModule } from './auth/agent-auth.module';
import { AgentToolAuditModule } from './audit/agent-tool-audit.module';
import { SelectionAttestationService } from './selection-attestation.service';
import { BookingAgentProjectionService } from './booking-agent-projection.service';
import { PrismaModule } from '@/prisma/prisma.module';
import { AuditModule } from '@/audit/audit.module';
import { DuffelModule } from '@/duffel/duffel.module';
import { ProfileModule } from '@/profile/profile.module';
import { BookingIntentModule } from '@/booking-intent/booking-intent.module';
import { ChatModule } from '@/chat/chat.module';

@Module({
  imports: [
    PrismaModule,
    AuditModule,
    DuffelModule,
    ProfileModule,
    forwardRef(() => BookingIntentModule),
    ChatModule,
    AgentAuthModule,
    AgentToolAuditModule,
  ],
  controllers: [AgentGatewayController],
  providers: [AgentGatewayService, SelectionAttestationService, BookingAgentProjectionService],
  exports: [AgentGatewayService, AgentAuthModule, AgentToolAuditModule, SelectionAttestationService, BookingAgentProjectionService],
})
export class AgentGatewayModule {}


