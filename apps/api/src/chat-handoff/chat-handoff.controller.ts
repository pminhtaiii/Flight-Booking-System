import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatHandoffService } from './chat-handoff.service';
import { CreateChatHandoffDto } from './dto/create-chat-handoff.dto';
import { ResolveChatHandoffDto } from './dto/resolve-chat-handoff.dto';
import { AgentApiKeyGuard } from '@/agent-gateway/auth/agent-api-key.guard';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';

type AuthenticatedRequest = {
  user: {
    id?: string;
    sub?: string;
  };
};

@Controller('chat-handoff')
export class ChatHandoffController {
  constructor(
    private readonly chatHandoffService: ChatHandoffService,
    private readonly configService: ConfigService,
  ) {}

  @Post()
  @UseGuards(AgentApiKeyGuard)
  async create(
    @Body() dto: CreateChatHandoffDto,
    @Headers('X-Trace-Id') traceId?: string,
    @Headers('X-Correlation-Id') correlationId?: string,
  ) {
    const isEnabled = this.configService.get<string>('FEATURE_FLAG_CHAT_HANDOFF_ISSUE') === 'true';
    if (!isEnabled) {
      throw new ServiceUnavailableException('Chat handoff issuance is disabled');
    }
    return this.chatHandoffService.create(dto, { traceId, correlationId });
  }

  @Get('resolve')
  @UseGuards(JwtAuthGuard)
  async resolve(
    @Query() query: ResolveChatHandoffDto,
    @Req() req: AuthenticatedRequest,
    @Headers('X-Trace-Id') traceId?: string,
    @Headers('X-Correlation-Id') correlationId?: string,
  ): Promise<unknown> {
    this.assertAcceptanceEnabled();
    return this.chatHandoffService.resolve(
      query.token,
      this.userId(req),
      { traceId, correlationId },
    );
  }

  private assertAcceptanceEnabled(): void {
    const isEnabled = this.configService.get<string>('FEATURE_FLAG_CHAT_HANDOFF_ACCEPT') === 'true';
    if (!isEnabled) {
      throw new ServiceUnavailableException('Chat handoff acceptance is disabled');
    }
  }

  private userId(req: AuthenticatedRequest): string {
    const userId = req.user.id ?? req.user.sub;
    if (!userId) {
      throw new UnauthorizedException('Authenticated user identity is missing');
    }
    return userId;
  }
}
