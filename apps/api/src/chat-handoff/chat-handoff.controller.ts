import { Controller, Get, Post, Body, ServiceUnavailableException, UseGuards, Request, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatHandoffService } from './chat-handoff.service';
import { CreateChatHandoffDto } from './dto/create-chat-handoff.dto';
import { ResolveChatHandoffDto } from './dto/resolve-chat-handoff.dto';
import { AgentApiKeyGuard } from '@/agent-gateway/auth/agent-api-key.guard';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';

@Controller('chat-handoff')
export class ChatHandoffController {
  constructor(
    private readonly chatHandoffService: ChatHandoffService,
    private readonly configService: ConfigService,
  ) {}

  @Post()
  @UseGuards(AgentApiKeyGuard)
  async create(@Body() dto: CreateChatHandoffDto) {
    const isEnabled = this.configService.get<string>('FEATURE_FLAG_CHAT_HANDOFF_ACCEPT') === 'true';
    if (!isEnabled) {
      throw new ServiceUnavailableException('Chat handoff feature is not enabled');
    }
    return this.chatHandoffService.create(dto);
  }

  @Get('resolve')
  @UseGuards(JwtAuthGuard)
  async resolve(@Query() query: ResolveChatHandoffDto, @Request() req: any) {
    const isEnabled = this.configService.get<string>('FEATURE_FLAG_CHAT_HANDOFF_ISSUE') === 'true';
    if (!isEnabled) {
      throw new ServiceUnavailableException('Chat handoff feature is not enabled');
    }
    const userId = req.user?.id || req.user?.sub;
    return this.chatHandoffService.resolve(query.token, userId);
  }
}
