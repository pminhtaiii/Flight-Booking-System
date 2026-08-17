import { createOpaqueChatId } from './chatTrace';

export interface ChatStreamOptions {
  message: string;
  sessionId?: string | null;
  token?: string | null;
  signal?: AbortSignal;
}

export function getAgentStreamEndpoint(): string {
  const legacyDirectFlag = process.env.NEXT_PUBLIC_FEATURE_FLAG_CHAT_DIRECT_STREAM;
  const legacyEnableFlag = process.env.NEXT_PUBLIC_ENABLE_DIRECT_AGENT_STREAM;

  if (
    legacyDirectFlag?.trim().toLowerCase() === 'false' ||
    legacyEnableFlag?.trim().toLowerCase() === 'false'
  ) {
    throw new Error('Legacy proxy transport is decommissioned. Direct-only streaming transport is mandatory.');
  }

  const baseUrl = process.env.NEXT_PUBLIC_AGENT_URL;
  if (!baseUrl || !baseUrl.trim()) {
    throw new Error('NEXT_PUBLIC_AGENT_URL is required but not configured.');
  }
  return `${baseUrl.trim().replace(/\/+$/, '')}/chat/stream`;
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
