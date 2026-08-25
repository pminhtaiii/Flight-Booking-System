import { Module } from '@nestjs/common';
import { AgentGatewayService } from './agent-gateway.service';
import { AgentGatewayController } from './agent-gateway.controller';
import { AgentAuthModule } from './auth/agent-auth.module';
import { AgentToolAuditModule } from './audit/agent-tool-audit.module';
import { SelectionAttestationService } from './selection-attestation.service';
import { BookingAgentProjectionService } from './booking-agent-projection.service';
import { AttestedFlightSearchModule } from './attested-flight-search/attested-flight-search.module';
import { AgentBookingReadinessModule } from './booking-readiness/agent-booking-readiness.module';
import { SafeBookingReadModule } from './safe-booking-read/safe-booking-read.module';
import { TravelerPreferencesModule } from './traveler-preferences/traveler-preferences.module';
import { PrismaModule } from '@/prisma/prisma.module';
import { CacheModule } from '@/cache/cache.module';
import { ChatModule } from '@/chat/chat.module';

@Module({
  imports: [
    PrismaModule,
    CacheModule,
    ChatModule,
    AgentAuthModule,
    AgentToolAuditModule,
    AttestedFlightSearchModule,
    AgentBookingReadinessModule,
    SafeBookingReadModule,
    TravelerPreferencesModule,
  ],
  controllers: [AgentGatewayController],
  providers: [AgentGatewayService, SelectionAttestationService, BookingAgentProjectionService],
  exports: [
    AgentGatewayService,
    AgentAuthModule,
    AgentToolAuditModule,
    SelectionAttestationService,
    BookingAgentProjectionService,
    AttestedFlightSearchModule,
    AgentBookingReadinessModule,
    SafeBookingReadModule,
    TravelerPreferencesModule,
  ],
})
export class AgentGatewayModule {}
