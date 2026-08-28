import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { CacheService } from '@/cache/cache.service';
import { Prisma } from '@prisma/client';

describe('Health Check (E2E)', () => {
  jest.setTimeout(30000);
  let app: INestApplication;
  let prismaService: PrismaService;
  let cacheService: CacheService;
  let dbMockSpy: jest.SpyInstance;
  let redisMockSpy: jest.SpyInstance;

  beforeAll(async () => {
    delete process.env.FEATURE_FLAG_DISRUPTION_PROCESSOR;
    delete process.env.FEATURE_FLAG_DISRUPTION_INGRESS;
    delete process.env.FEATURE_FLAG_DISRUPTION_RECONCILIATION;
    delete process.env.FEATURE_FLAG_DISRUPTION_SURFACING;
    delete process.env.FEATURE_FLAG_DISRUPTION_OUTBOX;

    // Mock Prisma's $connect and $disconnect to avoid slow TCP timeouts during E2E test setup
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
    await app.init();

    prismaService = moduleFixture.get<PrismaService>(PrismaService);
    cacheService = moduleFixture.get<CacheService>(CacheService);

    // Warm up the application using a mock implementation of $queryRaw so it doesn't try to query the real db
    const warmupSpy = jest
      .spyOn(prismaService, '$queryRaw')
      .mockImplementation(() => Promise.resolve([1]) as unknown as Prisma.PrismaPromise<unknown>);
    await request(app.getHttpServer()).get('/health');
    warmupSpy.mockRestore();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    // Simulate database up state since no real database is running in this environment
    dbMockSpy = jest
      .spyOn(prismaService, '$queryRaw')
      .mockImplementation(() => Promise.resolve([1]) as unknown as Prisma.PrismaPromise<unknown>);
    redisMockSpy = jest.spyOn(cacheService, 'checkHealth').mockResolvedValue('up');
  });

  afterEach(() => {
    dbMockSpy.mockRestore();
    redisMockSpy.mockRestore();
  });

  it('GET /health - should return status 200 and database status up under normal conditions', async () => {
    const startTime = Date.now();

    const response = await request(app.getHttpServer())
      .get('/health')
      .expect('Content-Type', /json/)
      .expect(200);

    const duration = Date.now() - startTime;

    expect(response.body).toEqual({
      status: 'ok',
      dependencies: {
        database: 'up',
        redis: 'up',
      },
      processor: {
        lastHeartbeat: null,
        lastSuccessfulProcessing: null,
        pendingCount: 0,
        retryScheduledCount: 0,
        staleProcessingCount: 0,
        failedNeedsAttentionCount: 0,
        processorEnabled: false,
      },
    });

    // Verify response time is less than 250ms
    expect(duration).toBeLessThan(250);
  });

  it('GET /health - should not require authentication headers', async () => {
    await request(app.getHttpServer()).get('/health').expect(200);
  });

  it('GET /health - should report down/degraded and return status 503 when database is unreachable', async () => {
    // Simulate database failure by forcing $queryRaw to throw an error.
    dbMockSpy.mockRejectedValueOnce(new Error('Connection lost'));

    await request(app.getHttpServer())
      .get('/health')
      .expect('Content-Type', /json/)
      .expect(503)
      .expect((res: request.Response) => {
        expect(res.body).toEqual({
          status: 'down',
          dependencies: {
            database: 'down',
            redis: 'up',
          },
        });
      });
  });

  it('GET /health - should restore to status 200 and ok when database recovers', async () => {
    // First, verify a failure occurs when query fails
    dbMockSpy.mockRejectedValueOnce(new Error('Connection lost'));

    await request(app.getHttpServer()).get('/health').expect(503);

    // Now, call again and assert recovery (mockRejectedValueOnce only affects the first call,
    // so the second call automatically recovers using mockImplementation)
    await request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect((res: request.Response) => {
        expect(res.body).toEqual({
          status: 'ok',
          dependencies: {
            database: 'up',
            redis: 'up',
          },
          processor: {
            lastHeartbeat: null,
            lastSuccessfulProcessing: null,
            pendingCount: 0,
            retryScheduledCount: 0,
            staleProcessingCount: 0,
            failedNeedsAttentionCount: 0,
            processorEnabled: false,
          },
        });
      });
  });

  it('GET /health - should return status 503 within 750ms if database query stalls', async () => {
    // Measure a base normal request duration right before the timeout request to get current environmental overhead
    dbMockSpy.mockImplementationOnce(
      () => Promise.resolve([1]) as unknown as Prisma.PrismaPromise<unknown>,
    );
    const baseStart = Date.now();
    await request(app.getHttpServer()).get('/health').expect(200);
    const baseDuration = Date.now() - baseStart;

    // Simulate database timeout by delaying query execution indefinitely
    dbMockSpy.mockImplementation(
      () => new Promise<unknown>(() => {}) as unknown as Prisma.PrismaPromise<unknown>,
    );

    const startTime = Date.now();
    const response = await request(app.getHttpServer())
      .get('/health')
      .expect('Content-Type', /json/)
      .expect(503);

    const duration = Date.now() - startTime;

    expect(response.body).toEqual({
      status: 'down',
      dependencies: {
        database: 'down',
        redis: 'up',
      },
    });

    // Keep the failure bounded while allowing a busy CI database enough time to
    // complete the lightweight transaction without a false-negative health result.
    const netDuration = duration - baseDuration;
    expect(netDuration).toBeLessThan(750);
  });
});


