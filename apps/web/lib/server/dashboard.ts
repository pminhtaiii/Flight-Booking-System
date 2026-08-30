import 'server-only';
import * as NextAuth from 'next-auth';
import { DashboardSummarySchema, type DashboardOutcome } from '@shared/types/dashboard.types';
import { authOptions } from '@/lib/auth';

const REQUEST_TIMEOUT_MS = 10_000;

export async function getDashboardSummary(): Promise<DashboardOutcome> {
  const token = await getAccessToken();
  if (!token) {
    return failure('UNAUTHENTICATED', 'Authentication required. Please log in.', false);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${apiUrl()}/api/dashboard/summary`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal: controller.signal,
    });

    if (response.status === 401) {
      return failure('UNAUTHENTICATED', 'Your session has expired. Please sign in again.', false);
    }
    if (response.status === 403) {
      return failure('FORBIDDEN', 'Access denied. You do not have permission to view this resource.', false);
    }
    if (!response.ok) {
      return failure('UPSTREAM_UNAVAILABLE', 'The dashboard service is temporarily unavailable. Please try again.', true);
    }

    try {
      const parsed = DashboardSummarySchema.safeParse(await response.json());
      return parsed.success
        ? { ok: true, data: parsed.data }
        : failure('INVALID_RESPONSE', 'Unable to load dashboard data due to an unexpected format.', false);
    } catch {
      return failure('INVALID_RESPONSE', 'Unable to load dashboard data due to an unexpected format.', false);
    }
  } catch {
    return failure('UPSTREAM_UNAVAILABLE', 'Connection timed out. Please check your network and try again.', true);
  } finally {
    clearTimeout(timeout);
  }
}

async function getAccessToken(): Promise<string | null> {
  try {
    const sessionFn =
      typeof NextAuth.getServerSession === 'function'
        ? NextAuth.getServerSession
        : (NextAuth as unknown as { default?: { getServerSession: typeof NextAuth.getServerSession } }).default
            ?.getServerSession;
    const session: unknown = await sessionFn?.(authOptions);
    if (!session || typeof session !== 'object' || !('accessToken' in session)) return null;

    const token = (session as { accessToken?: unknown }).accessToken;
    return typeof token === 'string' && token.trim().length > 0 ? token : null;
  } catch {
    return null;
  }
}

function apiUrl(): string {
  const configuredUrl = process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
  return configuredUrl.replace(/\/+$/, '');
}

function failure(
  reason: Extract<DashboardOutcome, { ok: false }>['reason'],
  message: string,
  retryable: boolean,
): DashboardOutcome {
  return { ok: false, reason, message, retryable };
}
