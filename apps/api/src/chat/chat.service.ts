import { Injectable, NotFoundException, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CacheService } from '@/cache/cache.service';
import { PrismaService } from '@/prisma/prisma.service';
import { AuditService } from '@/audit/audit.service';
import { ChatMessageCryptoService } from './chat-message-crypto.service';
import { ListSessionsQueryDto } from './dto/list-sessions-query.dto';
import { CreateMessageDto } from './dto/create-message.dto';
import { BatchMessagesDto } from './dto/batch-messages.dto';
import { ListMessagesQueryDto } from './dto/list-messages-query.dto';
import { MemoryQueryDto } from './dto/memory-query.dto';
import { Prisma, ChatMessage, MessageSender, MessageType } from '@prisma/client';
import * as crypto from 'crypto';

@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly cacheService: CacheService,
    private readonly configService: ConfigService,
    private readonly cryptoService: ChatMessageCryptoService,
  ) {}

  async validateFencingToken(
    userId: string,
    sessionId: string,
    fencingToken?: string | null,
  ): Promise<void> {
    const isWriteFenceEnabled =
      this.configService.get<string>('FEATURE_FLAG_WRITE_FENCE') === 'true' ||
      process.env.FEATURE_FLAG_WRITE_FENCE === 'true';

    if (!isWriteFenceEnabled) {
      return;
    }

    if (!fencingToken) {
      throw new HttpException(
        { code: 'MISSING_FENCING_TOKEN', message: 'Fencing token is required when write fence is enabled' },
        HttpStatus.BAD_REQUEST,
      );
    }

    const lockKey = `chat:session-lock:${userId}:${sessionId}`;
    const currentFence = await this.cacheService.hget(lockKey, 'fence');

    if (currentFence === null || String(currentFence) !== String(fencingToken)) {
      throw new HttpException(
        { code: 'STALE_FENCING_TOKEN', message: 'Fencing token is stale or invalid' },
        HttpStatus.CONFLICT,
      );
    }
  }

  async createSession(
    userId: string,
    title?: string,
    ipAddress?: string,
    traceId?: string,
    correlationId?: string,
  ) {
    const sessionId = crypto.randomUUID();
    let titleCiphertext: string | null = null;
    let titleNonce: string | null = null;
    let titleAuthTag: string | null = null;
    let titleKeyVersion: number | null = null;

    if (title && this.cryptoService.isConfigured()) {
      const encrypted = await this.cryptoService.encryptSessionTitle(sessionId, title);
      titleCiphertext = encrypted.ciphertext;
      titleNonce = encrypted.nonce;
      titleAuthTag = encrypted.authTag;
      titleKeyVersion = encrypted.keyVersion;
    }

    return this.prisma.$transaction(async (tx) => {
      const session = await tx.chatSession.create({
        data: {
          id: sessionId,
          userId,
          title: title || null,
          titleCiphertext,
          titleNonce,
          titleAuthTag,
          titleKeyVersion,
        },
      });

      await this.auditService.createLog(tx, {
        userId,
        action: 'chat_session_create',
        resourceType: 'ChatSession',
        resourceId: session.id,
        ipAddress,
        traceId,
        correlationId,
      });

      const decryptedTitle = await this.cryptoService.decryptSessionTitle(session);

      return {
        ...session,
        title: decryptedTitle,
      };
    });
  }

  async listSessions(userId: string, query: ListSessionsQueryDto) {
    const where: Prisma.ChatSessionWhereInput = {
      userId,
      deletedAt: null,
    };

    let cursorDate: Date | undefined;
    let cursorId: string | undefined;
    if (query.cursor) {
      const parts = query.cursor.split('_');
      cursorDate = new Date(parts[0]);
      cursorId = parts[1];

      where.OR = cursorId
        ? [{ lastActiveAt: { lt: cursorDate } }, { lastActiveAt: cursorDate, id: { lt: cursorId } }]
        : [{ lastActiveAt: { lt: cursorDate } }];
    }

    const sessions = await this.prisma.chatSession.findMany({
      where,
      take: query.limit + 1,
      orderBy: [{ lastActiveAt: 'desc' }, { id: 'desc' }],
      include: {
        messages: {
          where: {
            type: 'STANDARD',
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 1,
        },
      },
    });

    let nextCursor: string | null = null;
    const hasMore = sessions.length > query.limit;
    if (hasMore) {
      sessions.pop();
      const lastSession = sessions[sessions.length - 1];
      nextCursor = `${lastSession.lastActiveAt.toISOString()}_${lastSession.id}`;
    }

    const formattedSessions = await Promise.all(
      sessions.map(async (session) => {
        const decryptedTitle = await this.cryptoService.decryptSessionTitle(session);
        let preview: string | null = null;
        if (session.messages[0]) {
          preview = await this.cryptoService.decryptMessageContent(session.messages[0]);
        }

        return {
          id: session.id,
          title: decryptedTitle,
          createdAt: session.createdAt,
          lastActiveAt: session.lastActiveAt,
          messagePreview: preview,
        };
      }),
    );

    return {
      sessions: formattedSessions,
      nextCursor,
    };
  }

  async getSession(userId: string, sessionId: string) {
    const session = await this.prisma.chatSession.findFirst({
      where: {
        id: sessionId,
        userId,
        deletedAt: null,
      },
    });

    if (!session) {
      throw new NotFoundException('Session not found');
    }

    const messageCount = await this.prisma.chatMessage.count({
      where: {
        sessionId,
      },
    });

    const decryptedTitle = await this.cryptoService.decryptSessionTitle(session);

    return {
      ...session,
      title: decryptedTitle,
      messageCount,
    };
  }

  async updateSession(
    userId: string,
    sessionId: string,
    title?: string,
    ipAddress?: string,
    traceId?: string,
    correlationId?: string,
  ) {
    const session = await this.prisma.chatSession.findFirst({
      where: {
        id: sessionId,
        userId,
        deletedAt: null,
      },
    });

    if (!session) {
      throw new NotFoundException('Session not found');
    }

    let titleCiphertext: string | null = session.titleCiphertext;
    let titleNonce: string | null = session.titleNonce;
    let titleAuthTag: string | null = session.titleAuthTag;
    let titleKeyVersion: number | null = session.titleKeyVersion;

    if (title !== undefined && title !== null && this.cryptoService.isConfigured()) {
      const encrypted = await this.cryptoService.encryptSessionTitle(sessionId, title);
      titleCiphertext = encrypted.ciphertext;
      titleNonce = encrypted.nonce;
      titleAuthTag = encrypted.authTag;
      titleKeyVersion = encrypted.keyVersion;
    }

    return this.prisma.$transaction(async (tx) => {
      const updatedSession = await tx.chatSession.update({
        where: {
          id: sessionId,
        },
        data:
          title === undefined
            ? {}
            : {
                title,
                titleCiphertext,
                titleNonce,
                titleAuthTag,
                titleKeyVersion,
              },
      });

      await this.auditService.createLog(tx, {
        userId,
        action: 'chat_session_update',
        resourceType: 'ChatSession',
        resourceId: sessionId,
        ipAddress,
        traceId,
        correlationId,
      });

      const decryptedTitle = await this.cryptoService.decryptSessionTitle(updatedSession);

      return {
        ...updatedSession,
        title: decryptedTitle,
      };
    });
  }

  async deleteSession(
    userId: string,
    sessionId: string,
    ipAddress?: string,
    traceId?: string,
    correlationId?: string,
  ) {
    const session = await this.prisma.chatSession.findFirst({
      where: {
        id: sessionId,
        userId,
        deletedAt: null,
      },
    });

    if (!session) {
      throw new NotFoundException('Session not found');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.chatSession.update({
        where: {
          id: sessionId,
        },
        data: {
          deletedAt: new Date(),
        },
      });

      await this.auditService.createLog(tx, {
        userId,
        action: 'chat_session_delete',
        resourceType: 'ChatSession',
        resourceId: sessionId,
        ipAddress,
        traceId,
        correlationId,
      });
    });
  }

  async createMessage(
    userId: string,
    sessionId: string,
    dto: CreateMessageDto,
    ipAddress?: string,
    traceId?: string,
    correlationId?: string,
    fencingToken?: string,
  ) {
    await this.validateFencingToken(userId, sessionId, fencingToken);

    const session = await this.prisma.chatSession.findFirst({
      where: {
        id: sessionId,
        userId,
        deletedAt: null,
      },
    });

    if (!session) {
      throw new NotFoundException('Session not found');
    }

    const now = new Date();
    const messageId = crypto.randomUUID();
    const sender = dto.sender;
    const messageType = dto.type || 'STANDARD';
    const content = dto.content;

    let contentCiphertext: string | null = null;
    let contentNonce: string | null = null;
    let contentAuthTag: string | null = null;
    let contentKeyVersion: number | null = null;

    if (content && this.cryptoService.isConfigured()) {
      const encrypted = await this.cryptoService.encryptMessageContent(
        messageId,
        sessionId,
        sender,
        messageType,
        content,
      );
      contentCiphertext = encrypted.ciphertext;
      contentNonce = encrypted.nonce;
      contentAuthTag = encrypted.authTag;
      contentKeyVersion = encrypted.keyVersion;
    }

    return this.prisma.$transaction(async (tx) => {
      await this.validateFencingToken(userId, sessionId, fencingToken);

      const message = await tx.chatMessage.create({
        data: {
          id: messageId,
          sessionId,
          sender: sender as MessageSender,
          type: messageType as MessageType,
          content: contentCiphertext === null ? content : null,
          contentCiphertext,
          contentNonce,
          contentAuthTag,
          contentKeyVersion,
          createdAt: now,
        },
      });

      await tx.chatSession.update({
        where: {
          id: sessionId,
        },
        data: {
          lastActiveAt: now,
        },
      });

      await this.auditService.createLog(tx, {
        userId,
        action: 'chat_message_create',
        resourceType: 'ChatMessage',
        resourceId: message.id,
        ipAddress,
        traceId,
        correlationId,
      });

      const decryptedContent = await this.cryptoService.decryptMessageContent(message);

      return {
        ...message,
        content: decryptedContent,
      };
    });
  }

  async listMessages(userId: string, sessionId: string, query: ListMessagesQueryDto) {
    const session = await this.prisma.chatSession.findFirst({
      where: {
        id: sessionId,
        userId,
        deletedAt: null,
      },
    });

    if (!session) {
      throw new NotFoundException('Session not found');
    }

    const where: Prisma.ChatMessageWhereInput = {
      sessionId,
    };

    let cursorDate: Date | undefined;
    let cursorId: string | undefined;
    if (query.cursor) {
      const parts = query.cursor.split('_');
      if (parts.length === 2) {
        cursorDate = new Date(parts[0]);
        cursorId = parts[1];
      } else {
        cursorDate = new Date(query.cursor);
      }
    }

    let messages: ChatMessage[] = [];
    let nextCursor: string | null = null;

    if (query.direction === 'before') {
      if (cursorDate && cursorId) {
        where.OR = [
          {
            createdAt: { lt: cursorDate },
          },
          {
            createdAt: cursorDate,
            id: { lt: cursorId },
          },
        ];
      } else if (cursorDate) {
        where.createdAt = { lt: cursorDate };
      }

      const rawMessages = await this.prisma.chatMessage.findMany({
        where,
        take: query.limit + 1,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });

      if (rawMessages.length > query.limit) {
        rawMessages.pop();
        const lastMsg = rawMessages[rawMessages.length - 1];
        nextCursor = `${lastMsg.createdAt.toISOString()}_${lastMsg.id}`;
      }

      messages = rawMessages.reverse();
    } else {
      if (cursorDate && cursorId) {
        where.OR = [
          {
            createdAt: { gt: cursorDate },
          },
          {
            createdAt: cursorDate,
            id: { gt: cursorId },
          },
        ];
      } else if (cursorDate) {
        where.createdAt = { gt: cursorDate };
      }

      const rawMessages = await this.prisma.chatMessage.findMany({
        where,
        take: query.limit + 1,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });

      if (rawMessages.length > query.limit) {
        rawMessages.pop();
        const lastMsg = rawMessages[rawMessages.length - 1];
        nextCursor = `${lastMsg.createdAt.toISOString()}_${lastMsg.id}`;
      }

      messages = rawMessages;
    }

    const totalCount = await this.prisma.chatMessage.count({
      where: {
        sessionId,
      },
    });

    const decryptedMessages = await Promise.all(
      messages.map(async (m) => {
        const decryptedContent = await this.cryptoService.decryptMessageContent(m);
        return {
          id: m.id,
          sender: m.sender,
          type: m.type,
          content: decryptedContent,
          createdAt: m.createdAt,
        };
      }),
    );

    return {
      messages: decryptedMessages,
      nextCursor,
      totalCount,
    };
  }

  async createMessageBatch(
    userId: string,
    sessionId: string,
    dto: BatchMessagesDto,
    ipAddress?: string,
    traceId?: string,
    correlationId?: string,
    fencingToken?: string,
  ) {
    await this.validateFencingToken(userId, sessionId, fencingToken);

    const session = await this.prisma.chatSession.findFirst({
      where: {
        id: sessionId,
        userId,
        deletedAt: null,
      },
    });

    if (!session) {
      throw new NotFoundException('Session not found');
    }

    const now = new Date();
    const createdMessages = await this.prisma.$transaction(async (tx) => {
      await this.validateFencingToken(userId, sessionId, fencingToken);

      const msgs = [];
      for (const [index, msgDto] of dto.messages.entries()) {
        const createdAt = new Date(now.getTime() + index);
        const messageId = crypto.randomUUID();
        const sender = msgDto.sender;
        const messageType = msgDto.type || 'STANDARD';
        const content = msgDto.content;

        let contentCiphertext: string | null = null;
        let contentNonce: string | null = null;
        let contentAuthTag: string | null = null;
        let contentKeyVersion: number | null = null;

        if (content && this.cryptoService.isConfigured()) {
          const encrypted = await this.cryptoService.encryptMessageContent(
            messageId,
            sessionId,
            sender,
            messageType,
            content,
          );
          contentCiphertext = encrypted.ciphertext;
          contentNonce = encrypted.nonce;
          contentAuthTag = encrypted.authTag;
          contentKeyVersion = encrypted.keyVersion;
        }

        const msg = await tx.chatMessage.create({
          data: {
            id: messageId,
            sessionId,
            sender: sender as any,
            type: messageType as any,
            content: contentCiphertext === null ? content : null,
            contentCiphertext,
            contentNonce,
            contentAuthTag,
            contentKeyVersion,
            createdAt,
          },
        });
        msgs.push(msg);
      }

      await tx.chatSession.update({
        where: {
          id: sessionId,
        },
        data: {
          lastActiveAt: now,
        },
      });

      await this.auditService.createLog(tx, {
        userId,
        action: 'chat_message_batch_create',
        resourceType: 'ChatMessage',
        resourceId: msgs[0]?.id || null,
        metadata: {
          sessionId,
          count: msgs.length,
        },
        ipAddress,
        traceId,
        correlationId,
      });

      return msgs;
    });

    const decryptedMessages = await Promise.all(
      createdMessages.map(async (m) => {
        const decryptedContent = await this.cryptoService.decryptMessageContent(m);
        return {
          id: m.id,
          sessionId: m.sessionId,
          sender: m.sender,
          type: m.type,
          content: decryptedContent,
          createdAt: m.createdAt,
        };
      }),
    );

    return {
      messages: decryptedMessages,
    };
  }

  async getMemory(userId: string, sessionId: string, query: MemoryQueryDto) {
    const session = await this.prisma.chatSession.findFirst({
      where: {
        id: sessionId,
        userId,
        deletedAt: null,
      },
    });

    if (!session) {
      throw new NotFoundException('Session not found');
    }

    const lastSummaryMessage = await this.prisma.chatMessage.findFirst({
      where: {
        sessionId,
        type: 'SUMMARY',
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    const whereClause: Prisma.ChatMessageWhereInput = {
      sessionId,
      type: 'STANDARD',
    };

    if (query.unsummarizedOnly && lastSummaryMessage) {
      whereClause.OR = [
        { createdAt: { gt: lastSummaryMessage.createdAt } },
        {
          createdAt: lastSummaryMessage.createdAt,
          id: { gt: lastSummaryMessage.id },
        },
      ];
    }

    const recentStandardMessages = await this.prisma.chatMessage.findMany({
      where: whereClause,
      take: query.recentCount,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    const decryptedRecentMessages = await Promise.all(
      recentStandardMessages.reverse().map(async (m) => {
        const decryptedContent = await this.cryptoService.decryptMessageContent(m);
        return {
          id: m.id,
          sender: m.sender,
          content: decryptedContent,
          createdAt: m.createdAt,
        };
      }),
    );

    let decryptedSummary: string | null = null;
    if (lastSummaryMessage) {
      decryptedSummary = await this.cryptoService.decryptMessageContent(lastSummaryMessage);
    }

    const totalMessageCount = await this.prisma.chatMessage.count({
      where: {
        sessionId,
      },
    });

    return {
      summary: decryptedSummary,
      recentMessages: decryptedRecentMessages,
      totalMessageCount,
    };
  }
}
