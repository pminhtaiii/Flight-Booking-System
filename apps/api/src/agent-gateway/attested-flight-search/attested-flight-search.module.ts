import { Module } from '@nestjs/common';
import { AttestedFlightSearchService } from './attested-flight-search.service';
import { AttestedFlightSearchController } from './attested-flight-search.controller';
import { SelectionAttestationService } from '../selection-attestation.service';
import { PrismaModule } from '@/prisma/prisma.module';
import { AuditModule } from '@/audit/audit.module';
import { ChatModule } from '@/chat/chat.module';
import { AgentAuthModule } from '../auth/agent-auth.module';
import { AgentToolAuditModule } from '../audit/agent-tool-audit.module';
import { FlightsModule } from '@/flights/flights.module';

@Module({
  imports: [
    PrismaModule,
    AuditModule,
    ChatModule,
    AgentAuthModule,
    AgentToolAuditModule,
    FlightsModule,
  ],
  controllers: [AttestedFlightSearchController],
  providers: [AttestedFlightSearchService, SelectionAttestationService],
  exports: [AttestedFlightSearchService, SelectionAttestationService],
})
export class AttestedFlightSearchModule {}
