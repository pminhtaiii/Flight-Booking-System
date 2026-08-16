import { Logger } from '@nestjs/common';
import * as crypto from 'crypto';

export type ChatTelemetryOperation =
  | 'intent_create'
  | 'handoff_create'
  | 'handoff_resolve'
  | 'handoff_consume'
  | 'handoff_replay'
  | 'handoff_claim_conflict'
  | 'quota_admission'
  | 'chat_message_turn';

export type ChatTelemetryContext = {
  traceId?: string | null;
  correlationId?: string | null;
};

export type ChatTelemetryEvent = {
  operation: ChatTelemetryOperation;
  metric: string;
  status: string;
  latency_ms: number;
  trace_id: string;
  correlation_id: string;
  metadata: Record<string, string | number | boolean | null>;
};

const OPAQUE_ID_PATTERN = /^chat_[a-f0-9]{32}$/;
const SAFE_VALUE_PATTERN = /^[A-Za-z0-9_.:/-]{1,64}$/;
const ALLOWED_METADATA_KEYS = new Set([
  'outcome',
  'error_class',
  'dependency',
  'retry',
  'price_changed',
]);
const FORBIDDEN_VALUE_PATTERN = /(?:https?:\/\/|bearer\s|@|message|token|offer|user|session|passenger|payment|passport|secret|authorization)/i;
const ALLOWED_STRING_VALUES: Record<string, Set<string>> = {
  status: new Set(['created', 'resolved', 'consumed', 'replayed', 'failed', 'ok', 'conflict', 'accepted', 'rejected', 'denied']),
  outcome: new Set(['created', 'resolved', 'consumed', 'already_consumed', 'idempotent_retry', 'failed', 'conflict', 'admitted', 'rejected', 'unavailable']),
  error_class: new Set(['dependency_unavailable', 'timeout', 'unknown', 'daily_quota', 'burst_limit', 'control_plane_unavailable']),
  dependency: new Set(['redis', 'nestjs', 'llm', 'control_plane']),
};
const BOOLEAN_METADATA_KEYS = new Set(['retry', 'price_changed']);

export const STANDARDIZED_METRIC_COUNTERS = {
  CHAT_MESSAGES_ACCEPTED: 'chat_messages_accepted_total',
  CHAT_MESSAGES_DENIED: 'chat_messages_denied_total',
  QUOTA_DAILY_UTILIZATION: 'quota_daily_utilization',
  HANDOFF_TOKENS_ISSUED: 'handoff_tokens_issued_total',
  HANDOFF_TOKENS_RESOLVED: 'handoff_tokens_resolved_total',
  HANDOFF_TOKENS_CONSUMED: 'handoff_tokens_consumed_total',
  HANDOFF_CLAIMS_CONFLICTED: 'handoff_claims_conflicted_total',
} as const;

export type StandardizedMetricCounter =
  (typeof STANDARDIZED_METRIC_COUNTERS)[keyof typeof STANDARDIZED_METRIC_COUNTERS];

export const STANDARDIZED_METRICS = [
  'chat_messages_accepted_total',
  'chat_messages_denied_total',
  'quota_daily_utilization',
  'handoff_tokens_issued_total',
  'handoff_tokens_resolved_total',
  'handoff_tokens_consumed_total',
  'handoff_claims_conflicted_total',
] as const;

const METRIC_BY_OPERATION: Record<ChatTelemetryOperation, string> = {
  intent_create: 'chat_intent_create_total',
  handoff_create: STANDARDIZED_METRIC_COUNTERS.HANDOFF_TOKENS_ISSUED,
  handoff_resolve: STANDARDIZED_METRIC_COUNTERS.HANDOFF_TOKENS_RESOLVED,
  handoff_consume: STANDARDIZED_METRIC_COUNTERS.HANDOFF_TOKENS_CONSUMED,
  handoff_replay: 'chat_handoff_replay_total',
  handoff_claim_conflict: STANDARDIZED_METRIC_COUNTERS.HANDOFF_CLAIMS_CONFLICTED,
  quota_admission: STANDARDIZED_METRIC_COUNTERS.QUOTA_DAILY_UTILIZATION,
  chat_message_turn: STANDARDIZED_METRIC_COUNTERS.CHAT_MESSAGES_ACCEPTED,
};

function opaqueId(candidate?: string | null): string {
  if (candidate && OPAQUE_ID_PATTERN.test(candidate)) {
    return candidate;
  }
  return `chat_${crypto.randomBytes(16).toString('hex')}`;
}

function safeScalar(
  key: string,
  value: unknown,
): string | number | boolean | null {
  const allowlistedValues = ALLOWED_STRING_VALUES[key];
  if (
    allowlistedValues
    && typeof value === 'string'
    && SAFE_VALUE_PATTERN.test(value)
    && !FORBIDDEN_VALUE_PATTERN.test(value)
    && allowlistedValues.has(value)
  ) {
    return value;
  }
  if (BOOLEAN_METADATA_KEYS.has(key) && typeof value === 'boolean') {
    return value;
  }
  throw new Error(`Chat telemetry field ${key} is not safe to emit`);
}

export function createChatTelemetryEvent(
  operation: ChatTelemetryOperation,
  status: string,
  latencyMs: number,
  context: ChatTelemetryContext = {},
  metadata: Record<string, unknown> = {},
): ChatTelemetryEvent {
  const unknownKeys = Object.keys(metadata).filter((key) => !ALLOWED_METADATA_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new Error('Chat telemetry metadata contains a non-allowlisted key');
  }

  const safeMetadata: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(metadata)) {
    safeMetadata[key] = safeScalar(key, value);
  }

  const safeStatus = safeScalar('status', status);
  if (typeof safeStatus !== 'string') {
    throw new Error('Chat telemetry status must be a string');
  }

  let metric = METRIC_BY_OPERATION[operation];
  if (operation === 'chat_message_turn') {
    metric = safeStatus === 'failed' || safeStatus === 'denied' || safeStatus === 'rejected' || safeMetadata.outcome === 'rejected'
      ? STANDARDIZED_METRIC_COUNTERS.CHAT_MESSAGES_DENIED
      : STANDARDIZED_METRIC_COUNTERS.CHAT_MESSAGES_ACCEPTED;
  } else if (operation === 'quota_admission') {
    if (safeStatus === 'failed' || safeStatus === 'rejected' || safeMetadata.outcome === 'rejected') {
      metric = STANDARDIZED_METRIC_COUNTERS.CHAT_MESSAGES_DENIED;
    } else if (safeMetadata.outcome === 'admitted' || safeStatus === 'accepted') {
      metric = STANDARDIZED_METRIC_COUNTERS.CHAT_MESSAGES_ACCEPTED;
    } else {
      metric = STANDARDIZED_METRIC_COUNTERS.QUOTA_DAILY_UTILIZATION;
    }
  }

  return {
    operation,
    metric,
    status: safeStatus,
    latency_ms: Math.max(0, Math.min(600_000, Math.round(latencyMs))),
    trace_id: opaqueId(context.traceId),
    correlation_id: opaqueId(context.correlationId),
    metadata: safeMetadata,
  };
}

export function emitChatTelemetry(
  logger: Logger,
  event: ChatTelemetryEvent,
): void {
  logger.log(JSON.stringify(event));
}

export const CHAT_HANDOFF_OBSERVABILITY_CONTRACT = {
  standardizedMetricCounters: [
    'chat_messages_accepted_total',
    'chat_messages_denied_total',
    'quota_daily_utilization',
    'handoff_tokens_issued_total',
    'handoff_tokens_resolved_total',
    'handoff_tokens_consumed_total',
    'handoff_claims_conflicted_total',
  ],
  requiredButNotEmittedByApi: [
    'redis_latency',
    'quota_daily_utilization_bucket',
    'active_streams',
    'router_disambiguations',
    'snapshot_replace',
    'snapshot_expire',
    'handoff_foreign_owner',
    'handoff_expired',
    'handoff_stale',
    'time_to_first_safe_token',
  ],
  alerts: [
    { panel: 'redis_health', condition: 'operator_configured' },
    { panel: 'quota_bypass_invariant', condition: 'operator_configured' },
    {
      panel: 'error_rate',
      condition: 'above_baseline_multiple',
      baselineMultiple: 2,
      forSeconds: 300,
    },
    { panel: 'router_malformed_output', condition: 'operator_configured' },
    { panel: 'handoff_cross_owner', condition: 'operator_configured' },
    { panel: 'token_integrity_or_privacy_corpus', condition: 'operator_configured' },
    {
      panel: 'handoff_resolve_consume_latency',
      condition: 'p95_above_ms',
      thresholdMs: 300,
    },
    { panel: 'time_to_first_safe_token', condition: 'operator_configured' },
  ],
};

