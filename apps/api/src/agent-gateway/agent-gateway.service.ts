import { Injectable, NotFoundException, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { CacheService } from '@/cache/cache.service';
import { ChatService } from '@/chat/chat.service';
import { MessageSender, MessageType, ChatSession, ChatMessage } from '@prisma/client';

@Injectable()
export class AgentGatewayService {
  private readonly logger = new Logger(AgentGatewayService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: CacheService,
    private readonly chatService: ChatService,
  ) {}

  /**
   * Verifies user active status and token non-revocation.
   */
  async checkUserAccess(dto: { sub: string; jti?: string; exp?: number }): Promise<{ allowed: boolean }> {
    const user = await this.prisma.user.findUnique({
      where: { id: dto.sub },
    });

    if (!user || user.status !== 'ACTIVE') {
      throw new HttpException(
        { code: 'UNAUTHORIZED', message: 'User is inactive or not found' },
        HttpStatus.UNAUTHORIZED,
      );
    }

    if (dto.jti) {
      const isJtiBlacklisted = await this.cacheService.get(`blacklist:jti:${dto.jti}`);
      if (isJtiBlacklisted) {
        throw new HttpException(
          { code: 'UNAUTHORIZED', message: 'Token JTI has been revoked' },
          HttpStatus.UNAUTHORIZED,
        );
      }
    }

    return { allowed: true };
  }

  /**
   * Validates fencing token using Redis session lock if Phase 4 write fence is enabled.
   */
  async validateFencingToken(
    userId: string,
    sessionId: string,
    fencingToken?: string | null,
  ): Promise<void> {
    return this.chatService.validateFencingToken(userId, sessionId, fencingToken);
  }

  /**
   * Creates a chat session for a claimed user.
   */
  async createSession(userId: string, title?: string): Promise<ChatSession> {
    return this.chatService.createSession(userId, title);
  }

  /**
   * Gets memory for a session.
   */
  async getMemory(
    userId: string,
    sessionId: string,
    query: { recentCount?: number; unsummarizedOnly?: boolean },
  ): Promise<{
    summary: string | null;
    recentMessages: Array<{ id: string; sender: MessageSender; content: string; createdAt: Date }>;
    totalMessageCount: number;
  }> {
    return this.chatService.getMemory(userId, sessionId, {
      recentCount: query.recentCount || 20,
      unsummarizedOnly: query.unsummarizedOnly || false,
    });
  }

  /**
   * Creates a chat message in the session with write fence validation.
   */
  async createChatMessage(
    userId: string,
    sessionId: string,
    dto: { sender: string; content: string; type?: string },
    fencingToken?: string | null,
  ): Promise<ChatMessage> {
    try {
      return await this.chatService.createMessage(
        userId,
        sessionId,
        {
          sender: (dto.sender as MessageSender) || MessageSender.USER,
          content: dto.content,
          type: (dto.type as MessageType) || MessageType.STANDARD,
        },
        undefined,
        undefined,
        undefined,
        fencingToken || undefined,
      );
    } catch (err) {
      if (err instanceof NotFoundException) {
        throw new NotFoundException({
          statusCode: 404,
          message: 'Session not found',
          code: 'CHAT_SESSION_NOT_FOUND',
        });
      }
      throw err;
    }
  }

  async createMessageBatch(
    userId: string,
    sessionId: string,
    dto: { messages: Array<{ sender: string; content: string; type?: string }> },
    fencingToken?: string | null,
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
      return await this.chatService.createMessageBatch(
        userId,
        sessionId,
        {
          messages: dto.messages.map((m) => ({
            sender: (m.sender as MessageSender) || MessageSender.USER,
            content: m.content,
            type: (m.type as MessageType) || MessageType.STANDARD,
          })),
        },
        undefined,
        undefined,
        undefined,
        fencingToken || undefined,
      );
    } catch (err) {
      if (err instanceof NotFoundException) {
        throw new NotFoundException({
          statusCode: 404,
          message: 'Session not found',
          code: 'CHAT_SESSION_NOT_FOUND',
        });
      }
      throw err;
    }
  }

  /**
   * Soft deletes a chat session.
   */
  async deleteSession(userId: string, sessionId: string): Promise<void> {
    await this.chatService.deleteSession(userId, sessionId);
  }
}
