import { Test, TestingModule } from '@nestjs/testing';
import { CacheService } from '@/cache/cache.service';
import { DuffelRateBudgetService } from './duffel-rate-budget.service';

interface CacheServiceMock {
  checkAndIncrement: jest.Mock<
    Promise<{ allowed: boolean; current: number; storeError?: boolean }>,
    [
      primary: { key: string; limit: number; ttlSeconds: number },
      secondary?: { key: string; limit: number; ttlSeconds: number },
    ]
  >;
}

describe('DuffelRateBudgetService', () => {
  let service: DuffelRateBudgetService;
  let mockCacheService: CacheServiceMock;

  const fixedNow = new Date('2026-09-29T10:00:00.000Z');
  const expectedTtlSeconds = 14 * 3600; // 50,400 seconds until 2026-09-30T00:00:00.000Z
  const expectedResetAt = '2026-09-30T00:00:00.000Z';
  const expectedDailyKey = 'budget:duffel:daily:2026-09-29';

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(fixedNow);

    mockCacheService = {
      checkAndIncrement: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DuffelRateBudgetService,
        {
          provide: CacheService,
          useValue: mockCacheService,
        },
      ],
    }).compile();

    service = module.get<DuffelRateBudgetService>(DuffelRateBudgetService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('reserveAttempt', () => {
    describe('Daily limit reservation under default 1500 limit', () => {
      it('calls cacheService.checkAndIncrement with daily key, limit 1500, and TTL until next UTC midnight, returning { ok: true }', async () => {
        mockCacheService.checkAndIncrement.mockResolvedValue({
          allowed: true,
          current: 1,
        });

        const outcome = await service.reserveAttempt();

        expect(mockCacheService.checkAndIncrement).toHaveBeenCalledWith(
          {
            key: expectedDailyKey,
            limit: 1500,
            ttlSeconds: expectedTtlSeconds,
          },
          undefined,
        );
        expect(outcome).toEqual({ ok: true });
      });
    });

    describe('Secondary constraint propagation', () => {
      it('passes extraConstraint as secondary constraint to checkAndIncrement with matched TTL', async () => {
        mockCacheService.checkAndIncrement.mockResolvedValue({
          allowed: true,
          current: 1,
        });

        const outcome = await service.reserveAttempt({
          key: 'budget:duffel:caller:user',
          limit: 1000,
        });

        expect(mockCacheService.checkAndIncrement).toHaveBeenCalledWith(
          {
            key: expectedDailyKey,
            limit: 1500,
            ttlSeconds: expectedTtlSeconds,
          },
          {
            key: 'budget:duffel:caller:user',
            limit: 1000,
            ttlSeconds: expectedTtlSeconds,
          },
        );
        expect(outcome).toEqual({ ok: true });
      });
    });

    describe('Daily budget exhausted', () => {
      it('returns { ok: false, error: "EXHAUSTED", retryAfterSeconds, resetAt } when checkAndIncrement rejects limit', async () => {
        mockCacheService.checkAndIncrement.mockResolvedValue({
          allowed: false,
          current: 1500,
        });

        const outcome = await service.reserveAttempt();

        expect(outcome).toEqual({
          ok: false,
          error: 'EXHAUSTED',
          retryAfterSeconds: expectedTtlSeconds,
          resetAt: expectedResetAt,
        });
      });
    });

    describe('Store unavailable fail-closed', () => {
      it('returns { ok: false, error: "UNAVAILABLE", retryAfterSeconds } when checkAndIncrement indicates storeError', async () => {
        mockCacheService.checkAndIncrement.mockResolvedValue({
          allowed: false,
          current: 0,
          storeError: true,
        });

        const outcome = await service.reserveAttempt();

        expect(outcome.ok).toBe(false);
        if (!outcome.ok) {
          expect(outcome.error).toBe('UNAVAILABLE');
          expect(typeof outcome.retryAfterSeconds).toBe('number');
          expect(outcome.retryAfterSeconds).toBeGreaterThan(0);
        }
      });
    });

    describe('Concurrency safety', () => {
      it('respects atomic checkAndIncrement reservations across concurrent callers', async () => {
        mockCacheService.checkAndIncrement
          .mockResolvedValueOnce({ allowed: true, current: 1499 })
          .mockResolvedValueOnce({ allowed: true, current: 1500 })
          .mockResolvedValueOnce({ allowed: false, current: 1500 });

        const [r1, r2, r3] = await Promise.all([
          service.reserveAttempt(),
          service.reserveAttempt(),
          service.reserveAttempt(),
        ]);

        expect(r1).toEqual({ ok: true });
        expect(r2).toEqual({ ok: true });
        expect(r3).toEqual({
          ok: false,
          error: 'EXHAUSTED',
          retryAfterSeconds: expectedTtlSeconds,
          resetAt: expectedResetAt,
        });
      });
    });

    describe('Attempted-call semantics', () => {
      it('performs reservation upfront before invocation and provides no refund or decrement logic', async () => {
        const untypedService = service as unknown as Record<string, unknown>;

        expect(untypedService.refundAttempt).toBeUndefined();
        expect(untypedService.decrement).toBeUndefined();
        expect(untypedService.refund).toBeUndefined();
        expect(untypedService.releaseReservation).toBeUndefined();
      });
    });
  });
});
