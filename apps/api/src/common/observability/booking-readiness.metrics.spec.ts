import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  BookingReadinessMetricsService,
  BOOKING_READINESS_METRIC_COUNTERS,
  STANDARDIZED_READINESS_METRICS,
} from './booking-readiness.metrics';
import { CacheService } from '@/cache/cache.service';
import { PrismaService } from '@/prisma/prisma.service';

describe('BookingReadinessMetricsService', () => {
  let service: BookingReadinessMetricsService;
  let mockCacheService: jest.Mocked<Partial<CacheService>>;
  let mockPrismaService: jest.Mocked<Partial<PrismaService>>;
  let mockConfigService: jest.Mocked<Partial<ConfigService>>;

  beforeEach(async () => {
    mockCacheService = {
      checkHealth: jest.fn().mockResolvedValue('up'),
      incrby: jest.fn().mockResolvedValue(1),
      lpush: jest.fn().mockResolvedValue(1),
      ltrim: jest.fn().mockResolvedValue(undefined),
      lrange: jest.fn().mockResolvedValue([]),
      get: jest.fn().mockResolvedValue(null),
      keys: jest.fn().mockResolvedValue([]),
      del: jest.fn().mockResolvedValue(undefined),
    };

    mockPrismaService = {
      $transaction: jest.fn().mockResolvedValue(undefined) as unknown as jest.Mocked<PrismaService>['$transaction'],
    };

    mockConfigService = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'FEATURE_FLAG_BOOKING_READINESS') return 'true';
        return undefined;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingReadinessMetricsService,
        { provide: CacheService, useValue: mockCacheService },
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<BookingReadinessMetricsService>(BookingReadinessMetricsService);
  });

  describe('1. Standardized Counter Metrics & Local Management', () => {
    it('initializes all standardized metrics to 0', async () => {
      const snapshot = await service.getHealthSnapshot();
      for (const metric of STANDARDIZED_READINESS_METRICS) {
        expect(snapshot.metrics[metric]).toBe(0);
        expect(service.getMetric(metric)).toBe(0);
      }
    });

    it('increments local counter and triggers async cache incrby', () => {
      service.increment(BOOKING_READINESS_METRIC_COUNTERS.TRAVELER_PROFILE_READS, 2);
      expect(service.getMetric(BOOKING_READINESS_METRIC_COUNTERS.TRAVELER_PROFILE_READS)).toBe(2);
      expect(mockCacheService.incrby).toHaveBeenCalledWith(
        `metrics:booking_readiness:counter:${BOOKING_READINESS_METRIC_COUNTERS.TRAVELER_PROFILE_READS}`,
        2,
      );
    });

    it('handles cache incrby rejection gracefully without throwing', () => {
      mockCacheService.incrby = jest.fn().mockRejectedValue(new Error('Redis connection down'));
      expect(() => {
        service.increment(BOOKING_READINESS_METRIC_COUNTERS.BOOKING_READINESS_CHECKS, 1);
      }).not.toThrow();
      expect(service.getMetric(BOOKING_READINESS_METRIC_COUNTERS.BOOKING_READINESS_CHECKS)).toBe(1);
    });
  });

  describe('2. Latency Percentiles Calculation & Cache Sync', () => {
    it('returns zeroes when no latency samples exist for operation', () => {
      const stats = service.getLatencyPercentiles('non_existent_op');
      expect(stats).toEqual({
        count: 0,
        p50: 0,
        p90: 0,
        p95: 0,
        p99: 0,
        min: 0,
        max: 0,
        avg: 0,
      });
    });

    it('records latency samples, calculates correct percentiles, and syncs to cache', () => {
      for (let i = 1; i <= 100; i++) {
        service.recordLatency('advisory_eval', i);
      }

      const stats = service.getLatencyPercentiles('advisory_eval');
      expect(stats.count).toBe(100);
      expect(stats.min).toBe(1);
      expect(stats.max).toBe(100);
      expect(stats.p50).toBe(50);
      expect(stats.p90).toBe(90);
      expect(stats.p95).toBe(95);
      expect(stats.p99).toBe(99);
      expect(stats.avg).toBe(50.5);

      expect(mockCacheService.lpush).toHaveBeenCalledWith(
        'metrics:booking_readiness:latency:advisory_eval',
        '100',
      );
      expect(mockCacheService.ltrim).toHaveBeenCalledWith(
        'metrics:booking_readiness:latency:advisory_eval',
        0,
        1999,
      );
    });

    it('handles cache lpush/ltrim rejection gracefully', () => {
      mockCacheService.lpush = jest.fn().mockRejectedValue(new Error('Redis buffer full'));
      expect(() => {
        service.recordLatency('intent_create', 45);
      }).not.toThrow();
      expect(service.getLatencyPercentiles('intent_create').count).toBe(1);
    });
  });

  describe('3. Distributed Metrics Merging in Health Snapshot', () => {
    it('merges distributed counters from cache into health snapshot', async () => {
      mockCacheService.keys = jest.fn().mockResolvedValue([
        'metrics:booking_readiness:counter:traveler_profile_reads_total',
        'metrics:booking_readiness:counter:custom_metric_total',
      ]);
      mockCacheService.get = jest.fn().mockImplementation(async (key: string) => {
        if (key === 'metrics:booking_readiness:counter:traveler_profile_reads_total') return '42';
        if (key === 'metrics:booking_readiness:counter:custom_metric_total') return '15';
        return null;
      });

      const snapshot = await service.getHealthSnapshot();
      expect(snapshot.metrics.traveler_profile_reads_total).toBe(42);
      expect(snapshot.metrics.custom_metric_total).toBe(15);
    });

    it('merges distributed latency samples from cache into health snapshot', async () => {
      mockCacheService.keys = jest.fn().mockResolvedValue([
        'metrics:booking_readiness:latency:distributed_op',
      ]);
      mockCacheService.lrange = jest.fn().mockResolvedValue(['10', '20', '30', '40', '50']);

      const snapshot = await service.getHealthSnapshot();
      expect(snapshot.latency.distributed_op).toBeDefined();
      expect(snapshot.latency.distributed_op.count).toBe(5);
      expect(snapshot.latency.distributed_op.min).toBe(10);
      expect(snapshot.latency.distributed_op.max).toBe(50);
      expect(snapshot.latency.distributed_op.avg).toBe(30);
    });
  });

  describe('4. Health Degradation on Dependency Failure', () => {
    it('returns status ok when both database and redis are healthy', async () => {
      const snapshot = await service.getHealthSnapshot();
      expect(snapshot.status).toBe('ok');
      expect(snapshot.dependencies).toEqual({
        database: 'up',
        redis: 'up',
      });
      expect(snapshot.featureFlags.bookingReadiness).toBe(true);
    });

    it('returns status degraded when database is down', async () => {
      mockPrismaService.$transaction = jest.fn().mockRejectedValue(new Error('DB Connection Timeout'));

      const snapshot = await service.getHealthSnapshot();
      expect(snapshot.status).toBe('degraded');
      expect(snapshot.dependencies.database).toBe('down');
      expect(snapshot.dependencies.redis).toBe('up');
    });

    it('returns status degraded when redis is down', async () => {
      mockCacheService.checkHealth = jest.fn().mockResolvedValue('down');

      const snapshot = await service.getHealthSnapshot();
      expect(snapshot.status).toBe('degraded');
      expect(snapshot.dependencies.database).toBe('up');
      expect(snapshot.dependencies.redis).toBe('down');
    });

    it('returns status degraded when both database and redis are down', async () => {
      mockPrismaService.$transaction = jest.fn().mockRejectedValue(new Error('DB Down'));
      mockCacheService.checkHealth = jest.fn().mockRejectedValue(new Error('Redis Down'));

      const snapshot = await service.getHealthSnapshot();
      expect(snapshot.status).toBe('degraded');
      expect(snapshot.dependencies).toEqual({
        database: 'down',
        redis: 'down',
      });
    });
  });

  describe('5. Reset Metrics', () => {
    it('clears local counters, latency samples, and cache keys', async () => {
      service.increment(BOOKING_READINESS_METRIC_COUNTERS.TRAVELER_PROFILE_READS, 5);
      service.recordLatency('sample_op', 100);

      mockCacheService.keys = jest.fn().mockImplementation(async (pattern: string) => {
        if (pattern.includes('counter')) return ['metrics:booking_readiness:counter:test'];
        if (pattern.includes('latency')) return ['metrics:booking_readiness:latency:test'];
        return [];
      });

      await service.resetMetrics();

      expect(service.getMetric(BOOKING_READINESS_METRIC_COUNTERS.TRAVELER_PROFILE_READS)).toBe(0);
      expect(service.getLatencyPercentiles('sample_op').count).toBe(0);
      expect(mockCacheService.del).toHaveBeenCalledWith('metrics:booking_readiness:counter:test');
      expect(mockCacheService.del).toHaveBeenCalledWith('metrics:booking_readiness:latency:test');
    });
  });
});
