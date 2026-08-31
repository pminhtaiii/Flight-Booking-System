import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CacheService } from '@/cache/cache.service';
import { PrismaService } from '@/prisma/prisma.service';

export const BOOKING_READINESS_METRIC_COUNTERS = {
  TRAVELER_PROFILE_READS: 'traveler_profile_reads_total',
  TRAVELER_PROFILE_UPDATES: 'traveler_profile_updates_total',
  TRAVELER_PROFILE_CONFLICTS: 'traveler_profile_conflicts_total',
  BOOKING_READINESS_CHECKS: 'booking_readiness_checks_total',
  BOOKING_READINESS_EVALUATIONS: 'booking_readiness_evaluations_total',
  BOOKING_INTENT_CREATIONS: 'booking_intent_creations_total',
  BOOKING_INTENT_AUTHORITATIVE_REJECTIONS: 'booking_intent_authoritative_rejections_total',
  BOOKING_PASSENGER_FINAL_VALIDATION: 'booking_passenger_final_validation_total',
  BOOKING_PASSENGER_FINAL_VALIDATION_FAILURES: 'booking_passenger_final_validation_failures_total',
  PASSPORT_EXPIRY_BACKFILL_RUNS: 'passport_expiry_backfill_runs_total',
  PASSPORT_EXPIRY_BACKFILL_QUARANTINED: 'passport_expiry_backfill_quarantined_total',
  TRAVELER_PROFILE_SCORING_WINDOW_INTEGRITY_FAILURES:
    'traveler_profile_scoring_window_integrity_failures_total',
} as const;

export type BookingReadinessMetricCounter =
  (typeof BOOKING_READINESS_METRIC_COUNTERS)[keyof typeof BOOKING_READINESS_METRIC_COUNTERS];

export const STANDARDIZED_READINESS_METRICS = [
  'traveler_profile_reads_total',
  'traveler_profile_updates_total',
  'traveler_profile_conflicts_total',
  'booking_readiness_checks_total',
  'booking_readiness_evaluations_total',
  'booking_intent_creations_total',
  'booking_intent_authoritative_rejections_total',
  'booking_passenger_final_validation_total',
  'booking_passenger_final_validation_failures_total',
  'passport_expiry_backfill_runs_total',
  'passport_expiry_backfill_quarantined_total',
  'traveler_profile_scoring_window_integrity_failures_total',
] as const;

export interface LatencyPercentiles {
  count: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  avg: number;
}

export interface BookingReadinessHealthSnapshot {
  status: 'ok' | 'degraded';
  dependencies: {
    database: 'up' | 'down';
    redis: 'up' | 'down';
  };
  metrics: Record<string, number>;
  latency: Record<string, LatencyPercentiles>;
  featureFlags: {
    bookingReadiness: boolean;
  };
}

@Injectable()
export class BookingReadinessMetricsService {
  private readonly logger = new Logger(BookingReadinessMetricsService.name);
  private readonly counters: Map<string, number> = new Map();
  private readonly latencySamples: Map<string, number[]> = new Map();
  private readonly maxSamples = 2000;

  constructor(
    @Optional() private readonly configService?: ConfigService,
    @Optional() private readonly cacheService?: CacheService,
    @Optional() private readonly prisma?: PrismaService,
  ) {
    this.resetLocalMetrics();
  }

  private resetLocalMetrics(): void {
    this.counters.clear();
    for (const metric of STANDARDIZED_READINESS_METRICS) {
      this.counters.set(metric, 0);
    }
    this.latencySamples.clear();
  }

  async resetMetrics(): Promise<void> {
    this.resetLocalMetrics();
    if (this.cacheService) {
      try {
        const counterKeys = await this.cacheService.keys('metrics:booking_readiness:counter:*');
        const latencyKeys = await this.cacheService.keys('metrics:booking_readiness:latency:*');
        await Promise.all([
          ...counterKeys.map((k) => this.cacheService!.del(k)),
          ...latencyKeys.map((k) => this.cacheService!.del(k)),
        ]);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to reset cache metrics: ${errMsg}`);
      }
    }
  }

  increment(metric: BookingReadinessMetricCounter | string, amount = 1): void {
    const current = this.counters.get(metric) ?? 0;
    this.counters.set(metric, current + amount);

    if (this.cacheService) {
      this.cacheService
        .incrby(`metrics:booking_readiness:counter:${metric}`, amount)
        .catch((err: unknown) => {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.logger.warn(`Failed to sync counter ${metric} to cache: ${errMsg}`);
        });
    }
  }

  getMetric(metric: BookingReadinessMetricCounter | string): number {
    return this.counters.get(metric) ?? 0;
  }

  recordLatency(operation: string, latencyMs: number): void {
    const rounded = Math.max(0, Math.round(latencyMs));
    if (!this.latencySamples.has(operation)) {
      this.latencySamples.set(operation, []);
    }
    const samples = this.latencySamples.get(operation)!;
    if (samples.length >= this.maxSamples) {
      samples.shift();
    }
    samples.push(rounded);

    if (this.cacheService) {
      const key = `metrics:booking_readiness:latency:${operation}`;
      Promise.all([
        this.cacheService.lpush(key, String(rounded)),
        this.cacheService.ltrim(key, 0, this.maxSamples - 1),
      ]).catch((err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to sync latency sample for ${operation} to cache: ${errMsg}`);
      });
    }
  }

  private calculatePercentile(sorted: number[], percentile: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
  }

  private computePercentiles(raw: number[]): LatencyPercentiles {
    if (raw.length === 0) {
      return { count: 0, p50: 0, p90: 0, p95: 0, p99: 0, min: 0, max: 0, avg: 0 };
    }
    const sorted = [...raw].sort((a, b) => a - b);
    const sum = sorted.reduce((acc, val) => acc + val, 0);
    return {
      count: sorted.length,
      p50: this.calculatePercentile(sorted, 50),
      p90: this.calculatePercentile(sorted, 90),
      p95: this.calculatePercentile(sorted, 95),
      p99: this.calculatePercentile(sorted, 99),
      min: sorted[0],
      max: sorted[sorted.length - 1],
      avg: Math.round((sum / sorted.length) * 100) / 100,
    };
  }

  getLatencyPercentiles(operation: string): LatencyPercentiles {
    const raw = this.latencySamples.get(operation) ?? [];
    return this.computePercentiles(raw);
  }

  async getHealthSnapshot(): Promise<BookingReadinessHealthSnapshot> {
    let dbStatus: 'up' | 'down' = 'up';
    if (this.prisma) {
      try {
        await this.prisma.$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe('SET LOCAL statement_timeout = 500');
            await tx.$queryRaw`SELECT 1`;
          },
          {
            maxWait: 150,
            timeout: 150,
          },
        );
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Database health check failed in readiness metrics: ${errMsg}`);
        dbStatus = 'down';
      }
    }

    let redisStatus: 'up' | 'down' = 'up';
    if (this.cacheService) {
      try {
        redisStatus = await this.cacheService.checkHealth();
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Redis health check failed in readiness metrics: ${errMsg}`);
        redisStatus = 'down';
      }
    }

    const metrics: Record<string, number> = {};
    for (const metric of STANDARDIZED_READINESS_METRICS) {
      metrics[metric] = this.counters.get(metric) ?? 0;
    }
    for (const [key, value] of this.counters.entries()) {
      metrics[key] = value;
    }

    if (this.cacheService && redisStatus === 'up') {
      try {
        const counterKeys = await this.cacheService.keys('metrics:booking_readiness:counter:*');
        for (const key of counterKeys) {
          const metricName = key.replace('metrics:booking_readiness:counter:', '');
          const val = await this.cacheService.get(key);
          if (val !== null) {
            const num = parseInt(val, 10) || 0;
            metrics[metricName] = Math.max(metrics[metricName] ?? 0, num);
          }
        }
        for (const metric of STANDARDIZED_READINESS_METRICS) {
          if (!counterKeys.includes(`metrics:booking_readiness:counter:${metric}`)) {
            const val = await this.cacheService.get(`metrics:booking_readiness:counter:${metric}`);
            if (val !== null) {
              const num = parseInt(val, 10) || 0;
              metrics[metric] = Math.max(metrics[metric] ?? 0, num);
            }
          }
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to merge distributed counters from cache: ${errMsg}`);
      }
    }

    const latency: Record<string, LatencyPercentiles> = {};
    const latencyOps = new Set<string>([...this.latencySamples.keys()]);

    if (this.cacheService && redisStatus === 'up') {
      try {
        const latencyKeys = await this.cacheService.keys('metrics:booking_readiness:latency:*');
        for (const key of latencyKeys) {
          latencyOps.add(key.replace('metrics:booking_readiness:latency:', ''));
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to fetch latency keys from cache: ${errMsg}`);
      }
    }

    for (const operation of latencyOps) {
      let samples: number[] = [];
      if (this.cacheService && redisStatus === 'up') {
        try {
          const rawList = await this.cacheService.lrange(
            `metrics:booking_readiness:latency:${operation}`,
            0,
            -1,
          );
          if (rawList && rawList.length > 0) {
            samples = rawList.map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
          }
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.logger.warn(`Failed to read latency samples for ${operation} from cache: ${errMsg}`);
        }
      }

      if (samples.length === 0) {
        samples = this.latencySamples.get(operation) ?? [];
      }

      latency[operation] = this.computePercentiles(samples);
    }

    const flagVal =
      this.configService?.get<string>('FEATURE_FLAG_BOOKING_READINESS') ??
      process.env.FEATURE_FLAG_BOOKING_READINESS;
    const bookingReadiness = flagVal === 'true';

    const status: 'ok' | 'degraded' =
      dbStatus === 'down' || redisStatus === 'down' ? 'degraded' : 'ok';

    return {
      status,
      dependencies: {
        database: dbStatus,
        redis: redisStatus,
      },
      metrics,
      latency,
      featureFlags: {
        bookingReadiness,
      },
    };
  }
}
