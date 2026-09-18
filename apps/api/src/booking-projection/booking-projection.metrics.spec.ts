import {
  BookingProjectionMetrics,
  BOOKING_PROJECTION_METRIC_NAMES,
} from './booking-projection.metrics';

describe('BookingProjectionMetrics', () => {
  let metrics: BookingProjectionMetrics;

  beforeEach(() => {
    metrics = new BookingProjectionMetrics();
  });

  describe('Metric constants', () => {
    it('defines all required metric name constants', () => {
      expect(BOOKING_PROJECTION_METRIC_NAMES.RECONCILIATION_PASS_TOTAL).toBe(
        'booking_projection_reconciliation_pass_total',
      );
      expect(BOOKING_PROJECTION_METRIC_NAMES.RECONCILIATION_STALE_FOUND_TOTAL).toBe(
        'booking_projection_reconciliation_stale_found_total',
      );
      expect(BOOKING_PROJECTION_METRIC_NAMES.RECONCILIATION_REPAIRED_TOTAL).toBe(
        'booking_projection_reconciliation_repaired_total',
      );
      expect(BOOKING_PROJECTION_METRIC_NAMES.RECONCILIATION_FAILED_TOTAL).toBe(
        'booking_projection_reconciliation_failed_total',
      );
      expect(BOOKING_PROJECTION_METRIC_NAMES.RECONCILIATION_SKIPPED_TOTAL).toBe(
        'booking_projection_reconciliation_skipped_total',
      );
      expect(BOOKING_PROJECTION_METRIC_NAMES.RECONCILIATION_CURRENT_TOTAL).toBe(
        'booking_projection_reconciliation_current_total',
      );
      expect(BOOKING_PROJECTION_METRIC_NAMES.RECONCILIATION_DURATION_MS).toBe(
        'booking_projection_reconciliation_duration_ms',
      );
      expect(BOOKING_PROJECTION_METRIC_NAMES.FAILURE_TOTAL).toBe(
        'booking_projection_failure_total',
      );
      expect(BOOKING_PROJECTION_METRIC_NAMES.EVENTS_TOTAL).toBe(
        'booking_projection_events_total',
      );
      expect(BOOKING_PROJECTION_METRIC_NAMES.DURATION_MS).toBe(
        'booking_projection_duration_ms',
      );
    });
  });

  describe('Counter: booking_projection_events_total', () => {
    it('tracks event outcomes by eventName and status', () => {
      metrics.incrementEventsTotal('booking.created', 'SUCCESS');
      metrics.incrementEventsTotal('booking.created', 'SUCCESS');
      metrics.incrementEventsTotal('booking.confirmed', 'SUCCESS');
      metrics.incrementEventsTotal('booking.failed', 'ERROR');
      metrics.incrementEventsTotal('booking.disruption.synced', 'STALE_IGNORED');

      expect(metrics.getEventsTotal('booking.created', 'SUCCESS')).toBe(2);
      expect(metrics.getEventsTotal('booking.confirmed', 'SUCCESS')).toBe(1);
      expect(metrics.getEventsTotal('booking.failed', 'ERROR')).toBe(1);
      expect(metrics.getEventsTotal('booking.disruption.synced', 'STALE_IGNORED')).toBe(1);
      expect(metrics.getEventsTotal('booking.created', 'ERROR')).toBe(0);
    });

    it('supports retrieving total count across all statuses or all events', () => {
      metrics.incrementEventsTotal('booking.created', 'SUCCESS', 3);
      metrics.incrementEventsTotal('booking.created', 'ERROR', 1);

      expect(metrics.getEventsTotal('booking.created')).toBe(4);
    });

    it('enforces safe bounded labels with NO PII, NO booking IDs, NO user IDs', () => {
      // If a dynamic or unsafe label is provided, it should be sanitized/normalized
      metrics.incrementEventsTotal('booking_id_bk_1234567890abcdef', 'SUCCESS');
      metrics.incrementEventsTotal('user_id_usr_1234567890abcdef', 'SUCCESS');
      metrics.incrementEventsTotal('traveler@example.com', 'ERROR');

      const allTotals = metrics.getAllEventTotals();
      // Ensure raw booking IDs or emails are not keys in metrics
      const keys = Object.keys(allTotals);
      for (const key of keys) {
        expect(key).not.toContain('bk_1234567890abcdef');
        expect(key).not.toContain('usr_1234567890abcdef');
        expect(key).not.toContain('traveler@example.com');
      }
    });

    it('enforces bounded storage on total distinct label pairs', () => {
      // Push 500 distinct event names
      for (let i = 0; i < 500; i++) {
        metrics.incrementEventsTotal(`booking.event_${i}`, 'SUCCESS');
      }

      const allTotals = metrics.getAllEventTotals();
      expect(Object.keys(allTotals).length).toBeLessThanOrEqual(100);
    });
  });

  describe('Latency timer: booking_projection_duration_ms', () => {
    it('records duration and tracks samples', () => {
      metrics.recordDuration(15);
      metrics.recordDuration(25);
      metrics.recordDuration(50);

      const durations = metrics.getDurations();
      expect(durations).toEqual([15, 25, 50]);

      const stats = metrics.getDurationStats();
      expect(stats.count).toBe(3);
      expect(stats.min).toBe(15);
      expect(stats.max).toBe(50);
      expect(stats.avg).toBeCloseTo(30, 0);
      expect(stats.p50).toBe(25);
    });

    it('enforces bounded storage for duration samples', () => {
      for (let i = 0; i < 2500; i++) {
        metrics.recordDuration(i % 100);
      }

      const durations = metrics.getDurations();
      expect(durations.length).toBeLessThanOrEqual(1000);
    });

    it('returns zeroes when stats computed on empty samples', () => {
      const stats = metrics.getDurationStats();
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
  });

  describe('Reset', () => {
    it('clears all counters and samples', () => {
      metrics.incrementEventsTotal('booking.created', 'SUCCESS');
      metrics.recordDuration(42);
      metrics.incrementReconciliationPassTotal('SUCCESS');
      metrics.incrementReconciliationStaleFoundTotal(5);
      metrics.incrementReconciliationRepairedTotal(3);
      metrics.incrementReconciliationFailedTotal(1);
      metrics.incrementReconciliationSkippedTotal(1);
      metrics.incrementReconciliationCurrentTotal(2);
      metrics.recordReconciliationDuration(120);
      metrics.incrementFailureTotal('HYDRATION_FAILED', 2);

      metrics.reset();

      expect(metrics.getEventsTotal('booking.created', 'SUCCESS')).toBe(0);
      expect(metrics.getDurations()).toHaveLength(0);
      expect(Object.keys(metrics.getAllEventTotals())).toHaveLength(0);
      expect(metrics.getReconciliationPassTotal()).toBe(0);
      expect(metrics.getReconciliationStaleFoundTotal()).toBe(0);
      expect(metrics.getReconciliationRepairedTotal()).toBe(0);
      expect(metrics.getReconciliationFailedTotal()).toBe(0);
      expect(metrics.getReconciliationSkippedTotal()).toBe(0);
      expect(metrics.getReconciliationCurrentTotal()).toBe(0);
      expect(metrics.getReconciliationDurations()).toHaveLength(0);
      expect(metrics.getFailureTotal()).toBe(0);
    });
  });

  describe('Reconciliation Metrics', () => {
    it('tracks reconciliation pass outcomes (SUCCESS / ERROR)', () => {
      metrics.incrementReconciliationPassTotal('SUCCESS');
      metrics.incrementReconciliationPassTotal('SUCCESS');
      metrics.incrementReconciliationPassTotal('ERROR');

      expect(metrics.getReconciliationPassTotal('SUCCESS')).toBe(2);
      expect(metrics.getReconciliationPassTotal('ERROR')).toBe(1);
      expect(metrics.getReconciliationPassTotal()).toBe(3);
    });

    it('sanitizes invalid or unsafe reconciliation pass outcomes to ERROR', () => {
      metrics.incrementReconciliationPassTotal('INVALID_OUTCOME');
      metrics.incrementReconciliationPassTotal('bk_1234567890abcdef');
      metrics.incrementReconciliationPassTotal('admin@booking.com');

      expect(metrics.getReconciliationPassTotal('SUCCESS')).toBe(0);
      expect(metrics.getReconciliationPassTotal('ERROR')).toBe(3);
      expect(metrics.getReconciliationPassTotal()).toBe(3);
    });

    it('tracks reconciliation candidate tallies correctly', () => {
      metrics.incrementReconciliationStaleFoundTotal(10);
      metrics.incrementReconciliationRepairedTotal(4);
      metrics.incrementReconciliationFailedTotal(2);
      metrics.incrementReconciliationSkippedTotal(1);
      metrics.incrementReconciliationCurrentTotal(3);

      expect(metrics.getReconciliationStaleFoundTotal()).toBe(10);
      expect(metrics.getReconciliationRepairedTotal()).toBe(4);
      expect(metrics.getReconciliationFailedTotal()).toBe(2);
      expect(metrics.getReconciliationSkippedTotal()).toBe(1);
      expect(metrics.getReconciliationCurrentTotal()).toBe(3);

      // Default increment amount is 1
      metrics.incrementReconciliationRepairedTotal();
      expect(metrics.getReconciliationRepairedTotal()).toBe(5);
    });

    it('records reconciliation durations and computes duration statistics', () => {
      metrics.recordReconciliationDuration(100);
      metrics.recordReconciliationDuration(200);
      metrics.recordReconciliationDuration(300);

      const durations = metrics.getReconciliationDurations();
      expect(durations).toEqual([100, 200, 300]);

      const stats = metrics.getReconciliationDurationStats();
      expect(stats.count).toBe(3);
      expect(stats.min).toBe(100);
      expect(stats.max).toBe(300);
      expect(stats.avg).toBe(200);
      expect(stats.p50).toBe(200);
    });

    it('enforces bounded storage for reconciliation duration samples (max 1000)', () => {
      for (let i = 0; i < 1500; i++) {
        metrics.recordReconciliationDuration(i % 50);
      }
      expect(metrics.getReconciliationDurations().length).toBeLessThanOrEqual(1000);
    });

    it('returns zeroes when reconciliation stats are computed on empty samples', () => {
      const stats = metrics.getReconciliationDurationStats();
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
  });

  describe('Failure Metrics: booking_projection_failure_total', () => {
    it('tracks failure totals across bounded error types', () => {
      metrics.incrementFailureTotal('HYDRATION_FAILED', 2);
      metrics.incrementFailureTotal('EXTRACTION_FAILED', 1);
      metrics.incrementFailureTotal('UNEXPECTED_ERROR', 1);
      metrics.incrementFailureTotal('INVALID_EVENT', 3);
      metrics.incrementFailureTotal('DATABASE_ERROR', 2);

      expect(metrics.getFailureTotal('HYDRATION_FAILED')).toBe(2);
      expect(metrics.getFailureTotal('EXTRACTION_FAILED')).toBe(1);
      expect(metrics.getFailureTotal('UNEXPECTED_ERROR')).toBe(1);
      expect(metrics.getFailureTotal('INVALID_EVENT')).toBe(3);
      expect(metrics.getFailureTotal('DATABASE_ERROR')).toBe(2);
      expect(metrics.getFailureTotal('UNKNOWN')).toBe(0);
      expect(metrics.getFailureTotal()).toBe(9);
    });

    it('sanitizes unsafe strings, booking IDs, user IDs, emails, UUIDs into UNKNOWN', () => {
      metrics.incrementFailureTotal('bk_1234567890abcdef');
      metrics.incrementFailureTotal('usr_1234567890abcdef');
      metrics.incrementFailureTotal('error@example.com');
      metrics.incrementFailureTotal('550e8400-e29b-41d4-a716-446655440000');
      metrics.incrementFailureTotal('RANDOM_ARBITRARY_EXCEPTION');

      expect(metrics.getFailureTotal('UNKNOWN')).toBe(5);
      expect(metrics.getFailureTotal('HYDRATION_FAILED')).toBe(0);
      expect(metrics.getFailureTotal()).toBe(5);
    });
  });
});

