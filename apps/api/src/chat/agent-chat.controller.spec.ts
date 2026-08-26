import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { AgentChatController } from './agent-chat.controller';
import { ChatService } from '@/chat/chat.service';
import { AgentChatAccessService } from './agent-chat-access.service';
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

  describe('POST access/check', () => {
    it('calls agentChatAccessService.checkUserAccess with dto', async () => {
      const dto = { sub: 'user_123', jti: 'jti_abc', exp: 1700000000 };
      (agentChatAccessService.checkUserAccess as jest.Mock).mockResolvedValueOnce({ allowed: true });

      const result = await controller.checkAccess(dto);

      expect(agentChatAccessService.checkUserAccess).toHaveBeenCalledWith(dto);
      expect(result).toEqual({ allowed: true });
    });
  });

  describe('POST sessions', () => {
    it('creates a new chat session for authenticated user', async () => {
      const dto = { title: 'New Trip' };
      const expectedSession = { id: 'session_1', userId: 'user_123', title: 'New Trip' } as any;
      (chatService.createSession as jest.Mock).mockResolvedValueOnce(expectedSession);

      const result = await controller.createSession(mockReq, dto);

      expect(chatService.createSession).toHaveBeenCalledWith('user_123', 'New Trip');
      expect(result).toBe(expectedSession);
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

  describe('GET sessions/:sessionId/memory', () => {
    it('retrieves memory with provided query parameters', async () => {
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

  describe('POST sessions/:sessionId/messages', () => {
    it('creates message with explicit sender and type, parsing lowercase fencing token', async () => {
      const sessionId = 'session_1';
      const headers = { 'x-fencing-token': 'fence_123' };
      const dto = { sender: 'AGENT', content: 'Hello user', type: 'STANDARD' };
      const createdMessage = { id: 'msg_1', sessionId, sender: MessageSender.AGENT, content: 'Hello user' } as any;
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
    });

    it('creates message with uppercase X-Fencing-Token and default sender/type', async () => {
      const sessionId = 'session_1';
      const headers = { 'X-Fencing-Token': 'fence_456' };
      const dto = { sender: '', content: 'Hi' };
      const createdMessage = { id: 'msg_2', sessionId, sender: MessageSender.USER, content: 'Hi' } as any;
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

    it('passes undefined fencing token when neither header is present', async () => {
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

    it('catches NotFoundException and rethrows standard chat session not found error', async () => {
      const sessionId = 'session_nonexistent';
      const headers = {};
      const dto = { sender: 'USER', content: 'Hello' };
      (chatService.createMessage as jest.Mock).mockRejectedValueOnce(new NotFoundException('Session not found'));

      await expect(
        controller.createMessage(sessionId, mockReq, headers, dto as any),
      ).rejects.toThrow(NotFoundException);

      try {
        (chatService.createMessage as jest.Mock).mockRejectedValueOnce(new NotFoundException('Session not found'));
        await controller.createMessage(sessionId, mockReq, headers, dto as any);
      } catch (err: any) {
        expect(err).toBeInstanceOf(NotFoundException);
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

  describe('POST sessions/:sessionId/turns', () => {
    it('creates message batch with mapped messages and fencing token', async () => {
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
            { sender: MessageSender.USER, content: 'Need a flight to SFO', type: MessageType.STANDARD },
            { sender: MessageSender.AGENT, content: 'Here are flights...', type: MessageType.STANDARD },
          ],
        },
        undefined,
        undefined,
        undefined,
        'fence_turn_1',
      );
      expect(result).toBe(batchResult);
    });

    it('falls back to default values when turn message fields are missing or empty', async () => {
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

    it('catches NotFoundException and rethrows standard chat session not found error', async () => {
      const sessionId = 'session_nonexistent';
      const headers = {};
      const dto = { messages: [] };
      (chatService.createMessageBatch as jest.Mock).mockRejectedValueOnce(new NotFoundException('Session not found'));

      await expect(
        controller.createTurn(sessionId, mockReq, headers, dto),
      ).rejects.toThrow(NotFoundException);

      try {
        (chatService.createMessageBatch as jest.Mock).mockRejectedValueOnce(new NotFoundException('Session not found'));
        await controller.createTurn(sessionId, mockReq, headers, dto);
      } catch (err: any) {
        expect(err).toBeInstanceOf(NotFoundException);
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
      (chatService.createMessageBatch as jest.Mock).mockRejectedValueOnce(new Error('Turn batch error'));

      await expect(
        controller.createTurn(sessionId, mockReq, headers, dto),
      ).rejects.toThrow('Turn batch error');
    });
  });

  describe('POST sessions/:sessionId/summaries', () => {
    it('creates summary message with MessageSender.AGENT and MessageType.SUMMARY', async () => {
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
    });

    it('catches NotFoundException and rethrows standard chat session not found error', async () => {
      const sessionId = 'session_nonexistent';
      const headers = {};
      const dto = { content: 'Summary' };
      (chatService.createMessage as jest.Mock).mockRejectedValueOnce(new NotFoundException('Session not found'));

      await expect(
        controller.createSummary(sessionId, mockReq, headers, dto),
      ).rejects.toThrow(NotFoundException);

      try {
        (chatService.createMessage as jest.Mock).mockRejectedValueOnce(new NotFoundException('Session not found'));
        await controller.createSummary(sessionId, mockReq, headers, dto);
      } catch (err: any) {
        expect(err).toBeInstanceOf(NotFoundException);
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

      await expect(
        controller.createSummary(sessionId, mockReq, headers, dto),
      ).rejects.toThrow('Summary error');
    });
  });

  describe('DELETE sessions/:sessionId', () => {
    it('deletes session for authenticated user', async () => {
      const sessionId = 'session_1';
      (chatService.deleteSession as jest.Mock).mockResolvedValueOnce(undefined);

      const result = await controller.deleteSession(sessionId, mockReq);

      expect(chatService.deleteSession).toHaveBeenCalledWith('user_123', sessionId);
      expect(result).toBeUndefined();
    });
  });
});
