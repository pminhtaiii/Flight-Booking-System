import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { getAgentStreamEndpoint, createChatStreamRequest } from './chatStream';
import { isOpaqueChatId } from './chatTrace';

describe('chatStream - Direct-Only Transport', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('always resolves to direct agent endpoint with default URL when NEXT_PUBLIC_AGENT_URL is unset', () => {
    delete process.env.NEXT_PUBLIC_AGENT_URL;
    delete process.env.NEXT_PUBLIC_ENABLE_DIRECT_AGENT_STREAM;
    delete process.env.NEXT_PUBLIC_FEATURE_FLAG_CHAT_DIRECT_STREAM;

    const endpoint = getAgentStreamEndpoint();
    assert.strictEqual(endpoint, 'http://localhost:3002/chat/stream');
    assert.notStrictEqual(endpoint, '/api/chat/stream');
  });

  it('respects configured NEXT_PUBLIC_AGENT_URL and trims trailing slashes', () => {
    process.env.NEXT_PUBLIC_AGENT_URL = 'http://custom-agent.internal:3002///';

    const endpoint = getAgentStreamEndpoint();
    assert.strictEqual(endpoint, 'http://custom-agent.internal:3002/chat/stream');
  });

  it('never routes to /api/chat/stream even if legacy false flags are provided in environment', () => {
    process.env.NEXT_PUBLIC_FEATURE_FLAG_CHAT_DIRECT_STREAM = 'false';
    process.env.NEXT_PUBLIC_ENABLE_DIRECT_AGENT_STREAM = 'false';
    process.env.NEXT_PUBLIC_AGENT_URL = 'http://127.0.0.1:3002';

    const endpoint = getAgentStreamEndpoint();
    assert.strictEqual(endpoint, 'http://127.0.0.1:3002/chat/stream');
    assert.notStrictEqual(endpoint, '/api/chat/stream');
  });

  it('generates independent opaque trace and correlation headers and attaches bearer auth directly', async () => {
    process.env.NEXT_PUBLIC_AGENT_URL = 'http://localhost:3002';

    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response('event: done\ndata: {}\n\n', { status: 200 });
    }) as typeof fetch;

    try {
      await createChatStreamRequest({
        message: 'test direct message',
        sessionId: 'sess-123',
        token: 'jwt-token-xyz',
      });

      assert.strictEqual(capturedUrl, 'http://localhost:3002/chat/stream');
      assert.strictEqual(capturedInit?.method, 'POST');
      assert.deepStrictEqual(JSON.parse(String(capturedInit?.body)), {
        message: 'test direct message',
        sessionId: 'sess-123',
      });

      const headers = capturedInit?.headers as Record<string, string>;
      assert.strictEqual(headers['Content-Type'], 'application/json');
      assert.strictEqual(headers['Authorization'], 'Bearer jwt-token-xyz');

      const traceId = headers['X-Trace-Id'];
      const correlationId = headers['X-Correlation-Id'];
      assert.strictEqual(isOpaqueChatId(traceId), true);
      assert.strictEqual(isOpaqueChatId(correlationId), true);
      assert.notStrictEqual(traceId, correlationId);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('never derives trace or correlation headers from session ID, tokens, or PII', async () => {
    process.env.NEXT_PUBLIC_AGENT_URL = 'http://localhost:3002';

    let capturedInit: RequestInit | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init;
      return new Response('event: done\ndata: {}\n\n', { status: 200 });
    }) as typeof fetch;

    const sensitiveSessionId = 'session-secret-999';
    const sensitiveToken = 'token-secret-888';

    try {
      await createChatStreamRequest({
        message: 'hello from user',
        sessionId: sensitiveSessionId,
        token: sensitiveToken,
      });

      const headers = capturedInit?.headers as Record<string, string>;
      const traceId = headers['X-Trace-Id'];
      const correlationId = headers['X-Correlation-Id'];

      assert.strictEqual(isOpaqueChatId(traceId), true);
      assert.strictEqual(isOpaqueChatId(correlationId), true);
      assert.strictEqual(traceId.includes(sensitiveSessionId), false);
      assert.strictEqual(correlationId.includes(sensitiveSessionId), false);
      assert.strictEqual(traceId.includes(sensitiveToken), false);
      assert.strictEqual(correlationId.includes(sensitiveToken), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
