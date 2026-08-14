import { createOpaqueChatId } from './chatTrace';

export interface ChatStreamOptions {
  message: string;
  sessionId?: string | null;
  token?: string | null;
  signal?: AbortSignal;
}

export function getAgentStreamEndpoint(): string {
  const baseUrl = process.env.NEXT_PUBLIC_AGENT_URL || 'http://localhost:3002';
  return `${baseUrl.replace(/\/+$/, '')}/chat/stream`;
}

export async function createChatStreamRequest({
  message,
  sessionId,
  token,
  signal,
}: ChatStreamOptions): Promise<Response> {
  const endpoint = getAgentStreamEndpoint();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Trace-Id': createOpaqueChatId(),
    'X-Correlation-Id': createOpaqueChatId(),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  return fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message, sessionId: sessionId || undefined }),
    signal,
  });
}
