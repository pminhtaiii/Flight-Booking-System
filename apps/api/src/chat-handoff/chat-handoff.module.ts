import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '@/prisma/prisma.module';
import { ChatHandoffService } from './chat-handoff.service';
import { ChatHandoffController } from './chat-handoff.controller';
import { AgentGatewayModule } from '@/agent-gateway/agent-gateway.module';
import { ChatHandoffTokenService } from './chat-handoff-token.service';

@Module({
  imports: [PrismaModule, ConfigModule, forwardRef(() => AgentGatewayModule)],
  controllers: [ChatHandoffController],
  providers: [ChatHandoffService, ChatHandoffTokenService],
  exports: [ChatHandoffService, ChatHandoffTokenService],
})
export class ChatHandoffModule {}
