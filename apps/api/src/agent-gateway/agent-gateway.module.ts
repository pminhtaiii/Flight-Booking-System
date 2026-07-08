import { Module } from '@nestjs/common';
import { AgentGatewayService } from './agent-gateway.service';
import { AgentGatewayController } from './agent-gateway.controller';
import { ClaimTokenService } from './auth/claim-token.service';
import { PrismaModule } from '@/prisma/prisma.module';
import { AuditModule } from '@/audit/audit.module';
import { DuffelModule } from '@/duffel/duffel.module';

@Module({
  imports: [PrismaModule, AuditModule, DuffelModule],
  controllers: [AgentGatewayController],
  providers: [AgentGatewayService, ClaimTokenService],
  exports: [AgentGatewayService, ClaimTokenService],
})
export class AgentGatewayModule {}
