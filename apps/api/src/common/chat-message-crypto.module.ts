import { Module } from '@nestjs/common';
import { ChatMessageCryptoService } from './chat-message-crypto.service';

@Module({
  providers: [ChatMessageCryptoService],
  exports: [ChatMessageCryptoService],
})
export class ChatMessageCryptoModule {}
