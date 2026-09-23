import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, NotFoundException, RequestMethod } from '@nestjs/common';
import {
  PATH_METADATA,
  METHOD_METADATA,
  HTTP_CODE_METADATA,
} from '@nestjs/common/constants';
import { AgentChatController } from '@/chat/agent-chat.controller';
import { AgentApiKeyGuard } from '@/agent-gateway/auth/agent-api-key.guard';
import { ClaimTokenGuard } from '@/agent-gateway/auth/claim-token.guard';
import { ChatService } from '@/chat/chat.service';
import { AgentChatAccessService } from '@/chat/agent-chat-access.service';
import { ClaimTokenService } from '@/agent-gateway/auth/claim-token.service';
import { MessageSender, MessageType } from '@prisma/client';

describe('AgentChatController', () => {
  let controller: AgentChatController;
  let chatService: jest.Mocked<ChatService>;
  let agentChatAccessService: jest.Mocked<AgentChatAccessService>;

  const mockUser = { id: 'user_123', email: 'user@example.com' };
  const mockReq = { user: mockUser } as any;

  beforeEach(async () => {
    chatService = {
      createSession: jest.fn(),
      getMemory: jest.fn(),
      createMessage: jest.fn(),
      createMessageBatch: jest.fn(),
      deleteSession: jest.fn(),
    } as unknown as jest.Mocked<ChatService>;

    agentChatAccessService = {
      checkUserAccess: jest.fn(),
    } as unknown as jest.Mocked<AgentChatAccessService>;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AgentChatController],
      providers: [
        { provide: ChatService, useValue: chatService },
        { provide: AgentChatAccessService, useValue: agentChatAccessService },
        { provide: ClaimTokenService, useValue: { validateToken: jest.fn() } },
      ],
    }).compile();

    controller = module.get<AgentChatController>(AgentChatController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('controller guards and route metadata', () => {
    it('declares controller-level guards strictly matching [AgentApiKeyGuard, ClaimTokenGuard]', () => {
      const guards = Reflect.getMetadata('__guards__', AgentChatController);
      expect(guards).toEqual([AgentApiKeyGuard, ClaimTokenGuard]);
    });

    it('mounts under base path agent-gateway/chat', () => {
      const basePath = Reflect.getMetadata(PATH_METADATA, AgentChatController);
      expect(basePath).toBe('agent-gateway/chat');
    });

    it('declares expected HTTP methods, paths, and status codes for all 7 routes', () => {
      const routes = [
        {
          handler: controller.checkAccess,
          method: RequestMethod.POST,
          path: 'access/check',
          statusCode: 200,
        },
        {
          handler: controller.createSession,
          method: RequestMethod.POST,
          path: 'sessions',
          statusCode: 201,
        },
        {
          handler: controller.getMemory,
          method: RequestMethod.GET,
          path: 'sessions/:sessionId/memory',
          statusCode: 200,
        },
        {
          handler: controller.createMessage,
          method: RequestMethod.POST,
          path: 'sessions/:sessionId/messages',
          statusCode: 201,
        },
        {
          handler: controller.createTurn,
          method: RequestMethod.POST,
          path: 'sessions/:sessionId/turns',
          statusCode: 201,
        },
        {
          handler: controller.createSummary,
          method: RequestMethod.POST,
          path: 'sessions/:sessionId/summaries',
          statusCode: 201,
        },
        {
          handler: controller.deleteSession,
          method: RequestMethod.DELETE,
          path: 'sessions/:sessionId',
          statusCode: 204,
        },
      ];

      for (const route of routes) {
        expect(Reflect.getMetadata(PATH_METADATA, route.handler)).toBe(route.path);
        expect(Reflect.getMetadata(METHOD_METADATA, route.handler)).toBe(route.method);
        expect(Reflect.getMetadata(HTTP_CODE_METADATA, route.handler)).toBe(route.statusCode);
      }
    });
  });

  describe('POST /access/check', () => {
    it('bypasses claim-token extraction and delegates { sub } validation directly to AgentChatAccessService', async () => {
      const mockClaimTokenService = { validateToken: jest.fn() } as unknown as ClaimTokenService;
      const guard = new ClaimTokenGuard(mockClaimTokenService);

      const mockExecutionContext = {
        switchToHttp: () => ({
          getRequest: () => ({
            path: '/api/agent-gateway/chat/access/check',
            headers: {},
          }),
        }),
      } as ExecutionContext;

      const guardCanActivate = await guard.canActivate(mockExecutionContext);
      expect(guardCanActivate).toBe(true);
      expect(mockClaimTokenService.validateToken).not.toHaveBeenCalled();

      const dto = { sub: 'user_123', jti: 'jti_abc', exp: 1700000000 };
      const expectedResponse = { allowed: true };
      (agentChatAccessService.checkUserAccess as jest.Mock).mockResolvedValueOnce(expectedResponse);

      const result = await controller.checkAccess(dto);

      expect(agentChatAccessService.checkUserAccess).toHaveBeenCalledWith(dto);
      expect(result).toEqual(expectedResponse);
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, controller.checkAccess)).toBe(200);
    });

    it('propagates denied access response shape when user is not allowed', async () => {
      const dto = { sub: 'blocked_user' };
      const deniedResponse = { allowed: false, reason: 'USER_LOCKED' };
      (agentChatAccessService.checkUserAccess as jest.Mock).mockResolvedValueOnce(deniedResponse);

      const result = await controller.checkAccess(dto);

      expect(agentChatAccessService.checkUserAccess).toHaveBeenCalledWith(dto);
      expect(result).toEqual(deniedResponse);
    });
  });

  describe('POST /sessions', () => {
    it('creates a new chat session for authenticated user with title (HTTP 201)', async () => {
      const dto = { title: 'New Trip' };
      const expectedSession = { id: 'session_1', userId: 'user_123', title: 'New Trip' } as any;
      (chatService.createSession as jest.Mock).mockResolvedValueOnce(expectedSession);

      const result = await controller.createSession(mockReq, dto);

      expect(chatService.createSession).toHaveBeenCalledWith('user_123', 'New Trip');
      expect(result).toBe(expectedSession);
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, controller.createSession)).toBe(201);
    });

    it('creates session without title if omitted', async () => {
      const dto = {};
      const expectedSession = { id: 'session_1', userId: 'user_123', title: null } as any;
      (chatService.createSession as jest.Mock).mockResolvedValueOnce(expectedSession);

      const result = await controller.createSession(mockReq, dto);

      expect(chatService.createSession).toHaveBeenCalledWith('user_123', undefined);
      expect(result).toBe(expectedSession);
    });
  });

  describe('GET /sessions/:sessionId/memory', () => {
    it('retrieves memory with provided query parameters (HTTP 200)', async () => {
      const sessionId = 'session_1';
      const query = { recentCount: 15, unsummarizedOnly: true };
      const memoryResult = {
        summary: 'Existing summary',
        recentMessages: [],
        totalMessageCount: 5,
      };
      (chatService.getMemory as jest.Mock).mockResolvedValueOnce(memoryResult);

      const result = await controller.getMemory(sessionId, mockReq, query as any);

      expect(chatService.getMemory).toHaveBeenCalledWith('user_123', sessionId, {
        recentCount: 15,
        unsummarizedOnly: true,
      });
      expect(result).toBe(memoryResult);
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, controller.getMemory)).toBe(200);
    });

    it('applies default query parameter values when omitted', async () => {
      const sessionId = 'session_1';
      const query = {};
      const memoryResult = {
        summary: null,
        recentMessages: [],
        totalMessageCount: 0,
      };
      (chatService.getMemory as jest.Mock).mockResolvedValueOnce(memoryResult);

      const result = await controller.getMemory(sessionId, mockReq, query as any);

      expect(chatService.getMemory).toHaveBeenCalledWith('user_123', sessionId, {
        recentCount: 20,
        unsummarizedOnly: false,
      });
      expect(result).toBe(memoryResult);
    });
  });

  describe('POST /sessions/:sessionId/messages', () => {
    it('creates message with explicit sender and type, parsing lowercase x-fencing-token (HTTP 201)', async () => {
      const sessionId = 'session_1';
      const headers = { 'x-fencing-token': 'fence_123' };
      const dto = { sender: 'AGENT', content: 'Hello user', type: 'STANDARD' };
      const createdMessage = {
        id: 'msg_1',
        sessionId,
        sender: MessageSender.AGENT,
        content: 'Hello user',
        type: MessageType.STANDARD,
      } as any;
      (chatService.createMessage as jest.Mock).mockResolvedValueOnce(createdMessage);

      const result = await controller.createMessage(sessionId, mockReq, headers, dto);

      expect(chatService.createMessage).toHaveBeenCalledWith(
        'user_123',
        sessionId,
        {
          sender: MessageSender.AGENT,
          content: 'Hello user',
          type: MessageType.STANDARD,
        },
        undefined,
        undefined,
        undefined,
        'fence_123',
      );
      expect(result).toBe(createdMessage);
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, controller.createMessage)).toBe(201);
    });

    it('creates message with canonical X-Fencing-Token and default sender/type', async () => {
      const sessionId = 'session_1';
      const headers = { 'X-Fencing-Token': 'fence_456' };
      const dto = { sender: '', content: 'Hi' };
      const createdMessage = {
        id: 'msg_2',
        sessionId,
        sender: MessageSender.USER,
        content: 'Hi',
        type: MessageType.STANDARD,
      } as any;
      (chatService.createMessage as jest.Mock).mockResolvedValueOnce(createdMessage);

      const result = await controller.createMessage(sessionId, mockReq, headers, dto as any);

      expect(chatService.createMessage).toHaveBeenCalledWith(
        'user_123',
        sessionId,
        {
          sender: MessageSender.USER,
          content: 'Hi',
          type: MessageType.STANDARD,
        },
        undefined,
        undefined,
        undefined,
        'fence_456',
      );
      expect(result).toBe(createdMessage);
    });

    it('passes undefined fencing token when neither header spelling is present', async () => {
      const sessionId = 'session_1';
      const headers = {};
      const dto = { sender: 'USER', content: 'Hi' };
      (chatService.createMessage as jest.Mock).mockResolvedValueOnce({ id: 'msg_3' } as any);

      await controller.createMessage(sessionId, mockReq, headers, dto as any);

      expect(chatService.createMessage).toHaveBeenCalledWith(
        'user_123',
        sessionId,
        expect.any(Object),
        undefined,
        undefined,
        undefined,
        undefined,
      );
    });

    it('catches NotFoundException and rethrows CHAT_SESSION_NOT_FOUND (404) error', async () => {
      const sessionId = 'session_nonexistent';
      const headers = {};
      const dto = { sender: 'USER', content: 'Hello' };
      (chatService.createMessage as jest.Mock).mockRejectedValueOnce(
        new NotFoundException('Session not found'),
      );

      await expect(
        controller.createMessage(sessionId, mockReq, headers, dto as any),
      ).rejects.toThrow(NotFoundException);

      (chatService.createMessage as jest.Mock).mockRejectedValueOnce(
        new NotFoundException('Session not found'),
      );
      try {
        await controller.createMessage(sessionId, mockReq, headers, dto as any);
        fail('Expected NotFoundException to be thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(NotFoundException);
        expect(err.getStatus()).toBe(404);
        expect(err.getResponse()).toEqual({
          statusCode: 404,
          message: 'Session not found',
          code: 'CHAT_SESSION_NOT_FOUND',
        });
      }
    });

    it('propagates other non-NotFound errors directly', async () => {
      const sessionId = 'session_1';
      const headers = {};
      const dto = { sender: 'USER', content: 'Hello' };
      const genericError = new Error('Database down');
      (chatService.createMessage as jest.Mock).mockRejectedValueOnce(genericError);

      await expect(
        controller.createMessage(sessionId, mockReq, headers, dto as any),
      ).rejects.toThrow('Database down');
    });
  });

  describe('POST /sessions/:sessionId/turns', () => {
    it('creates message batch with mapped messages and lowercase x-fencing-token (HTTP 201)', async () => {
      const sessionId = 'session_1';
      const headers = { 'x-fencing-token': 'fence_turn_1' };
      const dto = {
        messages: [
          { sender: 'USER', content: 'Need a flight to SFO', type: 'STANDARD' },
          { sender: 'AGENT', content: 'Here are flights...', type: 'STANDARD' },
        ],
      };
      const batchResult = {
        messages: [
          { id: 'm1', sender: MessageSender.USER, content: 'Need a flight to SFO' },
          { id: 'm2', sender: MessageSender.AGENT, content: 'Here are flights...' },
        ],
      } as any;
      (chatService.createMessageBatch as jest.Mock).mockResolvedValueOnce(batchResult);

      const result = await controller.createTurn(sessionId, mockReq, headers, dto);

      expect(chatService.createMessageBatch).toHaveBeenCalledWith(
        'user_123',
        sessionId,
        {
          messages: [
            {
              sender: MessageSender.USER,
              content: 'Need a flight to SFO',
              type: MessageType.STANDARD,
            },
            {
              sender: MessageSender.AGENT,
              content: 'Here are flights...',
              type: MessageType.STANDARD,
            },
          ],
        },
        undefined,
        undefined,
        undefined,
        'fence_turn_1',
      );
      expect(result).toBe(batchResult);
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, controller.createTurn)).toBe(201);
    });

    it('creates message batch with canonical X-Fencing-Token and fallback defaults', async () => {
      const sessionId = 'session_1';
      const headers = { 'X-Fencing-Token': 'fence_turn_2' };
      const dto = {
        messages: [{}, { sender: 'AGENT' }],
      };
      (chatService.createMessageBatch as jest.Mock).mockResolvedValueOnce({ messages: [] } as any);

      await controller.createTurn(sessionId, mockReq, headers, dto as any);

      expect(chatService.createMessageBatch).toHaveBeenCalledWith(
        'user_123',
        sessionId,
        {
          messages: [
            { sender: MessageSender.USER, content: '', type: MessageType.STANDARD },
            { sender: MessageSender.AGENT, content: '', type: MessageType.STANDARD },
          ],
        },
        undefined,
        undefined,
        undefined,
        'fence_turn_2',
      );
    });

    it('handles empty or missing messages array', async () => {
      const sessionId = 'session_1';
      const headers = {};
      const dto = {} as any;
      (chatService.createMessageBatch as jest.Mock).mockResolvedValueOnce({ messages: [] } as any);

      await controller.createTurn(sessionId, mockReq, headers, dto);

      expect(chatService.createMessageBatch).toHaveBeenCalledWith(
        'user_123',
        sessionId,
        { messages: [] },
        undefined,
        undefined,
        undefined,
        undefined,
      );
    });

    it('catches NotFoundException and rethrows CHAT_SESSION_NOT_FOUND (404) error', async () => {
      const sessionId = 'session_nonexistent';
      const headers = {};
      const dto = { messages: [] };
      (chatService.createMessageBatch as jest.Mock).mockRejectedValueOnce(
        new NotFoundException('Session not found'),
      );

      await expect(controller.createTurn(sessionId, mockReq, headers, dto)).rejects.toThrow(
        NotFoundException,
      );

      (chatService.createMessageBatch as jest.Mock).mockRejectedValueOnce(
        new NotFoundException('Session not found'),
      );
      try {
        await controller.createTurn(sessionId, mockReq, headers, dto);
        fail('Expected NotFoundException to be thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(NotFoundException);
        expect(err.getStatus()).toBe(404);
        expect(err.getResponse()).toEqual({
          statusCode: 404,
          message: 'Session not found',
          code: 'CHAT_SESSION_NOT_FOUND',
        });
      }
    });

    it('propagates non-NotFound errors directly', async () => {
      const sessionId = 'session_1';
      const headers = {};
      const dto = { messages: [] };
      (chatService.createMessageBatch as jest.Mock).mockRejectedValueOnce(
        new Error('Turn batch error'),
      );

      await expect(controller.createTurn(sessionId, mockReq, headers, dto)).rejects.toThrow(
        'Turn batch error',
      );
    });
  });

  describe('POST /sessions/:sessionId/summaries', () => {
    it('creates summary message with lowercase x-fencing-token (HTTP 201)', async () => {
      const sessionId = 'session_1';
      const headers = { 'x-fencing-token': 'fence_sum_1' };
      const dto = { content: 'User is searching for flights to Tokyo' };
      const summaryMessage = {
        id: 'msg_sum_1',
        sessionId,
        sender: MessageSender.AGENT,
        type: MessageType.SUMMARY,
        content: 'User is searching for flights to Tokyo',
      } as any;
      (chatService.createMessage as jest.Mock).mockResolvedValueOnce(summaryMessage);

      const result = await controller.createSummary(sessionId, mockReq, headers, dto);

      expect(chatService.createMessage).toHaveBeenCalledWith(
        'user_123',
        sessionId,
        {
          sender: MessageSender.AGENT,
          content: 'User is searching for flights to Tokyo',
          type: MessageType.SUMMARY,
        },
        undefined,
        undefined,
        undefined,
        'fence_sum_1',
      );
      expect(result).toBe(summaryMessage);
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, controller.createSummary)).toBe(201);
    });

    it('creates summary message with canonical X-Fencing-Token', async () => {
      const sessionId = 'session_1';
      const headers = { 'X-Fencing-Token': 'fence_sum_2' };
      const dto = { content: 'Tokyo flight confirmed' };
      const summaryMessage = {
        id: 'msg_sum_2',
        sessionId,
        sender: MessageSender.AGENT,
        type: MessageType.SUMMARY,
        content: 'Tokyo flight confirmed',
      } as any;
      (chatService.createMessage as jest.Mock).mockResolvedValueOnce(summaryMessage);

      const result = await controller.createSummary(sessionId, mockReq, headers, dto);

      expect(chatService.createMessage).toHaveBeenCalledWith(
        'user_123',
        sessionId,
        {
          sender: MessageSender.AGENT,
          content: 'Tokyo flight confirmed',
          type: MessageType.SUMMARY,
        },
        undefined,
        undefined,
        undefined,
        'fence_sum_2',
      );
      expect(result).toBe(summaryMessage);
    });

    it('creates summary message without fencing token header', async () => {
      const sessionId = 'session_1';
      const headers = {};
      const dto = { content: 'Summary without fencing' };
      (chatService.createMessage as jest.Mock).mockResolvedValueOnce({ id: 'msg_sum_3' } as any);

      await controller.createSummary(sessionId, mockReq, headers, dto);

      expect(chatService.createMessage).toHaveBeenCalledWith(
        'user_123',
        sessionId,
        expect.any(Object),
        undefined,
        undefined,
        undefined,
        undefined,
      );
    });

    it('catches NotFoundException and rethrows CHAT_SESSION_NOT_FOUND (404) error', async () => {
      const sessionId = 'session_nonexistent';
      const headers = {};
      const dto = { content: 'Summary' };
      (chatService.createMessage as jest.Mock).mockRejectedValueOnce(
        new NotFoundException('Session not found'),
      );

      await expect(controller.createSummary(sessionId, mockReq, headers, dto)).rejects.toThrow(
        NotFoundException,
      );

      (chatService.createMessage as jest.Mock).mockRejectedValueOnce(
        new NotFoundException('Session not found'),
      );
      try {
        await controller.createSummary(sessionId, mockReq, headers, dto);
        fail('Expected NotFoundException to be thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(NotFoundException);
        expect(err.getStatus()).toBe(404);
        expect(err.getResponse()).toEqual({
          statusCode: 404,
          message: 'Session not found',
          code: 'CHAT_SESSION_NOT_FOUND',
        });
      }
    });

    it('propagates non-NotFound errors directly', async () => {
      const sessionId = 'session_1';
      const headers = {};
      const dto = { content: 'Summary' };
      (chatService.createMessage as jest.Mock).mockRejectedValueOnce(new Error('Summary error'));

      await expect(controller.createSummary(sessionId, mockReq, headers, dto)).rejects.toThrow(
        'Summary error',
      );
    });
  });

  describe('DELETE /sessions/:sessionId', () => {
    it('deletes session for authenticated user (HTTP 204)', async () => {
      const sessionId = 'session_1';
      (chatService.deleteSession as jest.Mock).mockResolvedValueOnce(undefined);

      const result = await controller.deleteSession(sessionId, mockReq);

      expect(chatService.deleteSession).toHaveBeenCalledWith('user_123', sessionId);
      expect(result).toBeUndefined();
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, controller.deleteSession)).toBe(204);
    });
  });
});
