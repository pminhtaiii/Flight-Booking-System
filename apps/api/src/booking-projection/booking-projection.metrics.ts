import { Injectable, Logger } from '@nestjs/common';

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
      return;
    }

    this.counters.set(key, current + amount);
  }

  recordDuration(durationMs: number): void {
    const rounded = Math.max(0, Math.round(durationMs));
    if (this.durationSamples.length >= MAX_DURATION_SAMPLES) {
      this.durationSamples.shift();
    }
    this.durationSamples.push(rounded);
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

  getDurationStats(): ProjectionDurationStats {
    if (this.durationSamples.length === 0) {
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

    const sorted = [...this.durationSamples].sort((a, b) => a - b);
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

  incrementReconciliationPassTotal(
    outcome: ReconciliationPassOutcome | string,
    amount = 1,
  ): void {
    const sanitized = this.sanitizeReconciliationOutcome(outcome);
    const current = this.reconciliationPassCounters.get(sanitized) ?? 0;
    this.reconciliationPassCounters.set(sanitized, current + amount);
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
  }

  getReconciliationStaleFoundTotal(): number {
    return this.reconciliationStaleFoundTotal;
  }

  incrementReconciliationRepairedTotal(amount = 1): void {
    this.reconciliationRepairedTotal += amount;
  }

  getReconciliationRepairedTotal(): number {
    return this.reconciliationRepairedTotal;
  }

  incrementReconciliationFailedTotal(amount = 1): void {
    this.reconciliationFailedTotal += amount;
  }

  getReconciliationFailedTotal(): number {
    return this.reconciliationFailedTotal;
  }

  incrementReconciliationSkippedTotal(amount = 1): void {
    this.reconciliationSkippedTotal += amount;
  }

  getReconciliationSkippedTotal(): number {
    return this.reconciliationSkippedTotal;
  }

  incrementReconciliationCurrentTotal(amount = 1): void {
    this.reconciliationCurrentTotal += amount;
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
  }

  getReconciliationDurations(): number[] {
    return [...this.reconciliationDurationSamples];
  }

  getReconciliationDurationStats(): ProjectionDurationStats {
    if (this.reconciliationDurationSamples.length === 0) {
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

    const sorted = [...this.reconciliationDurationSamples].sort((a, b) => a - b);
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

  incrementFailureTotal(
    errorType: ProjectionErrorType | string,
    amount = 1,
  ): void {
    const sanitized = this.sanitizeErrorType(errorType);
    const current = this.failureCounters.get(sanitized) ?? 0;
    this.failureCounters.set(sanitized, current + amount);
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

  getHealthSnapshot(): BookingProjectionHealthSnapshot {
    const isDegraded =
      this.getFailureTotal() > 0 || this.getReconciliationPassTotal('ERROR') > 0;

    const failures: Record<string, number> = {};
    for (const [key, value] of this.failureCounters.entries()) {
      failures[key] = value;
    }

    return {
      status: isDegraded ? 'degraded' : 'ok',
      metrics: {
        reconciliation: {
          passes: {
            success: this.getReconciliationPassTotal('SUCCESS'),
            error: this.getReconciliationPassTotal('ERROR'),
          },
          candidates: {
            staleFound: this.reconciliationStaleFoundTotal,
            repaired: this.reconciliationRepairedTotal,
            failed: this.reconciliationFailedTotal,
            skipped: this.reconciliationSkippedTotal,
            current: this.reconciliationCurrentTotal,
          },
          duration: this.getReconciliationDurationStats(),
        },
        failures,
        events: this.getAllEventTotals(),
      },
    };
  }

  reset(): void {
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
  }
}
