import { Module } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { AgentChatController } from './agent-chat.controller';
import { AgentChatAccessService } from './agent-chat-access.service';
import { PrismaModule } from '@/prisma/prisma.module';
import { AuditModule } from '@/audit/audit.module';
import { CacheModule } from '@/cache/cache.module';
import { AgentAuthModule } from '@/agent-gateway/auth/agent-auth.module';
import { ChatMessageCryptoService } from './chat-message-crypto.service';

@Module({
  imports: [PrismaModule, AuditModule, CacheModule, AgentAuthModule],
  controllers: [ChatController, AgentChatController],
  providers: [ChatService, ChatMessageCryptoService, AgentChatAccessService],
  exports: [ChatService, ChatMessageCryptoService, AgentChatAccessService],
})
export class ChatModule {}

