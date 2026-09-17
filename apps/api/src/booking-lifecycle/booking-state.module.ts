import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { DomainEventsModule } from '@/domain-events/domain-events.module';
import { AgentGatewayModule } from '@/agent-gateway/agent-gateway.module';
import { BookingLifecycleService } from './booking-lifecycle.service';

@Module({
  imports: [PrismaModule, DomainEventsModule, AgentGatewayModule],
  providers: [BookingLifecycleService],
  exports: [BookingLifecycleService],
})
export class BookingStateModule {}
