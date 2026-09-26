import 'server-only';
import * as NextAuth from 'next-auth';
import { type ZodType } from 'zod';
import { authOptions } from '../auth.ts';

export type TokenProvider = () => Promise<string | null>;
export type TransportResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: 'http'; status: number; body?: unknown }
  | { ok: false; kind: 'transport'; cause: 'missing_token' | 'network' | 'timeout' | 'invalid_json' | 'invalid_payload' };
export type RequestOpts = RequestInit & { responseMode?: 'json' | 'none' };
type TransportCause = Extract<TransportResult<unknown>, { kind: 'transport' }>['cause'];
const ATTEMPT_TIMEOUT_MS = 10_000;
const TOTAL_TIMEOUT_MS = 31_000;
const MAX_GET_ATTEMPTS = 3;

async function defaultTokenProvider(): Promise<string | null> {
  try {
    const sessionFn =
      typeof NextAuth.getServerSession === 'function'
        ? NextAuth.getServerSession
        : // Type assertion necessary for NextAuth ESM/CJS interop fallback where getServerSession is on default export.
          (NextAuth as unknown as { default?: { getServerSession: typeof NextAuth.getServerSession } })
            .default?.getServerSession;
    const session: unknown = await sessionFn?.(authOptions);
    if (!session || typeof session !== 'object' || !('accessToken' in session)) return null;
    const token = session.accessToken;
    return typeof token === 'string' && token.trim() ? token : null;
  } catch {
    return null;
  }
}

type JsonRaceResult = { kind: 'data'; value: unknown } | { kind: 'invalid' } | { kind: 'timeout' };

async function parseJsonWithTimeout(
  response: Response,
  timeoutPromise: Promise<{ kind: 'timeout' }>,
): Promise<JsonRaceResult> {
  return Promise.race([
    response.json().then(
      (value: unknown): JsonRaceResult => ({ kind: 'data', value }),
      (): JsonRaceResult => ({ kind: 'invalid' }),
    ),
    timeoutPromise,
  ]);
}

export function createBackendClient(config: { tokenProvider?: TokenProvider; baseUrl?: string } = {}) {
  return {
    async request<T>(path: string, schema: ZodType<T>, opts: RequestOpts = {}): Promise<TransportResult<T>> {
      const deadline = Date.now() + TOTAL_TIMEOUT_MS;
      const token = await (config.tokenProvider ?? defaultTokenProvider)();
      if (!token?.trim()) return transportFailure('missing_token');
      const baseUrl = (config.baseUrl || process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001').replace(/\/+$/, '');
      const headers = new Headers(opts.headers);
      headers.set('Authorization', `Bearer ${token}`);
      headers.set('Cache-Control', 'no-store');
      const { responseMode, ...fetchOpts } = opts;
      const isGet = (opts.method ?? 'GET').toUpperCase() === 'GET';
      const maxAttempts = isGet ? MAX_GET_ATTEMPTS : 1;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return transportFailure('timeout');
        const controller = new AbortController();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const timeoutResult = new Promise<{ kind: 'timeout' }>((resolve): void => {
          timeout = setTimeout((): void => {
            controller.abort();
            resolve({ kind: 'timeout' });
          }, Math.min(ATTEMPT_TIMEOUT_MS, remaining));
        });
        const fetchResult = fetch(`${baseUrl}${path}`, {
          ...fetchOpts, headers, cache: 'no-store', signal: controller.signal,
        }).then(
          (response): { kind: 'response'; response: Response } => ({ kind: 'response', response }),
          (): { kind: 'network' } => ({ kind: 'network' }),
        );
        const outcome = await Promise.race([fetchResult, timeoutResult]);

        if (outcome.kind !== 'response') {
          clearTimeout(timeout);
          const cause = outcome.kind === 'timeout' ? 'timeout' : 'network';
          if (attempt === maxAttempts - 1 || !await waitWithinDeadline(100 * 2 ** attempt, deadline)) return transportFailure(cause);
          continue;
        }
        const response = outcome.response;
        if (!response.ok) {
          const retryDelay = retryDelayMs(response, attempt, maxAttempts);
          if (retryDelay !== null && retryDelay < deadline - Date.now()) {
            clearTimeout(timeout);
            if (await waitWithinDeadline(retryDelay, deadline)) continue;
            return { ok: false, kind: 'http', status: response.status };
          }
          const body = await parseJsonWithTimeout(response, timeoutResult);
          clearTimeout(timeout);
          return body.kind === 'data'
            ? { ok: false, kind: 'http', status: response.status, body: body.value }
            : { ok: false, kind: 'http', status: response.status };
        }
        if (responseMode === 'none') {
          clearTimeout(timeout);
          // Type assertion necessary: responseMode 'none' callers use request<void> with z.void().
          return { ok: true, data: undefined as T };
        }
        const body = await parseJsonWithTimeout(response, timeoutResult);
        clearTimeout(timeout);
        if (body.kind === 'timeout') return transportFailure('timeout');
        if (body.kind === 'invalid') return transportFailure('invalid_json');
        const parsed = schema.safeParse(body.value);
        return parsed.success ? { ok: true, data: parsed.data } : transportFailure('invalid_payload');
      }
      return transportFailure('timeout');
    },
  };
}

function transportFailure<T>(cause: TransportCause): TransportResult<T> {
  // Diagnostic values are fixed categories; never include request or response data.
  // eslint-disable-next-line no-console
  console.warn('backend_client transport failure', { cause });
  return { ok: false, kind: 'transport', cause };
}

function retryDelayMs(response: Response, attempt: number, maxAttempts: number): number | null {
  if (attempt >= maxAttempts - 1) return null;
  const backoff = 100 * 2 ** attempt;
  if ([502, 503, 504].includes(response.status)) return backoff;
  if (response.status !== 429) return null;
  const header = response.headers.get('Retry-After');
  if (!header) return null;
  const delta = /^\d+(?:\.\d+)?$/.test(header.trim()) ? Number(header.trim()) * 1000 : NaN;
  const wait = Number.isFinite(delta) ? delta : Date.parse(header) - Date.now();
  return Number.isFinite(wait) && wait >= 0 ? Math.max(backoff, wait) : null;
}

async function waitWithinDeadline(delayMs: number, deadline: number): Promise<boolean> {
  if (delayMs >= deadline - Date.now()) return false;
  await new Promise<void>((resolve): void => { setTimeout(resolve, delayMs); });
  return Date.now() < deadline;
}

export const backendClient = createBackendClient();
