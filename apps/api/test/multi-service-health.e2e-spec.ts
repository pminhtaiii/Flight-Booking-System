import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { CacheService } from '@/cache/cache.service';
import { Prisma } from '@prisma/client';

describe('Multi-Service Health & Subsystem Degradation (E2E)', () => {
  jest.setTimeout(30000);
  let app: INestApplication;
  let prismaService: PrismaService;
  let cacheService: CacheService;
  let dbMockSpy: jest.SpyInstance;
  let redisMockSpy: jest.SpyInstance;
  let originalFetch: typeof global.fetch;

  beforeAll(async () => {
    jest.spyOn(PrismaService.prototype, '$connect').mockImplementation(async () => {});
    jest.spyOn(PrismaService.prototype, '$disconnect').mockImplementation(async () => {});
    jest.spyOn(PrismaService.prototype, '$transaction').mockImplementation((callback, options) => {
      const tx = {
        $executeRawUnsafe: jest.fn().mockResolvedValue(1),
        $queryRaw: (query: unknown) => {
          if (prismaService) {
            return prismaService.$queryRaw(query as TemplateStringsArray);
          }
          return Promise.resolve([1]);
        },
        duffelWebhookEvent: {
          count: jest.fn().mockResolvedValue(0),
        },
      };
      const timeoutMs = (options as { timeout?: number })?.timeout ?? 150;
      let timeoutId: NodeJS.Timeout | undefined = undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Transaction timeout')), timeoutMs);
      });
      const executePromise = (async () => {
        try {
          return await (callback as (tx: unknown) => Promise<unknown>)(tx);
        } finally {
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
        }
      })();
      return Promise.race([executePromise, timeoutPromise]);
    });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api', {
      exclude: ['health', 'health/(.*)', 'api/health', 'api/health/(.*)'],
    });
    await app.init();

    prismaService = moduleFixture.get<PrismaService>(PrismaService);
    cacheService = moduleFixture.get<CacheService>(CacheService);
    originalFetch = global.fetch;
  });

  afterAll(async () => {
    global.fetch = originalFetch;
    await app.close();
  });

  beforeEach(() => {
    dbMockSpy = jest
      .spyOn(prismaService, '$queryRaw')
      .mockImplementation(() => Promise.resolve([1]) as unknown as Prisma.PrismaPromise<unknown>);
    redisMockSpy = jest.spyOn(cacheService, 'checkHealth').mockResolvedValue('up');
  });

  afterEach(() => {
    dbMockSpy.mockRestore();
    redisMockSpy.mockRestore();
    global.fetch = originalFetch;
  });

  describe('Full Stack Health Check (GET /health & GET /api/health)', () => {
    it('GET /health - returns 200 OK when DB and Redis are up', async () => {
      const res = await request(app.getHttpServer()).get('/health').expect(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.dependencies).toEqual({
        database: 'up',
        redis: 'up',
      });
      expect(res.body.processor).toBeDefined();
    });

    it('GET /api/health - returns 200 OK via prefixed route', async () => {
      const res = await request(app.getHttpServer()).get('/api/health').expect(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.dependencies).toEqual({
        database: 'up',
        redis: 'up',
      });
    });

    it('GET /health - returns 503 degraded when Redis is down but DB is up', async () => {
      redisMockSpy.mockResolvedValueOnce('down');
      const res = await request(app.getHttpServer()).get('/health').expect(503);
      expect(res.body.status).toBe('degraded');
      expect(res.body.dependencies).toEqual({
        database: 'up',
        redis: 'down',
      });
    });

    it('GET /health - returns 503 down when DB is down regardless of Redis state', async () => {
      dbMockSpy.mockRejectedValueOnce(new Error('DB Connection Lost'));
      const res = await request(app.getHttpServer()).get('/health').expect(503);
      expect(res.body.status).toBe('down');
      expect(res.body.dependencies).toEqual({
        database: 'down',
        redis: 'up',
      });
    });

    it('GET /health - returns 503 down when both DB and Redis are down', async () => {
      dbMockSpy.mockRejectedValueOnce(new Error('DB Connection Lost'));
      redisMockSpy.mockResolvedValueOnce('down');
      const res = await request(app.getHttpServer()).get('/health').expect(503);
      expect(res.body.status).toBe('down');
      expect(res.body.dependencies).toEqual({
        database: 'down',
        redis: 'down',
      });
    });
  });

  describe('Redis Health Endpoint (GET /health/redis & GET /api/health/redis)', () => {
    it('GET /health/redis - returns 200 when Redis is up', async () => {
      redisMockSpy.mockResolvedValueOnce('up');
      const res = await request(app.getHttpServer()).get('/health/redis').expect(200);
      expect(res.body).toEqual({
        status: 'ok',
        dependency: 'redis',
      });
    });

    it('GET /api/health/redis - returns 200 via prefixed route', async () => {
      redisMockSpy.mockResolvedValueOnce('up');
      const res = await request(app.getHttpServer()).get('/api/health/redis').expect(200);
      expect(res.body).toEqual({
        status: 'ok',
        dependency: 'redis',
      });
    });

    it('GET /health/redis - returns 503 when Redis is down', async () => {
      redisMockSpy.mockResolvedValueOnce('down');
      const res = await request(app.getHttpServer()).get('/health/redis').expect(503);
      expect(res.body).toEqual({
        status: 'down',
        dependency: 'redis',
      });
    });

    it('GET /health/redis - returns 503 when checkHealth throws unexpectedly', async () => {
      redisMockSpy.mockRejectedValueOnce(new Error('Redis internal crash'));
      const res = await request(app.getHttpServer()).get('/health/redis').expect(503);
      expect(res.body).toEqual({
        status: 'down',
        dependency: 'redis',
      });
    });
  });

  describe('Agent Health Endpoint (GET /health/agent & GET /api/health/agent)', () => {
    it('GET /health/agent - returns 200 with details when Python agent responds healthy', async () => {
      const mockAgentResponse = {
        status: 'ok',
        dependencies: {
          llm: { status: 'ok', latencyMs: 15 },
          guardrails: { status: 'ok', modelLoaded: true },
          redis: { status: 'ok' },
        },
        version: '0.1.0',
      };

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockAgentResponse,
      } as unknown as Response);

      const res = await request(app.getHttpServer()).get('/health/agent').expect(200);
      expect(res.body).toEqual({
        status: 'ok',
        dependency: 'agent',
        details: mockAgentResponse,
      });
    });

    it('GET /api/health/agent - returns 200 via prefixed route', async () => {
      const mockAgentResponse = { status: 'ok', version: '0.1.0' };
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockAgentResponse,
      } as unknown as Response);

      const res = await request(app.getHttpServer()).get('/api/health/agent').expect(200);
      expect(res.body).toEqual({
        status: 'ok',
        dependency: 'agent',
        details: mockAgentResponse,
      });
    });

    it('GET /health/agent - returns 503 when Python agent returns 500 error', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
      } as unknown as Response);

      const res = await request(app.getHttpServer()).get('/health/agent').expect(503);
      expect(res.body).toEqual({
        status: 'down',
        dependency: 'agent',
        statusCode: 500,
      });
    });

    it('GET /health/agent - returns 503 when Python agent connection fails/times out', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      const res = await request(app.getHttpServer()).get('/health/agent').expect(503);
      expect(res.body).toEqual({
        status: 'down',
        dependency: 'agent',
      });
    });
  });

  describe('Ancillary Health Endpoints', () => {
    it('GET /health/ping - returns 200 ok', async () => {
      const res = await request(app.getHttpServer()).get('/health/ping').expect(200);
      expect(res.body).toEqual({ status: 'ok' });
    });

    it('GET /api/health/ping - returns 200 ok', async () => {
      const res = await request(app.getHttpServer()).get('/api/health/ping').expect(200);
      expect(res.body).toEqual({ status: 'ok' });
    });

    it('GET /health/processor - returns 200 with processor metrics', async () => {
      const res = await request(app.getHttpServer()).get('/health/processor').expect(200);
      expect(res.body).toHaveProperty('processorEnabled');
    });
  });
});
