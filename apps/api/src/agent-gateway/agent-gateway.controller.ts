import { Controller, Req, UseGuards, Logger, Headers, Param, Body, Post, Get, Delete, HttpCode, Query } from '@nestjs/common';
import { Request } from 'express';
import { AgentApiKeyGuard } from './auth/agent-api-key.guard';
import { ClaimTokenGuard } from './auth/claim-token.guard';
import { AgentGatewayService } from './agent-gateway.service';
import { MemoryQueryDto } from '@/chat/dto/memory-query.dto';
import { ChatSession, ChatMessage, MessageSender, MessageType } from '@prisma/client';

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email: string;
  };
}

@Controller('agent-gateway')
@UseGuards(AgentApiKeyGuard, ClaimTokenGuard)
export class AgentGatewayController {
  private readonly logger = new Logger(AgentGatewayController.name);

  constructor(private readonly agentGatewayService: AgentGatewayService) {}

  @Post('chat/access/check')
  @HttpCode(200)
  async checkAccess(
    @Body() dto: { sub: string; jti?: string; exp?: number },
  ): Promise<{ allowed: boolean }> {
    try {
      return await this.agentGatewayService.checkUserAccess(dto);
    } catch (err) {
      this.logger.error('Failed to check user access');
      throw err;
    }
  }

  @Post('chat/sessions')
  @HttpCode(201)
  async createSession(
    @Req() req: AuthenticatedRequest,
    @Body() dto: { title?: string },
  ): Promise<ChatSession> {
    try {
      return await this.agentGatewayService.createSession(req.user.id, dto.title);
    } catch (err) {
      this.logger.error('Failed to create session');
      throw err;
    }
  }

  @Get('chat/sessions/:sessionId/memory')
  async getMemory(
    @Param('sessionId') sessionId: string,
    @Req() req: AuthenticatedRequest,
    @Query() query: MemoryQueryDto,
  ): Promise<{
    summary: string | null;
    recentMessages: Array<{ id: string; sender: MessageSender; content: string; createdAt: Date }>;
    totalMessageCount: number;
  }> {
    try {
      return await this.agentGatewayService.getMemory(req.user.id, sessionId, query);
    } catch (err) {
      this.logger.error('Failed to get memory');
      throw err;
    }
  }

  @Post('chat/sessions/:sessionId/messages')
  @HttpCode(201)
  async createChatMessage(
    @Param('sessionId') sessionId: string,
    @Req() req: AuthenticatedRequest,
    @Headers() headers: Record<string, string>,
    @Body() dto: { sender: string; content: string; type?: string },
  ): Promise<ChatMessage> {
    try {
      const fencingToken = headers['x-fencing-token'] || headers['X-Fencing-Token'];
      return await this.agentGatewayService.createChatMessage(req.user.id, sessionId, dto, fencingToken);
    } catch (err) {
      this.logger.error('Failed to create chat message');
      throw err;
    }
  }

  @Post('chat/sessions/:sessionId/turns')
  @HttpCode(201)
  async createChatTurn(
    @Param('sessionId') sessionId: string,
    @Req() req: AuthenticatedRequest,
    @Headers() headers: Record<string, string>,
    @Body() dto: { messages: Array<{ sender?: string; content?: string; type?: string }> },
  ): Promise<{
    messages: Array<{
      id: string;
      sessionId: string;
      sender: MessageSender;
      type: MessageType;
      content: string;
      createdAt: Date;
    }>;
  }> {
    try {
      const fencingToken = headers['x-fencing-token'] || headers['X-Fencing-Token'];
      return await this.agentGatewayService.createMessageBatch(
        req.user.id,
        sessionId,
        {
          messages: dto.messages.map(m => ({
            sender: m.sender || 'USER',
            content: m.content || '',
            type: m.type || 'STANDARD',
          })),
        },
        fencingToken,
      );
    } catch (err) {
      this.logger.error('Failed to create chat turn');
      throw err;
    }
  }

  @Post('chat/sessions/:sessionId/summaries')
  @HttpCode(201)
  async createChatSummary(
    @Param('sessionId') sessionId: string,
    @Req() req: AuthenticatedRequest,
    @Headers() headers: Record<string, string>,
    @Body() dto: { content: string },
  ): Promise<ChatMessage> {
    try {
      const fencingToken = headers['x-fencing-token'] || headers['X-Fencing-Token'];
      return await this.agentGatewayService.createChatMessage(
        req.user.id,
        sessionId,
        {
          sender: 'AGENT',
          content: dto.content,
          type: 'SUMMARY',
        },
        fencingToken,
      );
    } catch (err) {
      this.logger.error('Failed to create chat summary');
      throw err;
    }
  }

  @Delete('chat/sessions/:sessionId')
  @HttpCode(204)
  async deleteSession(
    @Param('sessionId') sessionId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    try {
      await this.agentGatewayService.deleteSession(req.user.id, sessionId);
    } catch (err) {
      this.logger.error('Failed to delete session');
      throw err;
    }
  }
}
