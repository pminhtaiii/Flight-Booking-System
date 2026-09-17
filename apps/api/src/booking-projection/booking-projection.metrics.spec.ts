import { BookingProjectionMetrics } from './booking-projection.metrics';

describe('BookingProjectionMetrics', () => {
  let metrics: BookingProjectionMetrics;

  beforeEach(() => {
    metrics = new BookingProjectionMetrics();
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

      metrics.reset();

      expect(metrics.getEventsTotal('booking.created', 'SUCCESS')).toBe(0);
      expect(metrics.getDurations()).toHaveLength(0);
      expect(Object.keys(metrics.getAllEventTotals())).toHaveLength(0);
    });
  });
});
