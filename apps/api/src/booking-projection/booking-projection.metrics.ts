import { Injectable, Logger, Optional } from '@nestjs/common';
import { CacheService } from '@/cache/cache.service';
import { PrismaService } from '@/prisma/prisma.service';

export const BOOKING_PROJECTION_METRIC_NAMES = {
  EVENTS_TOTAL: 'booking_projection_events_total',
  DURATION_MS: 'booking_projection_duration_ms',
  RECONCILIATION_PASS_TOTAL: 'booking_projection_reconciliation_pass_total',
  RECONCILIATION_STALE_FOUND_TOTAL:
    'booking_projection_reconciliation_stale_found_total',
  RECONCILIATION_REPAIRED_TOTAL:
    'booking_projection_reconciliation_repaired_total',
  RECONCILIATION_FAILED_TOTAL: 'booking_projection_reconciliation_failed_total',
  RECONCILIATION_SKIPPED_TOTAL:
    'booking_projection_reconciliation_skipped_total',
  RECONCILIATION_CURRENT_TOTAL:
    'booking_projection_reconciliation_current_total',
  RECONCILIATION_DURATION_MS: 'booking_projection_reconciliation_duration_ms',
  FAILURE_TOTAL: 'booking_projection_failure_total',
} as const;

export type ProjectionMetricStatus = 'SUCCESS' | 'ERROR' | 'STALE_IGNORED';
export type ReconciliationPassOutcome = 'SUCCESS' | 'ERROR';
export type ProjectionErrorType =
  | 'HYDRATION_FAILED'
  | 'EXTRACTION_FAILED'
  | 'UNEXPECTED_ERROR'
  | 'INVALID_EVENT'
  | 'DATABASE_ERROR'
  | 'UNKNOWN';

export interface ClusterPassState {
  outcome: ReconciliationPassOutcome;
  consecutiveErrors: number;
  timestamp: number;
}

export interface ProjectionDurationStats {
  count: number;
  min: number;
  max: number;
  avg: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
}

export interface BookingProjectionHealthSnapshot {
  status: 'ok' | 'degraded';
  dependencies: {
    database: 'up' | 'down';
    redis: 'up' | 'down';
  };
  metrics: {
    reconciliation: {
      passes: {
        success: number;
        error: number;
      };
      candidates: {
        staleFound: number;
        repaired: number;
        failed: number;
        skipped: number;
        current: number;
      };
      duration: ProjectionDurationStats;
    };
    failures: Record<string, number>;
    events: Record<string, number>;
  };
}

const VALID_STATUSES: Set<string> = new Set<ProjectionMetricStatus>([
  'SUCCESS',
  'ERROR',
  'STALE_IGNORED',
]);

const VALID_RECONCILIATION_OUTCOMES: Set<ReconciliationPassOutcome> =
  new Set<ReconciliationPassOutcome>(['SUCCESS', 'ERROR']);

const VALID_ERROR_TYPES: Set<ProjectionErrorType> =
  new Set<ProjectionErrorType>([
    'HYDRATION_FAILED',
    'EXTRACTION_FAILED',
    'UNEXPECTED_ERROR',
    'INVALID_EVENT',
    'DATABASE_ERROR',
    'UNKNOWN',
  ]);

const MAX_COUNTER_ENTRIES = 100;
const MAX_DURATION_SAMPLES = 1000;
const REDIS_COUNTER_PREFIX = 'metrics:booking_projection:counter:';
const REDIS_LATENCY_PREFIX = 'metrics:booking_projection:latency:';
export const REDIS_LATEST_PASS_STATE_KEY =
  'metrics:booking_projection:latest_pass_state';

// Disallowed patterns in metric labels to avoid PII, booking IDs, user IDs or high cardinality
const UNSAFE_LABEL_PATTERN =
  /(?:@|bk_|usr_|uuid|[0-9a-f]{8}-[0-9a-f]{4}|[0-9a-f]{16})/i;
const SAFE_EVENT_NAME_PATTERN = /^booking\.[a-z0-9_.-]+$/i;

@Injectable()
export class BookingProjectionMetrics {
  private readonly logger = new Logger(BookingProjectionMetrics.name);
  private readonly counters = new Map<string, number>();
  private readonly durationSamples: number[] = [];
  private readonly reconciliationPassCounters = new Map<
    ReconciliationPassOutcome,
    number
  >();
  private readonly failureCounters = new Map<ProjectionErrorType, number>();
  private readonly reconciliationDurationSamples: number[] = [];
  private reconciliationStaleFoundTotal = 0;
  private reconciliationRepairedTotal = 0;
  private reconciliationFailedTotal = 0;
  private reconciliationSkippedTotal = 0;
  private reconciliationCurrentTotal = 0;

  private lastPassOutcome?: ReconciliationPassOutcome;
  private consecutivePassErrors = 0;

  constructor(
    @Optional() private readonly cacheService?: CacheService,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  getLastPassOutcome(): ReconciliationPassOutcome | undefined {
    return this.lastPassOutcome;
  }

  getConsecutivePassErrors(): number {
    return this.consecutivePassErrors;
  }

  private sanitizeEventName(eventName: string): string {
    if (!eventName || typeof eventName !== 'string') {
      return 'booking.unknown';
    }
    const trimmed = eventName.trim().toLowerCase();
    if (
      UNSAFE_LABEL_PATTERN.test(trimmed) ||
      !SAFE_EVENT_NAME_PATTERN.test(trimmed)
    ) {
      return 'booking.unknown';
    }
    return trimmed;
  }

  private sanitizeStatus(status: string): ProjectionMetricStatus {
    if (VALID_STATUSES.has(status as ProjectionMetricStatus)) {
      return status as ProjectionMetricStatus;
    }
    return 'ERROR';
  }

  private sanitizeReconciliationOutcome(
    outcome: string,
  ): ReconciliationPassOutcome {
    if (!outcome || typeof outcome !== 'string') {
      return 'ERROR';
    }
    const trimmed = outcome.trim().toUpperCase();
    if (UNSAFE_LABEL_PATTERN.test(trimmed)) {
      return 'ERROR';
    }
    if (
      VALID_RECONCILIATION_OUTCOMES.has(trimmed as ReconciliationPassOutcome)
    ) {
      return trimmed as ReconciliationPassOutcome;
    }
    return 'ERROR';
  }

  private sanitizeErrorType(errorType: string): ProjectionErrorType {
    if (!errorType || typeof errorType !== 'string') {
      return 'UNKNOWN';
    }
    const trimmed = errorType.trim().toUpperCase();
    if (UNSAFE_LABEL_PATTERN.test(trimmed)) {
      return 'UNKNOWN';
    }
    if (VALID_ERROR_TYPES.has(trimmed as ProjectionErrorType)) {
      return trimmed as ProjectionErrorType;
    }
    return 'UNKNOWN';
  }

  private makeCounterKey(eventName: string, status: ProjectionMetricStatus): string {
    return `${eventName}:${status}`;
  }

  incrementEventsTotal(
    rawEventName: string,
    rawStatus: ProjectionMetricStatus | string,
    amount = 1,
  ): void {
    const eventName = this.sanitizeEventName(rawEventName);
    const status = this.sanitizeStatus(rawStatus);
    const key = this.makeCounterKey(eventName, status);

    const current = this.counters.get(key) ?? 0;
    if (!this.counters.has(key) && this.counters.size >= MAX_COUNTER_ENTRIES) {
      // Bounded storage protection
      const fallbackKey = `booking.unknown:${status}`;
      if (!this.counters.has(fallbackKey)) {
        const oldestKey = this.counters.keys().next().value;
        if (oldestKey !== undefined) {
          this.counters.delete(oldestKey);
        }
      }
      const fallbackCurrent = this.counters.get(fallbackKey) ?? 0;
      this.counters.set(fallbackKey, fallbackCurrent + amount);

      if (this.cacheService) {
        this.cacheService
          .incrby(`${REDIS_COUNTER_PREFIX}events:${fallbackKey}`, amount)
          .catch((err: unknown) => {
            const errMsg = err instanceof Error ? err.message : String(err);
            this.logger.warn(`Failed to sync counter events:${fallbackKey} to cache: ${errMsg}`);
          });
      }
      return;
    }

    this.counters.set(key, current + amount);

    if (this.cacheService) {
      this.cacheService
        .incrby(`${REDIS_COUNTER_PREFIX}events:${key}`, amount)
        .catch((err: unknown) => {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.logger.warn(`Failed to sync counter events:${key} to cache: ${errMsg}`);
        });
    }
  }

  recordDuration(durationMs: number): void {
    const rounded = Math.max(0, Math.round(durationMs));
    if (this.durationSamples.length >= MAX_DURATION_SAMPLES) {
      this.durationSamples.shift();
    }
    this.durationSamples.push(rounded);

    if (this.cacheService) {
      const key = `${REDIS_LATENCY_PREFIX}duration_ms`;
      Promise.all([
        this.cacheService.lpush(key, String(rounded)),
        this.cacheService.ltrim(key, 0, MAX_DURATION_SAMPLES - 1),
      ]).catch((err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to sync duration to cache: ${errMsg}`);
      });
    }
  }

  getEventsTotal(eventName?: string, status?: ProjectionMetricStatus): number {
    if (eventName && status) {
      const sanitizedEvent = this.sanitizeEventName(eventName);
      const sanitizedStatus = this.sanitizeStatus(status);
      return this.counters.get(this.makeCounterKey(sanitizedEvent, sanitizedStatus)) ?? 0;
    }

    if (eventName) {
      const sanitizedEvent = this.sanitizeEventName(eventName);
      let total = 0;
      for (const validStatus of VALID_STATUSES) {
        total += this.counters.get(this.makeCounterKey(sanitizedEvent, validStatus as ProjectionMetricStatus)) ?? 0;
      }
      return total;
    }

    if (status) {
      const sanitizedStatus = this.sanitizeStatus(status);
      let total = 0;
      for (const [key, value] of this.counters.entries()) {
        if (key.endsWith(`:${sanitizedStatus}`)) {
          total += value;
        }
      }
      return total;
    }

    let grandTotal = 0;
    for (const value of this.counters.values()) {
      grandTotal += value;
    }
    return grandTotal;
  }

  getAllEventTotals(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [key, value] of this.counters.entries()) {
      result[key] = value;
    }
    return result;
  }

  getDurations(): number[] {
    return [...this.durationSamples];
  }

  private calculatePercentile(sorted: number[], percentile: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
  }

  private computeDurationStats(samples: number[]): ProjectionDurationStats {
    if (samples.length === 0) {
      return {
        count: 0,
        p50: 0,
        p90: 0,
        p95: 0,
        p99: 0,
        min: 0,
        max: 0,
        avg: 0,
      };
    }

    const sorted = [...samples].sort((a, b) => a - b);
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

  getDurationStats(): ProjectionDurationStats {
    return this.computeDurationStats(this.durationSamples);
  }

  incrementReconciliationPassTotal(
    rawOutcome: ReconciliationPassOutcome | string,
    amount = 1,
  ): void {
    const outcome = this.sanitizeReconciliationOutcome(rawOutcome);
    const current = this.reconciliationPassCounters.get(outcome) ?? 0;
    this.reconciliationPassCounters.set(outcome, current + amount);

    if (outcome === 'SUCCESS') {
      this.lastPassOutcome = 'SUCCESS';
      this.consecutivePassErrors = 0;
    } else {
      this.lastPassOutcome = 'ERROR';
      this.consecutivePassErrors += amount;
    }

    if (this.cacheService) {
      this.cacheService
        .incrby(
          `${REDIS_COUNTER_PREFIX}reconciliation:pass:${outcome.toLowerCase()}`,
          amount,
        )
        .catch((err: unknown) => {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `Failed to sync reconciliation pass counter to cache: ${errMsg}`,
          );
        });

      (async () => {
        try {
          let consecutiveErrors = outcome === 'SUCCESS' ? 0 : amount;
          if (outcome === 'ERROR') {
            const existing = await this.cacheService!.get(REDIS_LATEST_PASS_STATE_KEY);
            if (existing) {
              try {
                const parsed = JSON.parse(existing) as ClusterPassState;
                if (parsed.outcome === 'ERROR') {
                  consecutiveErrors = (parsed.consecutiveErrors ?? 0) + amount;
                }
              } catch {}
            }
          }
          const state: ClusterPassState = {
            outcome,
            consecutiveErrors,
            timestamp: Date.now(),
          };
          await this.cacheService!.set(REDIS_LATEST_PASS_STATE_KEY, JSON.stringify(state));
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.logger.warn(`Failed to sync latest pass state to cache: ${errMsg}`);
        }
      })();
    }
  }

  getReconciliationPassTotal(outcome?: ReconciliationPassOutcome): number {
    if (outcome) {
      const sanitized = this.sanitizeReconciliationOutcome(outcome);
      return this.reconciliationPassCounters.get(sanitized) ?? 0;
    }
    let total = 0;
    for (const val of this.reconciliationPassCounters.values()) {
      total += val;
    }
    return total;
  }

  incrementReconciliationStaleFoundTotal(amount = 1): void {
    this.reconciliationStaleFoundTotal += amount;
    if (this.cacheService) {
      this.cacheService
        .incrby(`${REDIS_COUNTER_PREFIX}reconciliation:stale_found`, amount)
        .catch((err: unknown) => {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.logger.warn(`Failed to sync stale_found counter to cache: ${errMsg}`);
        });
    }
  }

  getReconciliationStaleFoundTotal(): number {
    return this.reconciliationStaleFoundTotal;
  }

  incrementReconciliationRepairedTotal(amount = 1): void {
    this.reconciliationRepairedTotal += amount;
    if (this.cacheService) {
      this.cacheService
        .incrby(`${REDIS_COUNTER_PREFIX}reconciliation:repaired`, amount)
        .catch((err: unknown) => {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.logger.warn(`Failed to sync repaired counter to cache: ${errMsg}`);
        });
    }
  }

  getReconciliationRepairedTotal(): number {
    return this.reconciliationRepairedTotal;
  }

  incrementReconciliationFailedTotal(amount = 1): void {
    this.reconciliationFailedTotal += amount;
    if (this.cacheService) {
      this.cacheService
        .incrby(`${REDIS_COUNTER_PREFIX}reconciliation:failed`, amount)
        .catch((err: unknown) => {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.logger.warn(`Failed to sync failed counter to cache: ${errMsg}`);
        });
    }
  }

  getReconciliationFailedTotal(): number {
    return this.reconciliationFailedTotal;
  }

  incrementReconciliationSkippedTotal(amount = 1): void {
    this.reconciliationSkippedTotal += amount;
    if (this.cacheService) {
      this.cacheService
        .incrby(`${REDIS_COUNTER_PREFIX}reconciliation:skipped`, amount)
        .catch((err: unknown) => {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.logger.warn(`Failed to sync skipped counter to cache: ${errMsg}`);
        });
    }
  }

  getReconciliationSkippedTotal(): number {
    return this.reconciliationSkippedTotal;
  }

  incrementReconciliationCurrentTotal(amount = 1): void {
    this.reconciliationCurrentTotal += amount;
    if (this.cacheService) {
      this.cacheService
        .incrby(`${REDIS_COUNTER_PREFIX}reconciliation:current`, amount)
        .catch((err: unknown) => {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.logger.warn(`Failed to sync current counter to cache: ${errMsg}`);
        });
    }
  }

  getReconciliationCurrentTotal(): number {
    return this.reconciliationCurrentTotal;
  }

  recordReconciliationDuration(durationMs: number): void {
    const rounded = Math.max(0, Math.round(durationMs));
    if (this.reconciliationDurationSamples.length >= MAX_DURATION_SAMPLES) {
      this.reconciliationDurationSamples.shift();
    }
    this.reconciliationDurationSamples.push(rounded);

    if (this.cacheService) {
      const key = `${REDIS_LATENCY_PREFIX}reconciliation_duration_ms`;
      Promise.all([
        this.cacheService.lpush(key, String(rounded)),
        this.cacheService.ltrim(key, 0, MAX_DURATION_SAMPLES - 1),
      ]).catch((err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to sync reconciliation duration sample to cache: ${errMsg}`);
      });
    }
  }

  getReconciliationDurations(): number[] {
    return [...this.reconciliationDurationSamples];
  }

  getReconciliationDurationStats(): ProjectionDurationStats {
    return this.computeDurationStats(this.reconciliationDurationSamples);
  }

  incrementFailureTotal(
    errorType: ProjectionErrorType | string,
    amount = 1,
  ): void {
    const sanitized = this.sanitizeErrorType(errorType);
    const current = this.failureCounters.get(sanitized) ?? 0;
    this.failureCounters.set(sanitized, current + amount);

    if (this.cacheService) {
      this.cacheService
        .incrby(`${REDIS_COUNTER_PREFIX}failure:${sanitized}`, amount)
        .catch((err: unknown) => {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.logger.warn(`Failed to sync failure counter to cache: ${errMsg}`);
        });
    }
  }

  getFailureTotal(errorType?: ProjectionErrorType | string): number {
    if (errorType) {
      const sanitized = this.sanitizeErrorType(errorType);
      return this.failureCounters.get(sanitized) ?? 0;
    }
    let total = 0;
    for (const val of this.failureCounters.values()) {
      total += val;
    }
    return total;
  }

  async getHealthSnapshot(): Promise<BookingProjectionHealthSnapshot> {
    let dbStatus: 'up' | 'down' = 'up';
    if (this.prisma) {
      try {
        await this.prisma.$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe('SET LOCAL statement_timeout = 500');
            await tx.$queryRaw`SELECT 1`;
          },
          {
            maxWait: 500,
            timeout: 500,
          },
        );
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Database health check failed in projection metrics: ${errMsg}`);
        dbStatus = 'down';
      }
    }

    let redisStatus: 'up' | 'down' = 'up';
    if (this.cacheService) {
      try {
        redisStatus = await this.cacheService.checkHealth();
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Redis health check failed in projection metrics: ${errMsg}`);
        redisStatus = 'down';
      }
    }

    let passSuccess = this.getReconciliationPassTotal('SUCCESS');
    let passError = this.getReconciliationPassTotal('ERROR');
    let staleFound = this.reconciliationStaleFoundTotal;
    let repaired = this.reconciliationRepairedTotal;
    let failed = this.reconciliationFailedTotal;
    let skipped = this.reconciliationSkippedTotal;
    let current = this.reconciliationCurrentTotal;

    const failures: Record<string, number> = {};
    for (const [key, value] of this.failureCounters.entries()) {
      failures[key] = value;
    }

    const events: Record<string, number> = this.getAllEventTotals();

    if (this.cacheService && redisStatus === 'up') {
      try {
        const counterKeys = await this.cacheService.keys(`${REDIS_COUNTER_PREFIX}*`);
        for (const key of counterKeys) {
          const val = await this.cacheService.get(key);
          if (val === null) continue;
          const num = parseInt(val, 10) || 0;
          const subKey = key.slice(REDIS_COUNTER_PREFIX.length);

          if (subKey === 'reconciliation:pass:success') {
            passSuccess = Math.max(passSuccess, num);
          } else if (subKey === 'reconciliation:pass:error') {
            passError = Math.max(passError, num);
          } else if (subKey === 'reconciliation:stale_found') {
            staleFound = Math.max(staleFound, num);
          } else if (subKey === 'reconciliation:repaired') {
            repaired = Math.max(repaired, num);
          } else if (subKey === 'reconciliation:failed') {
            failed = Math.max(failed, num);
          } else if (subKey === 'reconciliation:skipped') {
            skipped = Math.max(skipped, num);
          } else if (subKey === 'reconciliation:current') {
            current = Math.max(current, num);
          } else if (subKey.startsWith('failure:')) {
            const errorType = subKey.slice('failure:'.length);
            failures[errorType] = Math.max(failures[errorType] ?? 0, num);
          } else if (subKey.startsWith('events:')) {
            const eventKey = subKey.slice('events:'.length);
            events[eventKey] = Math.max(events[eventKey] ?? 0, num);
          }
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to merge distributed counters from cache: ${errMsg}`);
      }
    }

    let durationStats = this.getReconciliationDurationStats();
    if (this.cacheService && redisStatus === 'up') {
      try {
        const rawSamples = await this.cacheService.lrange(
          `${REDIS_LATENCY_PREFIX}reconciliation_duration_ms`,
          0,
          -1,
        );
        if (rawSamples && rawSamples.length > 0) {
          const samples = rawSamples.map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
          if (samples.length > 0) {
            durationStats = this.computeDurationStats(samples);
          }
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to read reconciliation duration from cache: ${errMsg}`);
      }
    }

    let effectiveOutcome = this.lastPassOutcome;
    let effectiveConsecutiveErrors = this.consecutivePassErrors;
    if (this.cacheService && redisStatus === 'up') {
      try {
        const rawState = await this.cacheService.get(REDIS_LATEST_PASS_STATE_KEY);
        if (rawState) {
          const parsed = JSON.parse(rawState) as ClusterPassState;
          if (parsed && parsed.outcome) {
            effectiveOutcome = parsed.outcome;
            effectiveConsecutiveErrors = parsed.consecutiveErrors ?? 0;
          }
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to read cluster pass state from cache: ${errMsg}`);
      }
    }

    const isDegraded =
      dbStatus === 'down' ||
      redisStatus === 'down' ||
      effectiveConsecutiveErrors >= 3 ||
      effectiveOutcome === 'ERROR';

    return {
      status: isDegraded ? 'degraded' : 'ok',
      dependencies: {
        database: dbStatus,
        redis: redisStatus,
      },
      metrics: {
        reconciliation: {
          passes: {
            success: passSuccess,
            error: passError,
          },
          candidates: {
            staleFound,
            repaired,
            failed,
            skipped,
            current,
          },
          duration: durationStats,
        },
        failures,
        events,
      },
    };
  }

  resetLocal(): void {
    this.counters.clear();
    this.durationSamples.length = 0;
    this.reconciliationPassCounters.clear();
    this.reconciliationDurationSamples.length = 0;
    this.reconciliationStaleFoundTotal = 0;
    this.reconciliationRepairedTotal = 0;
    this.reconciliationFailedTotal = 0;
    this.reconciliationSkippedTotal = 0;
    this.reconciliationCurrentTotal = 0;
    this.failureCounters.clear();
    this.lastPassOutcome = undefined;
    this.consecutivePassErrors = 0;
  }

  async reset(): Promise<void> {
    this.resetLocal();
    if (this.cacheService) {
      try {
        const counterKeys = await this.cacheService.keys(`${REDIS_COUNTER_PREFIX}*`);
        const latencyKeys = await this.cacheService.keys(`${REDIS_LATENCY_PREFIX}*`);
        await Promise.all([
          ...counterKeys.map((k) => this.cacheService!.del(k)),
          ...latencyKeys.map((k) => this.cacheService!.del(k)),
          this.cacheService.del(REDIS_LATEST_PASS_STATE_KEY),
        ]);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to reset cache metrics: ${errMsg}`);
      }
    }
  }

  async resetMetrics(): Promise<void> {
    return this.reset();
  }
}
