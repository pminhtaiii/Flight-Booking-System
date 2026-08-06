import { getFeatureFlags } from './featureFlags';

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
    if (traceId) {
      headers['X-Trace-Id'] = traceId;
    }
    const corrId = correlationId || sessionId;
    if (corrId) {
      headers['X-Correlation-Id'] = corrId;
    }
  }

  return fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message, sessionId: sessionId || undefined }),
    signal,
  });
}
