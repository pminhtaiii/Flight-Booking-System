import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { ChatHandoffService, type ChatHandoffSafeResolveResponse } from './chat-handoff.service';
import { CreateChatHandoffDto } from './dto/create-chat-handoff.dto';
import { ResolveChatHandoffDto } from './dto/resolve-chat-handoff.dto';
import { ChatHandoffResponseDto } from './dto/chat-handoff-response.dto';
import { AgentApiKeyGuard } from '@/agent-gateway/auth/agent-api-key.guard';
import { ClaimTokenGuard } from '@/agent-gateway/auth/claim-token.guard';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';

type AuthenticatedRequest = {
  user?: {
    id?: string;
    sub?: string;
  };
};

@Controller('chat-handoff')
export class ChatHandoffController {
  private readonly logger = new Logger(ChatHandoffController.name);

  constructor(
    private readonly chatHandoffService: ChatHandoffService,
    private readonly configService: ConfigService,
  ) {}

  @Post()
  @UseGuards(AgentApiKeyGuard, ClaimTokenGuard)
  async create(
    @Body() dto: CreateChatHandoffDto,
    @Req() req: AuthenticatedRequest,
    @Headers('X-Trace-Id') traceId?: string,
    @Headers('X-Correlation-Id') correlationId?: string,
  ): Promise<ChatHandoffResponseDto> {
    try {
      this.assertIssuanceEnabled();
      const userId = this.userId(req);
      return await this.chatHandoffService.create(dto, { traceId, correlationId }, userId);
    } catch (error) {
      this.logger.warn(
        `[create] Failed to create chat handoff: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      throw error;
    }
  }

  @Post('tokens')
  @UseGuards(AgentApiKeyGuard, ClaimTokenGuard)
  async createTokens(
    @Body() dto: CreateChatHandoffDto,
    @Req() req: AuthenticatedRequest,
    @Headers('X-Trace-Id') traceId?: string,
    @Headers('X-Correlation-Id') correlationId?: string,
  ): Promise<ChatHandoffResponseDto> {
    try {
      return await this.create(dto, req, traceId, correlationId);
    } catch (error) {
      this.logger.warn(
        `[createTokens] Failed to create chat handoff tokens: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      throw error;
    }
  }

  @Get('resolve')
  @UseGuards(JwtAuthGuard)
  async resolve(
    @Query() query: ResolveChatHandoffDto,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res?: Response,
    @Headers('X-Trace-Id') traceId?: string,
    @Headers('X-Correlation-Id') correlationId?: string,
  ): Promise<ChatHandoffSafeResolveResponse> {
    try {
      this.assertAcceptanceEnabled();
      res?.setHeader('Cache-Control', 'no-store, private');
      const token = query.token ?? query.handoffToken;
      if (!token) {
        throw new UnauthorizedException('Invalid handoff token');
      }
      return await this.chatHandoffService.resolveSafe(token, this.userId(req), {
        traceId,
        correlationId,
      });
    } catch (error) {
      this.logger.warn(
        `[resolve] Failed to resolve chat handoff: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      throw error;
    }
  }

  @Post('resolve')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async resolvePost(
    @Body() body: ResolveChatHandoffDto,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res?: Response,
    @Headers('X-Trace-Id') traceId?: string,
    @Headers('X-Correlation-Id') correlationId?: string,
  ): Promise<ChatHandoffSafeResolveResponse> {
    try {
      this.assertAcceptanceEnabled();
      res?.setHeader('Cache-Control', 'no-store, private');
      const token = body.token ?? body.handoffToken;
      if (!token) {
        throw new UnauthorizedException('Invalid handoff token');
      }
      return await this.chatHandoffService.resolveSafe(token, this.userId(req), {
        traceId,
        correlationId,
      });
    } catch (error) {
      this.logger.warn(
        `[resolvePost] Failed to resolve chat handoff: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      throw error;
    }
  }

  private assertIssuanceEnabled(): void {
    const isEnabled = this.configService.get<string>('FEATURE_FLAG_CHAT_HANDOFF_ISSUE') === 'true';
    if (!isEnabled) {
      throw new ServiceUnavailableException('Chat handoff issuance is disabled');
    }
  }

  private assertAcceptanceEnabled(): void {
    const isEnabled = this.configService.get<string>('FEATURE_FLAG_CHAT_HANDOFF_ACCEPT') === 'true';
    if (!isEnabled) {
      throw new ServiceUnavailableException('Chat handoff acceptance is disabled');
    }
  }

  private userId(req: AuthenticatedRequest): string {
    const userId = req.user?.id ?? req.user?.sub;
    if (!userId) {
      throw new UnauthorizedException('Authenticated user identity is missing');
    }
    return userId;
  }
}
