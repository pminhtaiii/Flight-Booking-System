import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { AuditService } from '@/audit/audit.service';
import { ListSessionsQueryDto } from './dto/list-sessions-query.dto';
import { CreateMessageDto } from './dto/create-message.dto';
import { BatchMessagesDto } from './dto/batch-messages.dto';
import { ListMessagesQueryDto } from './dto/list-messages-query.dto';
import { MemoryQueryDto } from './dto/memory-query.dto';
import { Prisma, ChatMessage } from '@prisma/client';

@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async createSession(
    userId: string,
    title?: string,
    ipAddress?: string,
    traceId?: string,
    correlationId?: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const session = await tx.chatSession.create({
        data: {
          userId,
          title: title || null,
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

      return session;
    });
  }

  async listSessions(userId: string, query: ListSessionsQueryDto) {
    const where: Prisma.ChatSessionWhereInput = {
      userId,
    };

    let cursorDate: Date | undefined;
    let cursorId: string | undefined;
    if (query.cursor) {
      const parts = query.cursor.split('_');
      cursorDate = new Date(parts[0]);
      cursorId = parts[1];

      where.OR = cursorId
        ? [
            { lastActiveAt: { lt: cursorDate } },
            { lastActiveAt: cursorDate, id: { lt: cursorId } },
          ]
        : [{ lastActiveAt: { lt: cursorDate } }];
    }

    const sessions = await this.prisma.chatSession.findMany({
      where,
      take: query.limit + 1,
      orderBy: [
        { lastActiveAt: 'desc' },
        { id: 'desc' },
      ],
      include: {
        messages: {
          where: {
            type: 'STANDARD',
          },
          orderBy: [
            { createdAt: 'desc' },
            { id: 'desc' },
          ],
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

    const formattedSessions = sessions.map((session) => ({
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
      messagePreview: session.messages[0]?.content || null,
    }));

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

    return {
      ...session,
      messageCount,
    };
  }

  async updateSession(userId: string, sessionId: string, title?: string) {
    const session = await this.prisma.chatSession.findFirst({
      where: {
        id: sessionId,
        userId,
      },
    });

    if (!session) {
      throw new NotFoundException('Session not found');
    }

    return this.prisma.chatSession.update({
      where: {
        id: sessionId,
      },
      data: title === undefined ? {} : { title },
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
      },
    });

    if (!session) {
      throw new NotFoundException('Session not found');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.chatSession.delete({
        where: {
          id: sessionId,
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
  ) {
    const session = await this.prisma.chatSession.findFirst({
      where: {
        id: sessionId,
        userId,
      },
    });

    if (!session) {
      throw new NotFoundException('Session not found');
    }

    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const message = await tx.chatMessage.create({
        data: {
          sessionId,
          sender: dto.sender,
          type: dto.type || 'STANDARD',
          content: dto.content,
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

      return message;
    });
  }

  async listMessages(userId: string, sessionId: string, query: ListMessagesQueryDto) {
    const session = await this.prisma.chatSession.findFirst({
      where: {
        id: sessionId,
        userId,
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
        orderBy: [
          { createdAt: 'desc' },
          { id: 'desc' },
        ],
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
        orderBy: [
          { createdAt: 'asc' },
          { id: 'asc' },
        ],
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

    return {
      messages: messages.map((m) => ({
        id: m.id,
        sender: m.sender,
        type: m.type,
        content: m.content,
        createdAt: m.createdAt,
      })),
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
  ) {
    const session = await this.prisma.chatSession.findFirst({
      where: {
        id: sessionId,
        userId,
      },
    });

    if (!session) {
      throw new NotFoundException('Session not found');
    }

    const now = new Date();
    const createdMessages = await this.prisma.$transaction(async (tx) => {
      const msgs = [];
      for (const [index, msgDto] of dto.messages.entries()) {
        const createdAt = new Date(now.getTime() + index);
        const msg = await tx.chatMessage.create({
          data: {
            sessionId,
            sender: msgDto.sender,
            type: msgDto.type || 'STANDARD',
            content: msgDto.content,
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

    return {
      messages: createdMessages.map((m) => ({
        id: m.id,
        sessionId: m.sessionId,
        sender: m.sender,
        type: m.type,
        content: m.content,
        createdAt: m.createdAt,
      })),
    };
  }

  async getMemory(userId: string, sessionId: string, query: MemoryQueryDto) {
    const session = await this.prisma.chatSession.findFirst({
      where: {
        id: sessionId,
        userId,
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
      orderBy: [
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
    });

    const recentStandardMessages = await this.prisma.chatMessage.findMany({
      where: {
        sessionId,
        type: 'STANDARD',
      },
      take: query.recentCount,
      orderBy: [
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
    });

    const recentMessages = recentStandardMessages.reverse().map((m) => ({
      id: m.id,
      sender: m.sender,
      content: m.content,
      createdAt: m.createdAt,
    }));

    const totalMessageCount = await this.prisma.chatMessage.count({
      where: {
        sessionId,
      },
    });

    return {
      summary: lastSummaryMessage?.content || null,
      recentMessages,
      totalMessageCount,
    };
  }
}
