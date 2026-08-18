import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

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
  metrics: Record<string, number>;
  latency: Record<string, LatencyPercentiles>;
  featureFlags: {
    bookingReadiness: boolean;
  };
}

@Injectable()
export class BookingReadinessMetricsService {
  private readonly counters: Map<string, number> = new Map();
  private readonly latencySamples: Map<string, number[]> = new Map();
  private readonly maxSamples = 2000;

  constructor(@Optional() private readonly configService?: ConfigService) {
    this.resetMetrics();
  }

  resetMetrics(): void {
    this.counters.clear();
    for (const metric of STANDARDIZED_READINESS_METRICS) {
      this.counters.set(metric, 0);
    }
    this.latencySamples.clear();
  }

  increment(metric: BookingReadinessMetricCounter | string, amount = 1): void {
    const current = this.counters.get(metric) ?? 0;
    this.counters.set(metric, current + amount);
  }

  getMetric(metric: BookingReadinessMetricCounter | string): number {
    return this.counters.get(metric) ?? 0;
  }

  recordLatency(operation: string, latencyMs: number): void {
    if (!this.latencySamples.has(operation)) {
      this.latencySamples.set(operation, []);
    }
    const samples = this.latencySamples.get(operation)!;
    if (samples.length >= this.maxSamples) {
      samples.shift();
    }
    samples.push(Math.max(0, Math.round(latencyMs)));
  }

  private calculatePercentile(sorted: number[], percentile: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
  }

  getLatencyPercentiles(operation: string): LatencyPercentiles {
    const raw = this.latencySamples.get(operation) ?? [];
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

  getHealthSnapshot(): BookingReadinessHealthSnapshot {
    const metrics: Record<string, number> = {};
    for (const metric of STANDARDIZED_READINESS_METRICS) {
      metrics[metric] = this.counters.get(metric) ?? 0;
    }
    for (const [key, value] of this.counters.entries()) {
      metrics[key] = value;
    }

    const latency: Record<string, LatencyPercentiles> = {};
    for (const operation of this.latencySamples.keys()) {
      latency[operation] = this.getLatencyPercentiles(operation);
    }

    const flagVal =
      this.configService?.get<string>('FEATURE_FLAG_BOOKING_READINESS') ??
      process.env.FEATURE_FLAG_BOOKING_READINESS;
    const bookingReadiness = flagVal === 'true';

    return {
      status: 'ok',
      metrics,
      latency,
      featureFlags: {
        bookingReadiness,
      },
    };
  }
}
