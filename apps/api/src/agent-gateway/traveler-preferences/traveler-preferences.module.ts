import { Module } from '@nestjs/common';
import { TravelerPreferencesService } from './traveler-preferences.service';
import { TravelerPreferencesController } from './traveler-preferences.controller';
import { PrismaModule } from '@/prisma/prisma.module';
import { AgentAuthModule } from '../auth/agent-auth.module';
import { AgentToolAuditModule } from '../audit/agent-tool-audit.module';

@Module({
  imports: [PrismaModule, AgentAuthModule, AgentToolAuditModule],
  controllers: [TravelerPreferencesController],
  providers: [TravelerPreferencesService],
  exports: [TravelerPreferencesService],
})
export class TravelerPreferencesModule {}
