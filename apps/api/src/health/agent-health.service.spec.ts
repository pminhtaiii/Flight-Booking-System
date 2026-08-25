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
    it("should return up when agent returns 200 with status 'ok'", async () => {
      const details = { status: 'ok', version: '0.1.0' };
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => details,
      } as unknown as Response);

      const result = await service.checkAgentHealth();
      expect(result).toEqual({
        status: 'up',
        details,
      });
    });

    it("should return down when agent returns 200 with status 'degraded'", async () => {
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
        details,
      });
    });

    it("should return down when agent returns 200 with status 'down'", async () => {
      const details = { status: 'down', error: 'Service Unavailable' };
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => details,
      } as unknown as Response);

      const result = await service.checkAgentHealth();
      expect(result).toEqual({
        status: 'down',
        details,
      });
    });

    it('should return down with statusCode when agent returns non-200 (500)', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
      } as unknown as Response);

      const result = await service.checkAgentHealth();
      expect(result).toEqual({
        status: 'down',
        statusCode: 500,
      });
    });

    it('should return down when agent fetch throws error', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await service.checkAgentHealth();
      expect(result).toEqual({
        status: 'down',
      });
    });

    it('should return down when agent fetch times out / aborts', async () => {
      global.fetch = jest.fn().mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'));

      const result = await service.checkAgentHealth();
      expect(result).toEqual({
        status: 'down',
      });
    });

    it('should use customUrl parameter if provided', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok' }),
      } as unknown as Response);
      global.fetch = fetchMock;

      await service.checkAgentHealth('http://custom-agent:4000/');
      expect(fetchMock).toHaveBeenCalledWith('http://custom-agent:4000/health', expect.any(Object));
    });
  });
});
