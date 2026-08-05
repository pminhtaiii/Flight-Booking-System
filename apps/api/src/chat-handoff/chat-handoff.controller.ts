import { Controller, Get, Post, Body, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatHandoffService } from './chat-handoff.service';
import { CreateChatHandoffDto } from './dto/create-chat-handoff.dto';

/**
 * ChatHandoffController — all routes are flag-gated and inert.
 *
 * Routes throw ServiceUnavailableException until the corresponding
 * feature flags are enabled:
 *   FEATURE_FLAG_CHAT_HANDOFF_ACCEPT — enables the create() endpoint
 *   FEATURE_FLAG_CHAT_HANDOFF_ISSUE  — enables the resolve() endpoint
 */
@Controller('api/chat-handoff')
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
  async create(@Body() _dto: CreateChatHandoffDto): Promise<never> {
    throw new ServiceUnavailableException(
      'Chat handoff feature is not enabled',
    );
  }

  /**
   * GET /api/chat-handoff/resolve
   * Resolves a handoff token.
   * Inert until FEATURE_FLAG_CHAT_HANDOFF_ISSUE=true.
   */
  @Get('resolve')
  async resolve(): Promise<never> {
    throw new ServiceUnavailableException(
      'Chat handoff feature is not enabled',
    );
  }
}
