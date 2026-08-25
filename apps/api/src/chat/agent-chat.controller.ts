import {
  Controller,
  UseGuards,
  Post,
  Get,
  Delete,
  HttpCode,
  Req,
  Body,
  Param,
  Headers,
  Query,
  NotFoundException,
} from '@nestjs/common';
import { Request } from 'express';
import { AgentApiKeyGuard } from '@/agent-gateway/auth/agent-api-key.guard';
import { ClaimTokenGuard } from '@/agent-gateway/auth/claim-token.guard';
import { ChatService } from '@/chat/chat.service';
import { AgentChatAccessService, CheckUserAccessDto } from './agent-chat-access.service';
import { MemoryQueryDto } from './dto/memory-query.dto';
import { MessageSender, MessageType } from '@prisma/client';

export interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email: string;
  };
}

@Controller('agent-gateway/chat')
@UseGuards(AgentApiKeyGuard, ClaimTokenGuard)
export class AgentChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly agentChatAccessService: AgentChatAccessService,
  ) {}

  @Post('access/check')
  @HttpCode(200)
  async checkAccess(
    @Body() dto: CheckUserAccessDto,
  ) {
    return await this.agentChatAccessService.checkUserAccess(dto);
  }

  @Post('sessions')
  @HttpCode(201)
  async createSession(
    @Req() req: AuthenticatedRequest,
    @Body() dto: { title?: string },
  ) {
    return await this.chatService.createSession(req.user.id, dto.title);
  }

  @Get('sessions/:sessionId/memory')
  @HttpCode(200)
  async getMemory(
    @Param('sessionId') sessionId: string,
    @Req() req: AuthenticatedRequest,
    @Query() query: MemoryQueryDto,
  ) {
    return await this.chatService.getMemory(req.user.id, sessionId, {
      recentCount: query?.recentCount || 20,
      unsummarizedOnly: query?.unsummarizedOnly || false,
    });
  }

  @Post('sessions/:sessionId/messages')
  @HttpCode(201)
  async createMessage(
    @Param('sessionId') sessionId: string,
    @Req() req: AuthenticatedRequest,
    @Headers() headers: Record<string, string>,
    @Body() dto: { sender: string; content: string; type?: string },
  ) {
    const fencingToken =
      headers?.['x-fencing-token'] || headers?.['X-Fencing-Token'] || undefined;

    try {
      return await this.chatService.createMessage(
        req.user.id,
        sessionId,
        {
          sender: (dto.sender as MessageSender) || MessageSender.USER,
          content: dto.content,
          type: (dto.type as MessageType) || MessageType.STANDARD,
        },
        undefined,
        undefined,
        undefined,
        fencingToken,
      );
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new NotFoundException({
          statusCode: 404,
          message: 'Session not found',
          code: 'CHAT_SESSION_NOT_FOUND',
        });
      }
      throw error;
    }
  }

  @Post('sessions/:sessionId/turns')
  @HttpCode(201)
  async createTurn(
    @Param('sessionId') sessionId: string,
    @Req() req: AuthenticatedRequest,
    @Headers() headers: Record<string, string>,
    @Body() dto: { messages: Array<{ sender?: string; content?: string; type?: string }> },
  ) {
    const fencingToken =
      headers?.['x-fencing-token'] || headers?.['X-Fencing-Token'] || undefined;

    try {
      return await this.chatService.createMessageBatch(
        req.user.id,
        sessionId,
        {
          messages: (dto.messages || []).map((m) => ({
            sender: (m.sender as MessageSender) || MessageSender.USER,
            content: m.content || '',
            type: (m.type as MessageType) || MessageType.STANDARD,
          })),
        },
        undefined,
        undefined,
        undefined,
        fencingToken,
      );
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new NotFoundException({
          statusCode: 404,
          message: 'Session not found',
          code: 'CHAT_SESSION_NOT_FOUND',
        });
      }
      throw error;
    }
  }

  @Post('sessions/:sessionId/summaries')
  @HttpCode(201)
  async createSummary(
    @Param('sessionId') sessionId: string,
    @Req() req: AuthenticatedRequest,
    @Headers() headers: Record<string, string>,
    @Body() dto: { content: string },
  ) {
    const fencingToken =
      headers?.['x-fencing-token'] || headers?.['X-Fencing-Token'] || undefined;

    try {
      return await this.chatService.createMessage(
        req.user.id,
        sessionId,
        {
          sender: MessageSender.AGENT,
          content: dto.content,
          type: MessageType.SUMMARY,
        },
        undefined,
        undefined,
        undefined,
        fencingToken,
      );
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new NotFoundException({
          statusCode: 404,
          message: 'Session not found',
          code: 'CHAT_SESSION_NOT_FOUND',
        });
      }
      throw error;
    }
  }

  @Delete('sessions/:sessionId')
  @HttpCode(204)
  async deleteSession(
    @Param('sessionId') sessionId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return await this.chatService.deleteSession(req.user.id, sessionId);
  }
}
