import { Logger } from '@nestjs/common';
import * as crypto from 'crypto';

export type ChatTelemetryOperation =
  | 'intent_create'
  | 'handoff_create'
  | 'handoff_resolve'
  | 'handoff_consume'
  | 'handoff_replay';

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
  status: new Set(['created', 'resolved', 'consumed', 'replayed', 'failed', 'ok']),
  outcome: new Set(['created', 'resolved', 'consumed', 'already_consumed', 'idempotent_retry', 'failed']),
  error_class: new Set(['dependency_unavailable', 'timeout', 'unknown']),
  dependency: new Set(['redis', 'nestjs', 'llm', 'control_plane']),
};
const BOOLEAN_METADATA_KEYS = new Set(['retry', 'price_changed']);

const METRIC_BY_OPERATION: Record<ChatTelemetryOperation, string> = {
  intent_create: 'chat_intent_create_total',
  handoff_create: 'chat_handoff_create_total',
  handoff_resolve: 'chat_handoff_resolve_total',
  handoff_consume: 'chat_handoff_consume_total',
  handoff_replay: 'chat_handoff_replay_total',
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

  return {
    operation,
    metric: METRIC_BY_OPERATION[operation],
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
