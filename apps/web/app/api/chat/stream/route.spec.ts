import { NextRequest } from 'next/server';
import { isOpaqueChatId } from '@/lib/chatTrace';
import { POST } from './route';

jest.mock('next-auth', () => ({
  getServerSession: jest.fn().mockResolvedValue({
    accessToken: 'session-access-token',
  }),
}));

jest.mock('@/lib/auth', () => ({ authOptions: {} }), { virtual: true });

describe('POST /api/chat/stream', () => {
  const originalAgentServiceUrl = process.env.AGENT_SERVICE_URL;
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.AGENT_SERVICE_URL = 'http://agent.test';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalAgentServiceUrl === undefined) {
      delete process.env.AGENT_SERVICE_URL;
    } else {
      process.env.AGENT_SERVICE_URL = originalAgentServiceUrl;
    }
    global.fetch = originalFetch;
  });

  it('forwards valid opaque headers and passes ACTION_REQUIRED SSE through unchanged', async () => {
    const traceId = `chat_${'a'.repeat(32)}`;
    const correlationId = `chat_${'b'.repeat(32)}`;
    expect(isOpaqueChatId(traceId)).toBe(true);
    expect(isOpaqueChatId(correlationId)).toBe(true);
    const sseBody =
      'event: ACTION_REQUIRED\n' +
      'data: {"action":"COMPLETE_PROFILE","fields":["passportNumber"]}\n\n';
    const upstreamFetch = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(sseBody, { status: 200 }));

    const request = new NextRequest('http://127.0.0.1/api/chat/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Trace-Id': traceId,
        'X-Correlation-Id': correlationId,
      },
      body: JSON.stringify({ message: 'checkout' }),
    });

    const response = await POST(request);
    const upstreamInit = upstreamFetch.mock.calls[0][1];
    const upstreamHeaders = new Headers(upstreamInit?.headers);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(sseBody);
    expect(upstreamFetch).toHaveBeenCalledWith(
      'http://agent.test/chat/stream',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(upstreamHeaders.get('Authorization')).toBe('Bearer session-access-token');
    expect(upstreamHeaders.get('Content-Type')).toBe('application/json');
    expect(upstreamHeaders.get('X-Trace-Id')).toBe(traceId);
    expect(upstreamHeaders.get('X-Correlation-Id')).toBe(correlationId);
  });

  it('drops arbitrary and PII-like correlation values before forwarding upstream', async () => {
    const upstreamFetch = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('event: done\ndata: {}\n\n', { status: 200 }));
    const request = new NextRequest('http://127.0.0.1/api/chat/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Trace-Id': 'user-123@example.com',
        'X-Correlation-Id': 'session-123-with-message-content',
      },
      body: JSON.stringify({ message: 'safe test input' }),
    });

    await POST(request);

    const upstreamInit = upstreamFetch.mock.calls[0][1];
    const upstreamHeaders = new Headers(upstreamInit?.headers);

    expect(upstreamHeaders.get('Authorization')).toBe('Bearer session-access-token');
    expect(upstreamHeaders.get('Content-Type')).toBe('application/json');
    expect(upstreamHeaders.has('X-Trace-Id')).toBe(false);
    expect(upstreamHeaders.has('X-Correlation-Id')).toBe(false);
  });
});
