import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { DuffelModule } from '@/duffel/duffel.module';
import { PaymentModule } from '@/payment/payment.module';
import { AgentGatewayModule } from '@/agent-gateway/agent-gateway.module';
import { CancellationService } from './cancellation.service';

@Module({
  imports: [PrismaModule, DuffelModule, PaymentModule, AgentGatewayModule],
  providers: [CancellationService],
  exports: [CancellationService],
})
export class CancellationModule {}
