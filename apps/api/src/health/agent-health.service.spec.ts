import { Test, TestingModule } from '@nestjs/testing';
import { AgentHealthService } from './agent-health.service';

describe('AgentHealthService', () => {
  let service: AgentHealthService;
  let originalFetch: typeof global.fetch;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AgentHealthService],
    }).compile();

    service = module.get<AgentHealthService>(AgentHealthService);
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('checkAgentHealth', () => {
    it('should query /health/live endpoint instead of /health', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok' }),
      } as unknown as Response);
      global.fetch = fetchMock;

      await service.checkAgentHealth('http://custom-agent:4000');
      expect(fetchMock).toHaveBeenCalledWith(
        'http://custom-agent:4000/health/live',
        expect.any(Object),
      );
      expect(fetchMock).not.toHaveBeenCalledWith(
        'http://custom-agent:4000/health',
        expect.any(Object),
      );
    });

    it('should normalize trailing slashes in agentUrl', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok' }),
      } as unknown as Response);
      global.fetch = fetchMock;

      await service.checkAgentHealth('http://custom-agent:4000///');
      expect(fetchMock).toHaveBeenCalledWith(
        'http://custom-agent:4000/health/live',
        expect.any(Object),
      );
    });

    it("should return up when /health/live returns 200 with status 'ok'", async () => {
      const details = { status: 'ok' };
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => details,
      } as unknown as Response);

      const result = await service.checkAgentHealth();
      expect(result).toEqual({
        status: 'up',
        details: { status: 'ok' },
      });
    });

    it('should return down when request aborts/times out after 2000ms', async () => {
      global.fetch = jest
        .fn()
        .mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'));

      const result = await service.checkAgentHealth();
      expect(result).toEqual({
        status: 'down',
      });
    });

    it('should return down without statusCode or internal leaks when agent returns non-200 (500)', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: 'Internal Server Error', stack: 'secret stack trace' }),
      } as unknown as Response);

      const result = await service.checkAgentHealth();
      expect(result).toEqual({
        status: 'down',
      });
      expect(result).not.toHaveProperty('statusCode');
      expect(result).not.toHaveProperty('details');
    });

    it('should return down when request throws ECONNREFUSED', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await service.checkAgentHealth();
      expect(result).toEqual({
        status: 'down',
      });
    });

    it("should return down when payload has status 'degraded'", async () => {
      const details = {
        status: 'degraded',
        dependencies: {
          llm: { status: 'down', error: 'Rate limit exceeded' },
        },
      };
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => details,
      } as unknown as Response);

      const result = await service.checkAgentHealth();
      expect(result).toEqual({
        status: 'down',
      });
      expect(result).not.toHaveProperty('details');
    });

    it('should return down when payload does not contain status ok or is empty', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({}),
      } as unknown as Response);

      const result = await service.checkAgentHealth();
      expect(result).toEqual({
        status: 'down',
      });
      expect(result).not.toHaveProperty('details');
    });

    it('should not leak headers, tokens, stack traces, URLs, or raw errors on failure', async () => {
      const sensitiveUrl = 'http://secret-internal-agent:3002/internal-path';
      const sensitiveError = new Error(
        'Sensitive connection failed to http://secret-internal-agent:3002 with token secret-token-xyz',
      );
      (sensitiveError as unknown as Record<string, unknown>).stack =
        'Error at internal/secret.ts:42';
      global.fetch = jest.fn().mockRejectedValue(sensitiveError);

      const result = await service.checkAgentHealth(sensitiveUrl);
      expect(result).toEqual({
        status: 'down',
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('secret-internal-agent');
      expect(serialized).not.toContain('secret-token-xyz');
      expect(serialized).not.toContain('stack');
      expect(serialized).not.toContain('Sensitive connection');
    });
  });
});
