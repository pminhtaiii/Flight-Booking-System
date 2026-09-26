import 'server-only';
import { DashboardSummarySchema, type DashboardOutcome } from '@shared/types/dashboard.types';
import { backendClient } from './backend-client';

export async function getDashboardSummary(): Promise<DashboardOutcome> {
  const result = await backendClient.request('/api/dashboard/summary', DashboardSummarySchema);

  if (result.ok) {
    return { ok: true, data: result.data };
  }

  if (result.kind === 'http') {
    if (result.status === 401) {
      return failure('UNAUTHENTICATED', 'Your session has expired. Please sign in again.', false);
    }
    if (result.status === 403) {
      return failure(
        'FORBIDDEN',
        'Access denied. You do not have permission to view this resource.',
        false,
      );
    }
    return failure(
      'UPSTREAM_UNAVAILABLE',
      'The dashboard service is temporarily unavailable. Please try again.',
      true,
    );
  }

  if (result.cause === 'missing_token') {
    return failure('UNAUTHENTICATED', 'Authentication required. Please log in.', false);
  }
  if (result.cause === 'invalid_json' || result.cause === 'invalid_payload') {
    return failure(
      'INVALID_RESPONSE',
      'Unable to load dashboard data due to an unexpected format.',
      false,
    );
  }
  if (result.cause === 'timeout' || result.cause === 'network') {
    return failure(
      'UPSTREAM_UNAVAILABLE',
      'Connection timed out. Please check your network and try again.',
      true,
    );
  }
  return failure(
    'UPSTREAM_UNAVAILABLE',
    'The dashboard service is temporarily unavailable. Please try again.',
    true,
  );
}

function failure(
  reason: Extract<DashboardOutcome, { ok: false }>['reason'],
  message: string,
  retryable: boolean,
): DashboardOutcome {
  return { ok: false, reason, message, retryable };
}

