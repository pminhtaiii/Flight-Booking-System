import { isOpaqueChatId } from './chatTrace';

export type HandoffBootstrapResult = {
  ok: boolean;
  status: number;
};

type BootstrapFetcher = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export const HANDOFF_BOOTSTRAP_TIMEOUT_MS = 10_000;

export async function resolveHandoffForBootstrap(
  apiUrl: string,
  handoffToken: string,
  accessToken: string,
  traceId: string | undefined,
  correlationId: string | undefined,
  fetcher: BootstrapFetcher = fetch,
  timeoutMs = HANDOFF_BOOTSTRAP_TIMEOUT_MS,
): Promise<HandoffBootstrapResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  if (isOpaqueChatId(traceId)) {
    headers['X-Trace-Id'] = traceId;
  }
  if (isOpaqueChatId(correlationId)) {
    headers['X-Correlation-Id'] = correlationId;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetcher(
      new URL('/api/bookings/handoffs/resolve', apiUrl).toString(),
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ handoffToken }),
        cache: 'no-store',
        signal: controller.signal,
      },
    );

    return { ok: response.ok, status: response.status };
  } catch {
    return { ok: false, status: 503 };
  } finally {
    clearTimeout(timeout);
  }
}
