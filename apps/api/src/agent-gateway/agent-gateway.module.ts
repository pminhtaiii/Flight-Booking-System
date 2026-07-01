import { Module } from '@nestjs/common';
import { AgentGatewayService } from './agent-gateway.service';
import { AgentGatewayController } from './agent-gateway.controller';
import { ClaimTokenService } from './auth/claim-token.service';
import { AmadeusService } from './amadeus/amadeus.service';
import { PrismaModule } from '@/prisma/prisma.module';
import { AuditModule } from '@/audit/audit.module';

@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [AgentGatewayController],
  providers: [AgentGatewayService, ClaimTokenService, AmadeusService],
  exports: [AgentGatewayService, ClaimTokenService, AmadeusService],
})
export class AgentGatewayModule {}
