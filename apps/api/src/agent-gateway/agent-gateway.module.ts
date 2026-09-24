import { Module } from '@nestjs/common';
import { AgentAuthModule } from './auth/agent-auth.module';
import { AgentToolAuditModule } from './audit/agent-tool-audit.module';
import { SelectionAttestationService } from './selection-attestation.service';
import { AttestedFlightSearchModule } from './attested-flight-search/attested-flight-search.module';
import { AgentBookingReadinessModule } from './booking-readiness/agent-booking-readiness.module';
import { SafeBookingReadModule } from './safe-booking-read/safe-booking-read.module';
import { TravelerPreferencesModule } from './traveler-preferences/traveler-preferences.module';
import { AgentChatModule } from './agent-chat/agent-chat.module';
import { PrismaModule } from '@/prisma/prisma.module';

@Module({
  imports: [
    PrismaModule,
    AgentAuthModule,
    AgentToolAuditModule,
    AttestedFlightSearchModule,
    AgentBookingReadinessModule,
    SafeBookingReadModule,
    TravelerPreferencesModule,
    AgentChatModule,
  ],
  providers: [SelectionAttestationService],
  exports: [
    AgentAuthModule,
    AgentToolAuditModule,
    SelectionAttestationService,
    AttestedFlightSearchModule,
    AgentBookingReadinessModule,
    SafeBookingReadModule,
    TravelerPreferencesModule,
    AgentChatModule,
  ],
})
export class AgentGatewayModule {}
