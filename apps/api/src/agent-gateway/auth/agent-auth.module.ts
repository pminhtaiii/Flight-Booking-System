import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { AgentApiKeyGuard } from './agent-api-key.guard';
import { ClaimTokenGuard } from './claim-token.guard';
import { ClaimTokenService } from './claim-token.service';

@Module({
  imports: [PrismaModule],
  providers: [AgentApiKeyGuard, ClaimTokenGuard, ClaimTokenService],
  exports: [AgentApiKeyGuard, ClaimTokenGuard, ClaimTokenService],
})
export class AgentAuthModule {}
