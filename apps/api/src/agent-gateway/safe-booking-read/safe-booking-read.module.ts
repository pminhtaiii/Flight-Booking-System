import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { AgentAuthModule } from '../auth/agent-auth.module';
import { AgentToolAuditModule } from '../audit/agent-tool-audit.module';
import { SafeBookingReadController } from './safe-booking-read.controller';
import { SafeBookingReadService } from './safe-booking-read.service';

@Module({
  imports: [PrismaModule, AgentAuthModule, AgentToolAuditModule],
  controllers: [SafeBookingReadController],
  providers: [SafeBookingReadService],
  exports: [SafeBookingReadService],
})
export class SafeBookingReadModule {}
