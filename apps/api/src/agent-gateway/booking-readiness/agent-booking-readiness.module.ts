import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { ProfileModule } from '@/profile/profile.module';
import { BookingIntentModule } from '@/booking-intent/booking-intent.module';
import { AuditModule } from '@/audit/audit.module';
import { AgentAuthModule } from '../auth/agent-auth.module';
import { AgentToolAuditModule } from '../audit/agent-tool-audit.module';
import { AgentBookingReadinessController } from './agent-booking-readiness.controller';
import { AgentBookingReadinessService } from './agent-booking-readiness.service';

@Module({
  imports: [
    PrismaModule,
    ProfileModule,
    forwardRef(() => BookingIntentModule),
    AuditModule,
    AgentAuthModule,
    AgentToolAuditModule,
  ],
  controllers: [AgentBookingReadinessController],
  providers: [AgentBookingReadinessService],
  exports: [AgentBookingReadinessService],
})
export class AgentBookingReadinessModule {}
