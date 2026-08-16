import assert from 'node:assert/strict';
import test, { describe, it } from 'node:test';
import { AgentHealthService } from '../src/health/agent-health.service';

describe('AgentHealthService (Unit)', () => {
  const service = new AgentHealthService();
  const originalFetch = global.fetch;

  test('should return up when agent returns 200 with status ok', async () => {
    const details = { status: 'ok', version: '0.1.0', dependencies: { llm: { status: 'ok' } } };
    global.fetch = async () => new Response(JSON.stringify(details), { status: 200 });

    try {
      const result = await service.checkAgentHealth();
      assert.deepEqual(result, {
        status: 'up',
        details,
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('should return down when agent returns 200 with status degraded', async () => {
    const details = {
      status: 'degraded',
      dependencies: {
        llm: { status: 'down', error: 'Rate limit exceeded' },
        redis: { status: 'ok' },
      },
    };
    global.fetch = async () => new Response(JSON.stringify(details), { status: 200 });

    try {
      const result = await service.checkAgentHealth();
      assert.deepEqual(result, {
        status: 'down',
        details,
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('should return down when agent returns 200 with status down', async () => {
    const details = { status: 'down', error: 'Service Unavailable' };
    global.fetch = async () => new Response(JSON.stringify(details), { status: 200 });

    try {
      const result = await service.checkAgentHealth();
      assert.deepEqual(result, {
        status: 'down',
        details,
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('should return down with statusCode when agent returns non-200 (500)', async () => {
    global.fetch = async () => new Response('Internal Server Error', { status: 500 });

    try {
      const result = await service.checkAgentHealth();
      assert.deepEqual(result, {
        status: 'down',
        statusCode: 500,
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('should return down when agent fetch throws error', async () => {
    global.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };

    try {
      const result = await service.checkAgentHealth();
      assert.deepEqual(result, {
        status: 'down',
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('should use customUrl parameter if provided', async () => {
    let requestedUrl = '';
    global.fetch = async (url: RequestInfo | URL) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    };

    try {
      await service.checkAgentHealth('http://custom-agent:4000/');
      assert.equal(requestedUrl, 'http://custom-agent:4000/health');
    } finally {
      global.fetch = originalFetch;
    }
  });
});
