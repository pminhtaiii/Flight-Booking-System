import { Controller, Get, Post, Body, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatHandoffService } from './chat-handoff.service';
import { CreateChatHandoffDto } from './dto/create-chat-handoff.dto';

/**
 * ChatHandoffController — all routes are flag-gated.
 *
 * Routes throw ServiceUnavailableException if their corresponding
 * feature flags are disabled:
 *   FEATURE_FLAG_CHAT_HANDOFF_ACCEPT — enables the create() endpoint
 *   FEATURE_FLAG_CHAT_HANDOFF_ISSUE  — enables the resolve() endpoint
 */
@Controller('chat-handoff')
export class ChatHandoffController {
  constructor(
    private readonly chatHandoffService: ChatHandoffService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * POST /api/chat-handoff
   * Creates a new handoff claim.
   * Inert until FEATURE_FLAG_CHAT_HANDOFF_ACCEPT=true.
   */
  @Post()
  async create(@Body() dto: CreateChatHandoffDto) {
    const isEnabled =
      this.configService.get<string>('FEATURE_FLAG_CHAT_HANDOFF_ACCEPT') === 'true';
    if (!isEnabled) {
      throw new ServiceUnavailableException(
        'Chat handoff feature is not enabled',
      );
    }
    return this.chatHandoffService.create(dto);
  }

  /**
   * GET /api/chat-handoff/resolve
   * Resolves a handoff token.
   * Inert until FEATURE_FLAG_CHAT_HANDOFF_ISSUE=true.
   */
  @Get('resolve')
  async resolve() {
    const isEnabled =
      this.configService.get<string>('FEATURE_FLAG_CHAT_HANDOFF_ISSUE') === 'true';
    if (!isEnabled) {
      throw new ServiceUnavailableException(
        'Chat handoff feature is not enabled',
      );
    }
    return this.chatHandoffService.resolve('', '');
  }
}

