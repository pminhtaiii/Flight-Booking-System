import { Test, TestingModule } from '@nestjs/testing';
import { AgentGatewayService } from './agent-gateway.service';
import { PrismaService } from '@/prisma/prisma.service';
import { CacheService } from '@/cache/cache.service';
import { ChatService } from '@/chat/chat.service';
import { HttpException, NotFoundException } from '@nestjs/common';

describe('AgentGatewayService', () => {
  let service: AgentGatewayService;
  let prismaService: jest.Mocked<PrismaService>;
  let cacheService: jest.Mocked<CacheService>;
  let chatService: jest.Mocked<ChatService>;

  beforeEach(async () => {
    prismaService = {
      user: {
        findUnique: jest.fn(),
      },
    } as any;

    cacheService = {
      get: jest.fn(),
      set: jest.fn(),
    } as any;

    chatService = {
      validateFencingToken: jest.fn(),
      createSession: jest.fn(),
      getMemory: jest.fn(),
      createMessage: jest.fn(),
      createMessageBatch: jest.fn(),
      deleteSession: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentGatewayService,
        { provide: PrismaService, useValue: prismaService },
        { provide: CacheService, useValue: cacheService },
        { provide: ChatService, useValue: chatService },
      ],
    }).compile();

    service = module.get<AgentGatewayService>(AgentGatewayService);
  });

  describe('checkUserAccess', () => {
    it('returns allowed: true for active user with no jti', async () => {
      (prismaService.user.findUnique as jest.Mock).mockResolvedValueOnce({
        id: 'usr_1',
        status: 'ACTIVE',
      });

      const res = await service.checkUserAccess({ sub: 'usr_1' });
      expect(res).toEqual({ allowed: true });
    });

    it('throws 401 UNAUTHORIZED if user does not exist', async () => {
      (prismaService.user.findUnique as jest.Mock).mockResolvedValueOnce(null);

      await expect(service.checkUserAccess({ sub: 'usr_nonexistent' })).rejects.toThrow(
        HttpException,
      );
    });

    it('throws 401 UNAUTHORIZED if user is INACTIVE', async () => {
      (prismaService.user.findUnique as jest.Mock).mockResolvedValueOnce({
        id: 'usr_1',
        status: 'INACTIVE',
      });

      await expect(service.checkUserAccess({ sub: 'usr_1' })).rejects.toThrow(
        HttpException,
      );
    });

    it('throws 401 UNAUTHORIZED if JTI is revoked in cache', async () => {
      (prismaService.user.findUnique as jest.Mock).mockResolvedValueOnce({
        id: 'usr_1',
        status: 'ACTIVE',
      });
      (cacheService.get as jest.Mock).mockResolvedValueOnce('true');

      await expect(service.checkUserAccess({ sub: 'usr_1', jti: 'revoked_jti' })).rejects.toThrow(
        HttpException,
      );
    });
  });

  describe('validateFencingToken', () => {
    it('delegates to chatService', async () => {
      await service.validateFencingToken('usr_1', 'sess_1', 'fence_1');
      expect(chatService.validateFencingToken).toHaveBeenCalledWith('usr_1', 'sess_1', 'fence_1');
    });
  });

  describe('createSession', () => {
    it('delegates to chatService', async () => {
      (chatService.createSession as jest.Mock).mockResolvedValueOnce({ id: 'sess_1', title: 'Test' });
      const res = await service.createSession('usr_1', 'Test');
      expect(res).toEqual({ id: 'sess_1', title: 'Test' });
      expect(chatService.createSession).toHaveBeenCalledWith('usr_1', 'Test');
    });
  });

  describe('getMemory', () => {
    it('delegates to chatService with default recentCount and unsummarizedOnly', async () => {
      (chatService.getMemory as jest.Mock).mockResolvedValueOnce({ summary: null, recentMessages: [], totalMessageCount: 0 });
      const res = await service.getMemory('usr_1', 'sess_1', {});
      expect(res).toEqual({ summary: null, recentMessages: [], totalMessageCount: 0 });
      expect(chatService.getMemory).toHaveBeenCalledWith('usr_1', 'sess_1', {
        recentCount: 20,
        unsummarizedOnly: false,
      });
    });
  });

  describe('createChatMessage', () => {
    it('delegates message creation to chatService', async () => {
      (chatService.createMessage as jest.Mock).mockResolvedValueOnce({ id: 'msg_1' });
      const res = await service.createChatMessage(
        'usr_1',
        'sess_1',
        { sender: 'USER', content: 'hello' },
        'fence_1',
      );
      expect(res).toEqual({ id: 'msg_1' });
      expect(chatService.createMessage).toHaveBeenCalledWith(
        'usr_1',
        'sess_1',
        { sender: 'USER', content: 'hello', type: 'STANDARD' },
        undefined,
        undefined,
        undefined,
        'fence_1',
      );
    });

    it('maps NotFoundException to CHAT_SESSION_NOT_FOUND', async () => {
      (chatService.createMessage as jest.Mock).mockRejectedValueOnce(new NotFoundException());
      await expect(
        service.createChatMessage('usr_1', 'sess_1', { sender: 'USER', content: 'hello' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('createMessageBatch', () => {
    it('delegates message batch creation to chatService', async () => {
      (chatService.createMessageBatch as jest.Mock).mockResolvedValueOnce({ messages: [{ id: 'msg_1' }] });
      const res = await service.createMessageBatch(
        'usr_1',
        'sess_1',
        { messages: [{ sender: 'USER', content: 'hello' }] },
        'fence_1',
      );
      expect(res).toEqual({ messages: [{ id: 'msg_1' }] });
      expect(chatService.createMessageBatch).toHaveBeenCalledWith(
        'usr_1',
        'sess_1',
        { messages: [{ sender: 'USER', content: 'hello', type: 'STANDARD' }] },
        undefined,
        undefined,
        undefined,
        'fence_1',
      );
    });

    it('maps NotFoundException to CHAT_SESSION_NOT_FOUND', async () => {
      (chatService.createMessageBatch as jest.Mock).mockRejectedValueOnce(new NotFoundException());
      await expect(
        service.createMessageBatch('usr_1', 'sess_1', {
          messages: [{ sender: 'USER', content: 'hello' }],
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteSession', () => {
    it('delegates to chatService', async () => {
      await service.deleteSession('usr_1', 'sess_1');
      expect(chatService.deleteSession).toHaveBeenCalledWith('usr_1', 'sess_1');
    });
  });
});
