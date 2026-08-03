import { Injectable, Logger } from '@nestjs/common';
import {
  ALLOWED_METADATA_KEYS,
  BookingReadinessOperation,
} from '../common/observability/booking-readiness-observability.types';

export type BookingReadinessObservabilityContext = {
  traceId?: string;
  correlationId?: string;
};

export type BookingReadinessObservabilityEvent = {
  status: string;
  latencyMs: number;
  metadata?: Record<string, unknown>;
  context?: BookingReadinessObservabilityContext;
  error?: boolean;
};

const ALLOWED_METADATA_KEY_SET = new Set<string>(ALLOWED_METADATA_KEYS);

function sanitizeIdentifier(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const sanitized = Array.from(value)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 31 && code !== 127;
    })
    .join('')
    .slice(0, 64);

  return sanitized || null;
}

function safeMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!metadata) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(metadata).filter(([key, value]) => {
      if (!ALLOWED_METADATA_KEY_SET.has(key)) {
        return false;
      }

      if (key === 'fieldNames') {
        return Array.isArray(value) && value.every((fieldName) => typeof fieldName === 'string');
      }

      return (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        value === null
      );
    }),
  );
}

@Injectable()
export class BookingReadinessObservability {
  private readonly logger = new Logger('BookingReadinessObservability');

  recordOutcome(event: BookingReadinessObservabilityEvent): void {
    const payload = {
      timestamp: new Date().toISOString(),
      level: event.error ? 'error' : 'warn',
      service: 'api',
      trace_id: sanitizeIdentifier(event.context?.traceId),
      correlation_id: sanitizeIdentifier(event.context?.correlationId),
      operation: BookingReadinessOperation.READINESS_ADVISORY,
      status: event.status,
      latency_ms: Math.max(0, Math.round(event.latencyMs)),
      metadata: safeMetadata(event.metadata),
    };

    const serializedPayload = JSON.stringify(payload);
    if (event.error) {
      this.logger.error('readiness_advisory', serializedPayload);
      return;
    }

    this.logger.warn('readiness_advisory', serializedPayload);
  }
}
