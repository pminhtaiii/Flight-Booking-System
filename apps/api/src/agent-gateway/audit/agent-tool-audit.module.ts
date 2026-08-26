import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { AgentToolAuditService } from './agent-tool-audit.service';

@Module({
  imports: [PrismaModule],
  providers: [AgentToolAuditService],
  exports: [AgentToolAuditService],
})
export class AgentToolAuditModule {}
