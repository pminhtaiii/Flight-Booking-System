import { Module } from '@nestjs/common';
import { ChatModule } from '@/chat/chat.module';
import { AgentAuthModule } from '@/agent-gateway/auth/agent-auth.module';
import { PrismaModule } from '@/prisma/prisma.module';
import { CacheModule } from '@/cache/cache.module';
import { AgentChatController } from './agent-chat.controller';
import { AgentChatAccessService } from './agent-chat-access.service';

@Module({
  imports: [ChatModule, AgentAuthModule, PrismaModule, CacheModule],
  controllers: [AgentChatController],
  providers: [AgentChatAccessService],
  exports: [AgentChatAccessService],
})
export class AgentChatModule {}
