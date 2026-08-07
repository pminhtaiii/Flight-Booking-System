import { Module } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { PrismaModule } from '@/prisma/prisma.module';
import { AuditModule } from '@/audit/audit.module';
import { ChatMessageCryptoService } from './chat-message-crypto.service';

@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [ChatController],
  providers: [ChatService, ChatMessageCryptoService],
  exports: [ChatService, ChatMessageCryptoService],
})
export class ChatModule {}
