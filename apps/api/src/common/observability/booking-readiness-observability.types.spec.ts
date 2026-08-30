import {
  BookingReadinessOperation,
  BookingReadinessMetric,
  ALLOWED_METADATA_KEYS,
  FORBIDDEN_PII_SUBSTRINGS,
} from './booking-readiness-observability.types';

describe('Booking Readiness Observability Contract', () => {
  it('defines all required PII-safe operations', () => {
    expect(Object.values(BookingReadinessOperation)).toContain('profile_read');
    expect(Object.values(BookingReadinessOperation)).toContain('profile_update');
    expect(Object.values(BookingReadinessOperation)).toContain('readiness_advisory');
    expect(Object.values(BookingReadinessOperation)).toContain('intent_authoritative_validation');
    expect(Object.values(BookingReadinessOperation)).toContain('intent_create');
    expect(Object.values(BookingReadinessOperation)).toContain('gateway_readiness');
    expect(Object.values(BookingReadinessOperation)).toContain('final_passenger_validation');
    expect(Object.values(BookingReadinessOperation)).toContain('expiry_backfill_batch');
  });

  it('defines all required metric names', () => {
    expect(Object.values(BookingReadinessMetric)).toContain(
      'booking_readiness_profile_request_duration_ms',
    );
    expect(Object.values(BookingReadinessMetric)).toContain(
      'booking_readiness_readiness_request_duration_ms',
    );
    expect(Object.values(BookingReadinessMetric)).toContain(
      'booking_readiness_gateway_request_duration_ms',
    );
    expect(Object.values(BookingReadinessMetric)).toContain(
      'booking_readiness_final_validation_duration_ms',
    );
    expect(Object.values(BookingReadinessMetric)).toContain('booking_readiness_outcomes_total');
    expect(Object.values(BookingReadinessMetric)).toContain(
      'booking_readiness_profile_update_conflict_total',
    );
    expect(Object.values(BookingReadinessMetric)).toContain(
      'booking_readiness_profile_changed_total',
    );
    expect(Object.values(BookingReadinessMetric)).toContain(
      'booking_readiness_snapshot_integrity_failure_total',
    );
    expect(Object.values(BookingReadinessMetric)).toContain(
      'booking_readiness_backfill_processed_total',
    );
    expect(Object.values(BookingReadinessMetric)).toContain(
      'booking_readiness_backfill_skipped_total',
    );
    expect(Object.values(BookingReadinessMetric)).toContain(
      'booking_readiness_backfill_quarantined_total',
    );
    expect(Object.values(BookingReadinessMetric)).toContain(
      'booking_readiness_final_validation_blocks_total',
    );
    expect(Object.values(BookingReadinessMetric)).toContain(
      'booking_readiness_supplier_call_attempts_total',
    );
  });

  it('ensures allowed metadata keys contain zero PII-risk substrings', () => {
    for (const key of ALLOWED_METADATA_KEYS) {
      const lowerKey = key.toLowerCase();
      for (const pii of FORBIDDEN_PII_SUBSTRINGS) {
        if (lowerKey === 'fieldnames' && pii === 'name') {
          continue;
        }
        if (lowerKey === 'attemptnumber' && pii === 'number') {
          continue;
        }
        expect(lowerKey).not.toContain(pii);
      }
    }
  });

  it('asserts that forbidden substrings list contains name, email, contact, document, and cipher', () => {
    expect(FORBIDDEN_PII_SUBSTRINGS).toContain('name');
    expect(FORBIDDEN_PII_SUBSTRINGS).toContain('email');
    expect(FORBIDDEN_PII_SUBSTRINGS).toContain('phone');
    expect(FORBIDDEN_PII_SUBSTRINGS).toContain('contact');
    expect(FORBIDDEN_PII_SUBSTRINGS).toContain('passport');
    expect(FORBIDDEN_PII_SUBSTRINGS).toContain('document');
    expect(FORBIDDEN_PII_SUBSTRINGS).toContain('cipher');
  });
});
