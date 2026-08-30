import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '@/prisma/prisma.module';
import { ChatHandoffService } from './chat-handoff.service';
import { ChatHandoffController } from './chat-handoff.controller';
import { BookingHandoffController } from './booking-handoff.controller';
import { AgentAuthModule } from '@/agent-gateway/auth/agent-auth.module';
import { ChatHandoffTokenService } from './chat-handoff-token.service';
import { SelectionAttestationService } from '@/agent-gateway/selection-attestation.service';

@Module({
  imports: [PrismaModule, ConfigModule, AgentAuthModule],
  controllers: [ChatHandoffController, BookingHandoffController],
  providers: [ChatHandoffService, ChatHandoffTokenService, SelectionAttestationService],
  exports: [ChatHandoffService, ChatHandoffTokenService],
})
export class ChatHandoffModule {}
