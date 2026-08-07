import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '@/prisma/prisma.module';
import { ChatHandoffService } from './chat-handoff.service';
import { ChatHandoffController } from './chat-handoff.controller';

@Module({
  imports: [PrismaModule, ConfigModule],
  controllers: [ChatHandoffController],
  providers: [ChatHandoffService],
  exports: [ChatHandoffService],
})
export class ChatHandoffModule {}
