import {
  Controller,
  UseGuards,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Query,
  Param,
  Req,
  Headers,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';
import { ChatService } from './chat.service';
import { CreateSessionDto } from './dto/create-session.dto';
import { ListSessionsQueryDto } from './dto/list-sessions-query.dto';
import { UpdateSessionDto } from './dto/update-session.dto';
import { CreateMessageDto } from './dto/create-message.dto';
import { ListMessagesQueryDto } from './dto/list-messages-query.dto';
import { BatchMessagesDto } from './dto/batch-messages.dto';
import { MemoryQueryDto } from './dto/memory-query.dto';
import { Request } from 'express';

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email: string;
  };
}

@Controller('chat')
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  private getRequestDetails(req: Request, headers: Record<string, string>) {
    const rawIp = req.ip || req.socket?.remoteAddress || '127.0.0.1';
    const ipAddress = typeof rawIp === 'string' ? rawIp.split(',')[0].trim() : '127.0.0.1';
    const traceId = headers['x-trace-id'] || undefined;
    const correlationId = headers['x-correlation-id'] || undefined;
    return { ipAddress, traceId, correlationId };
  }

  @Post('sessions')
  @HttpCode(HttpStatus.CREATED)
  async createSession(
    @Req() req: AuthenticatedRequest,
    @Headers() headers: Record<string, string>,
    @Body() dto: CreateSessionDto,
  ) {
    const { ipAddress, traceId, correlationId } = this.getRequestDetails(req, headers);
    return this.chatService.createSession(
      req.user.id,
      dto.title,
      ipAddress,
      traceId,
      correlationId,
    );
  }

  @Get('sessions')
  async listSessions(@Req() req: AuthenticatedRequest, @Query() query: ListSessionsQueryDto) {
    return this.chatService.listSessions(req.user.id, query);
  }

  @Get('sessions/:sessionId')
  async getSession(@Req() req: AuthenticatedRequest, @Param('sessionId') sessionId: string) {
    return this.chatService.getSession(req.user.id, sessionId);
  }

  @Patch('sessions/:sessionId')
  async updateSession(
    @Req() req: AuthenticatedRequest,
    @Headers() headers: Record<string, string>,
    @Param('sessionId') sessionId: string,
    @Body() dto: UpdateSessionDto,
  ) {
    const { ipAddress, traceId, correlationId } = this.getRequestDetails(req, headers);
    return this.chatService.updateSession(
      req.user.id,
      sessionId,
      dto.title,
      ipAddress,
      traceId,
      correlationId,
    );
  }

  @Delete('sessions/:sessionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteSession(
    @Req() req: AuthenticatedRequest,
    @Headers() headers: Record<string, string>,
    @Param('sessionId') sessionId: string,
  ) {
    const { ipAddress, traceId, correlationId } = this.getRequestDetails(req, headers);
    await this.chatService.deleteSession(req.user.id, sessionId, ipAddress, traceId, correlationId);
  }

  @Post('sessions/:sessionId/messages')
  @HttpCode(HttpStatus.CREATED)
  async createMessage(
    @Req() req: AuthenticatedRequest,
    @Headers() headers: Record<string, string>,
    @Param('sessionId') sessionId: string,
    @Body() dto: CreateMessageDto,
  ) {
    const { ipAddress, traceId, correlationId } = this.getRequestDetails(req, headers);
    return this.chatService.createMessage(
      req.user.id,
      sessionId,
      dto,
      ipAddress,
      traceId,
      correlationId,
    );
  }

  @Get('sessions/:sessionId/messages')
  async listMessages(
    @Req() req: AuthenticatedRequest,
    @Param('sessionId') sessionId: string,
    @Query() query: ListMessagesQueryDto,
  ) {
    return this.chatService.listMessages(req.user.id, sessionId, query);
  }

  @Post('sessions/:sessionId/messages/batch')
  @HttpCode(HttpStatus.CREATED)
  async createMessageBatch(
    @Req() req: AuthenticatedRequest,
    @Headers() headers: Record<string, string>,
    @Param('sessionId') sessionId: string,
    @Body() dto: BatchMessagesDto,
  ) {
    const { ipAddress, traceId, correlationId } = this.getRequestDetails(req, headers);
    return this.chatService.createMessageBatch(
      req.user.id,
      sessionId,
      dto,
      ipAddress,
      traceId,
      correlationId,
    );
  }

  @Get('sessions/:sessionId/memory')
  async getMemory(
    @Req() req: AuthenticatedRequest,
    @Param('sessionId') sessionId: string,
    @Query() query: MemoryQueryDto,
  ) {
    return this.chatService.getMemory(req.user.id, sessionId, query);
  }
}
