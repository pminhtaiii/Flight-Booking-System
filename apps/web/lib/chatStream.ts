import { getFeatureFlags } from './featureFlags';
import { createOpaqueChatId } from './chatTrace';

export interface ChatStreamOptions {
  message: string;
  sessionId?: string | null;
  token?: string | null;
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
  signal,
}: ChatStreamOptions): Promise<Response> {
  const isDirect = isDirectAgentStreamEnabled();
  const endpoint = getAgentStreamEndpoint();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Trace-Id': createOpaqueChatId(),
    'X-Correlation-Id': createOpaqueChatId(),
  };

  if (isDirect) {
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
  }

  return fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message, sessionId: sessionId || undefined }),
    signal,
  });
}
