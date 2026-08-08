import { getFeatureFlags } from './featureFlags';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;

export interface ChatStreamOptions {
  message: string;
  sessionId?: string | null;
  token?: string | null;
  traceId?: string | null;
  correlationId?: string | null;
  signal?: AbortSignal;
}

export function isDirectAgentStreamEnabled(): boolean {
  return (
    process.env.NEXT_PUBLIC_ENABLE_DIRECT_AGENT_STREAM === 'true' ||
    getFeatureFlags().FEATURE_FLAG_CHAT_DIRECT_STREAM
  );
}

export function getAgentStreamEndpoint(): string {
  if (isDirectAgentStreamEnabled()) {
    const baseUrl = process.env.NEXT_PUBLIC_AGENT_URL || 'http://localhost:3002';
    return `${baseUrl.replace(/\/+$/, '')}/chat/stream`;
  }
  return '/api/chat/stream';
}

function getSafeRequestId(
  candidate: string | null | undefined,
  protectedValues: ReadonlyArray<string | null | undefined>,
): string | null {
  if (!candidate || !REQUEST_ID_PATTERN.test(candidate)) {
    return null;
  }
  return protectedValues.some((value) => value === candidate) ? null : candidate;
}

export async function createChatStreamRequest({
  message,
  sessionId,
  token,
  traceId,
  correlationId,
  signal,
}: ChatStreamOptions): Promise<Response> {
  const isDirect = isDirectAgentStreamEnabled();
  const endpoint = getAgentStreamEndpoint();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (isDirect) {
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    const protectedValues = [message, sessionId, token];
    const safeTraceId = getSafeRequestId(traceId, protectedValues);
    if (safeTraceId) {
      headers['X-Trace-Id'] = safeTraceId;
    }
    const safeCorrelationId = getSafeRequestId(correlationId, protectedValues);
    if (safeCorrelationId) {
      headers['X-Correlation-Id'] = safeCorrelationId;
    }
  }

  return fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message, sessionId: sessionId || undefined }),
    signal,
  });
}
