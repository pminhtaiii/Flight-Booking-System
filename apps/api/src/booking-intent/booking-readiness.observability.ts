import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  ALLOWED_METADATA_KEYS,
  BookingReadinessOperation,
} from '../common/observability/booking-readiness-observability.types';
import { BookingReadinessMetricsService } from '../common/observability/booking-readiness.metrics';

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
  operation?: BookingReadinessOperation;
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

  constructor(@Optional() private readonly metricsService?: BookingReadinessMetricsService) {}

  recordOutcome(event: BookingReadinessObservabilityEvent): void {
    const operation = event.operation ?? BookingReadinessOperation.READINESS_ADVISORY;
    const latencyMs = Math.max(0, Math.round(event.latencyMs));

    if (this.metricsService) {
      this.metricsService.recordLatency(operation, latencyMs);
    }

    const payload = {
      timestamp: new Date().toISOString(),
      level: event.error ? 'error' : 'warn',
      service: 'api',
      trace_id: sanitizeIdentifier(event.context?.traceId),
      correlation_id: sanitizeIdentifier(event.context?.correlationId),
      operation,
      status: event.status,
      latency_ms: latencyMs,
      metadata: safeMetadata(event.metadata),
    };

    const serializedPayload = JSON.stringify(payload);
    if (event.error) {
      this.logger.error('readiness_advisory', serializedPayload);
      return;
    }

    if (process.env.NODE_ENV !== 'test') {
      this.logger.warn('readiness_advisory', serializedPayload);
    }
  }
}
