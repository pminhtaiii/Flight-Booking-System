import { Injectable, Logger } from '@nestjs/common';

export const BOOKING_PROJECTION_METRIC_NAMES = {
  EVENTS_TOTAL: 'booking_projection_events_total',
  DURATION_MS: 'booking_projection_duration_ms',
} as const;

export type ProjectionMetricStatus = 'SUCCESS' | 'ERROR' | 'STALE_IGNORED';

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

const VALID_STATUSES: Set<string> = new Set<ProjectionMetricStatus>([
  'SUCCESS',
  'ERROR',
  'STALE_IGNORED',
]);

const MAX_COUNTER_ENTRIES = 100;
const MAX_DURATION_SAMPLES = 1000;

// Disallowed patterns in metric labels to avoid PII, booking IDs, user IDs or high cardinality
const UNSAFE_LABEL_PATTERN = /(?:@|bk_|usr_|uuid|[0-9a-f]{8}-[0-9a-f]{4}|[0-9a-f]{16})/i;
const SAFE_EVENT_NAME_PATTERN = /^booking\.[a-z0-9_.-]+$/i;

@Injectable()
export class BookingProjectionMetrics {
  private readonly logger = new Logger(BookingProjectionMetrics.name);
  private readonly counters = new Map<string, number>();
  private readonly durationSamples: number[] = [];

  private sanitizeEventName(eventName: string): string {
    if (!eventName || typeof eventName !== 'string') {
      return 'booking.unknown';
    }
    const trimmed = eventName.trim().toLowerCase();
    if (UNSAFE_LABEL_PATTERN.test(trimmed) || !SAFE_EVENT_NAME_PATTERN.test(trimmed)) {
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

  reset(): void {
    this.counters.clear();
    this.durationSamples.length = 0;
  }
}
