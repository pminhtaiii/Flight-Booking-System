export enum BookingReadinessOperation {
  PROFILE_READ = 'profile_read',
  PROFILE_UPDATE = 'profile_update',
  READINESS_ADVISORY = 'readiness_advisory',
  INTENT_AUTHORITATIVE_VALIDATION = 'intent_authoritative_validation',
  INTENT_CREATE = 'intent_create',
  GATEWAY_READINESS = 'gateway_readiness',
  FINAL_PASSENGER_VALIDATION = 'final_passenger_validation',
  EXPIRY_BACKFILL_BATCH = 'expiry_backfill_batch',
}

export enum BookingReadinessMetric {
  PROFILE_REQUEST_DURATION = 'booking_readiness_profile_request_duration_ms',
  PROFILE_REQUEST_ERRORS = 'booking_readiness_profile_request_errors_total',
  READINESS_REQUEST_DURATION = 'booking_readiness_readiness_request_duration_ms',
  READINESS_REQUEST_ERRORS = 'booking_readiness_readiness_request_errors_total',
  GATEWAY_REQUEST_DURATION = 'booking_readiness_gateway_request_duration_ms',
  GATEWAY_REQUEST_ERRORS = 'booking_readiness_gateway_request_errors_total',
  FINAL_VALIDATION_DURATION = 'booking_readiness_final_validation_duration_ms',
  FINAL_VALIDATION_ERRORS = 'booking_readiness_final_validation_errors_total',
  
  READINESS_OUTCOMES = 'booking_readiness_outcomes_total',
  PROFILE_UPDATE_CONFLICT = 'booking_readiness_profile_update_conflict_total',
  PROFILE_CHANGED = 'booking_readiness_profile_changed_total',
  SNAPSHOT_INTEGRITY_FAILURE = 'booking_readiness_snapshot_integrity_failure_total',
  BACKFILL_PROCESSED = 'booking_readiness_backfill_processed_total',
  BACKFILL_SKIPPED = 'booking_readiness_backfill_skipped_total',
  BACKFILL_QUARANTINED = 'booking_readiness_backfill_quarantined_total',
  FINAL_VALIDATION_BLOCKS = 'booking_readiness_final_validation_blocks_total',
  SUPPLIER_CALL_ATTEMPTS = 'booking_readiness_supplier_call_attempts_total',
}

export const ALLOWED_METADATA_KEYS = [
  'scope',
  'reasonCode',
  'passengerCount',
  'fieldNames',
  'revisionConflict',
  'aggregateCount',
  'attemptNumber',
  'status',
  'latency_ms',
] as const;

export const FORBIDDEN_PII_SUBSTRINGS = [
  'name',
  'dob',
  'birth',
  'email',
  'phone',
  'contact',
  'passport',
  'document',
  'number',
  'expiry',
  'profileid',
  'cipher',
  'text',
  'secret',
  'key',
  'token',
] as const;
