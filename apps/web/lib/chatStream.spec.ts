import {
  isDirectAgentStreamEnabled,
  getAgentStreamEndpoint,
  createChatStreamRequest,
} from './chatStream';

describe('chatStream', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('defaults to proxy endpoint when direct stream flag is off', () => {
    delete process.env.NEXT_PUBLIC_ENABLE_DIRECT_AGENT_STREAM;
    process.env.NEXT_PUBLIC_FEATURE_FLAG_CHAT_DIRECT_STREAM = 'false';

    expect(isDirectAgentStreamEnabled()).toBe(false);
    expect(getAgentStreamEndpoint()).toBe('/api/chat/stream');
  });

  it('uses direct agent endpoint when NEXT_PUBLIC_FEATURE_FLAG_CHAT_DIRECT_STREAM is true', () => {
    process.env.NEXT_PUBLIC_FEATURE_FLAG_CHAT_DIRECT_STREAM = 'true';
    process.env.NEXT_PUBLIC_AGENT_URL = 'http://localhost:3002';

    expect(isDirectAgentStreamEnabled()).toBe(true);
    expect(getAgentStreamEndpoint()).toBe('http://localhost:3002/chat/stream');
  });

  it('uses direct agent endpoint when NEXT_PUBLIC_ENABLE_DIRECT_AGENT_STREAM is true', () => {
    delete process.env.NEXT_PUBLIC_FEATURE_FLAG_CHAT_DIRECT_STREAM;
    process.env.NEXT_PUBLIC_ENABLE_DIRECT_AGENT_STREAM = 'true';
    process.env.NEXT_PUBLIC_AGENT_URL = 'http://localhost:3002/';

    expect(isDirectAgentStreamEnabled()).toBe(true);
    expect(getAgentStreamEndpoint()).toBe('http://localhost:3002/chat/stream');
  });

  it('generates independent opaque trace and correlation headers for direct streaming', async () => {
    process.env.NEXT_PUBLIC_FEATURE_FLAG_CHAT_DIRECT_STREAM = 'true';
    process.env.NEXT_PUBLIC_AGENT_URL = 'http://localhost:3002';

    const mockFetch = jest.fn().mockResolvedValue(new Response('ok'));
    global.fetch = mockFetch;

    await createChatStreamRequest({
      message: 'test message',
      sessionId: 'sess-123',
      token: 'jwt-token-xyz',
    });

    const request = mockFetch.mock.calls[0][1] as RequestInit;
    expect(request).toEqual(expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ message: 'test message', sessionId: 'sess-123' }),
    }));
    expect(request.headers).toEqual(expect.objectContaining({
      'Content-Type': 'application/json',
      Authorization: 'Bearer jwt-token-xyz',
    }));
    const headers = request.headers as Record<string, string>;
    expect(headers['X-Trace-Id']).toMatch(/^chat_[a-f0-9]{32}$/);
    expect(headers['X-Correlation-Id']).toMatch(/^chat_[a-f0-9]{32}$/);
    expect(headers['X-Trace-Id']).not.toBe(headers['X-Correlation-Id']);
  });

  it('never derives trace or correlation headers from the chat session', async () => {
    process.env.NEXT_PUBLIC_FEATURE_FLAG_CHAT_DIRECT_STREAM = 'true';
    process.env.NEXT_PUBLIC_AGENT_URL = 'http://localhost:3002';

    const mockFetch = jest.fn().mockResolvedValue(new Response('ok'));
    global.fetch = mockFetch;

    await createChatStreamRequest({
      message: 'second turn',
      sessionId: 'continued-session',
      token: 'jwt-token-xyz',
    });

    const request = mockFetch.mock.calls[0][1] as RequestInit;
    const headers = request.headers as Record<string, string>;
    expect(headers).toEqual(expect.objectContaining({
      'Content-Type': 'application/json',
      Authorization: 'Bearer jwt-token-xyz',
    }));
    expect(headers['X-Trace-Id']).toMatch(/^chat_[a-f0-9]{32}$/);
    expect(headers['X-Correlation-Id']).toMatch(/^chat_[a-f0-9]{32}$/);
    expect(headers['X-Trace-Id']).not.toBe(headers['X-Correlation-Id']);
    expect(headers['X-Correlation-Id']).not.toBe('continued-session');
  });

  it('ignores supplied values that mimic protected direct-request content', async () => {
    process.env.NEXT_PUBLIC_FEATURE_FLAG_CHAT_DIRECT_STREAM = 'true';
    process.env.NEXT_PUBLIC_AGENT_URL = 'http://localhost:3002';

    const mockFetch = jest.fn().mockResolvedValue(new Response('ok'));
    global.fetch = mockFetch;

    const protectedFragments = {
      sessionId: 'continued-session',
      token: 'jwt-token-xyz',
      userId: 'user-123',
      offerId: 'off_123',
      message: 'safe-message',
    };
    const suppliedValues = {
      traceId: `chat_${protectedFragments.sessionId}`,
      correlationId: `chat_${protectedFragments.token}`,
      opaqueCorrelationId: `chat_${'a1'.repeat(16)}`,
      userId: protectedFragments.userId,
      offerId: protectedFragments.offerId,
      messageId: `chat_${protectedFragments.message}`,
    };

    await createChatStreamRequest({
      message: protectedFragments.message,
      sessionId: protectedFragments.sessionId,
      token: protectedFragments.token,
      ...suppliedValues,
    } as unknown as Parameters<typeof createChatStreamRequest>[0]);

    const request = mockFetch.mock.calls[0][1] as RequestInit;
    const headers = request.headers as Record<string, string>;
    expect(headers).toEqual(expect.objectContaining({
      'Content-Type': 'application/json',
      Authorization: 'Bearer jwt-token-xyz',
    }));
    expect(headers['X-Trace-Id']).toMatch(/^chat_[a-f0-9]{32}$/);
    expect(headers['X-Correlation-Id']).toMatch(/^chat_[a-f0-9]{32}$/);
    expect(headers['X-Trace-Id']).not.toBe(headers['X-Correlation-Id']);
    Object.values(suppliedValues).forEach((value) => {
      expect(headers['X-Correlation-Id']).not.toBe(value);
      expect(headers['X-Trace-Id']).not.toBe(value);
    });
    Object.values(protectedFragments).forEach((value) => {
      expect(headers['X-Correlation-Id']).not.toContain(value);
    });
  });
});
