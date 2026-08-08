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

  it('sends bearer token and correlation headers when direct stream is enabled', async () => {
    process.env.NEXT_PUBLIC_FEATURE_FLAG_CHAT_DIRECT_STREAM = 'true';
    process.env.NEXT_PUBLIC_AGENT_URL = 'http://localhost:3002';

    const mockFetch = jest.fn().mockResolvedValue(new Response('ok'));
    global.fetch = mockFetch;

    await createChatStreamRequest({
      message: 'test message',
      sessionId: 'sess-123',
      token: 'jwt-token-xyz',
      traceId: 'trace-456',
      correlationId: 'corr-789',
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3002/chat/stream',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer jwt-token-xyz',
          'X-Trace-Id': 'trace-456',
          'X-Correlation-Id': 'corr-789',
        },
        body: JSON.stringify({ message: 'test message', sessionId: 'sess-123' }),
      }),
    );
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
    expect(request.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer jwt-token-xyz',
    });
  });

  it('drops request identifiers that equal protected request content', async () => {
    process.env.NEXT_PUBLIC_FEATURE_FLAG_CHAT_DIRECT_STREAM = 'true';
    process.env.NEXT_PUBLIC_AGENT_URL = 'http://localhost:3002';

    const mockFetch = jest.fn().mockResolvedValue(new Response('ok'));
    global.fetch = mockFetch;

    await createChatStreamRequest({
      message: 'safe-message',
      sessionId: 'continued-session',
      token: 'jwt-token-xyz',
      traceId: 'continued-session',
      correlationId: 'jwt-token-xyz',
    });

    const request = mockFetch.mock.calls[0][1] as RequestInit;
    expect(request.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer jwt-token-xyz',
    });
  });
});
