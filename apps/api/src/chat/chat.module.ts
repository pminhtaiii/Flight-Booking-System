import { Module } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { PrismaModule } from '@/prisma/prisma.module';
import { AuditModule } from '@/audit/audit.module';
import { CacheModule } from '@/cache/cache.module';
import { ChatMessageCryptoModule } from '@/common/chat-message-crypto.module';

@Module({
  imports: [PrismaModule, AuditModule, CacheModule, ChatMessageCryptoModule],
  controllers: [ChatController],
  providers: [ChatService],
  exports: [ChatService],
})
export class ChatModule {}
