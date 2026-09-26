import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, it, mock } from 'node:test';
import { z } from 'zod';

const testRequire = createRequire(import.meta.url);
const directory = path.dirname(fileURLToPath(import.meta.url));
function resolvePath(specifier: string): string {
  try {
    return testRequire.resolve(specifier);
  } catch {
    return require.resolve(specifier, {
      paths: [path.resolve(directory, '../../node_modules'), path.resolve(process.cwd(), 'node_modules')],
    });
  }
}

let session: unknown = null;
const getServerSession = mock.fn(async (): Promise<unknown> => session);
const nextAuthPath = resolvePath('next-auth');
const originalNextAuth = testRequire.cache[nextAuthPath];
testRequire.cache[nextAuthPath] = {
  exports: { getServerSession, default: { getServerSession } },
} as NodeModule;
const serverOnlyPath = resolvePath('server-only');
const originalServerOnly = testRequire.cache[serverOnlyPath];
testRequire.cache[serverOnlyPath] = { exports: {} } as NodeModule;

after((): void => {
  if (originalNextAuth) testRequire.cache[nextAuthPath] = originalNextAuth;
  else delete testRequire.cache[nextAuthPath];
  if (originalServerOnly) testRequire.cache[serverOnlyPath] = originalServerOnly;
  else delete testRequire.cache[serverOnlyPath];
});

const originalFetch = globalThis.fetch;
const originalDateNow = Date.now;
const originalApiUrl = process.env.API_URL;
const originalPublicApiUrl = process.env.NEXT_PUBLIC_API_URL;
afterEach((): void => {
  globalThis.fetch = originalFetch;
  Date.now = originalDateNow;
  process.env.API_URL = originalApiUrl;
  process.env.NEXT_PUBLIC_API_URL = originalPublicApiUrl;
  session = null;
  getServerSession.mock.resetCalls();
  mock.timers.reset();
});

let createBackendClient: typeof import('./backend-client.ts').createBackendClient;
let backendClient: typeof import('./backend-client.ts').backendClient;
before(async (): Promise<void> => {
  ({ createBackendClient, backendClient } = await import('./backend-client.ts'));
});

it('sends an authenticated no-store request through the injected factory and validates JSON', async (): Promise<void> => {
  let requestedUrl = '';
  let requestedInit: RequestInit | undefined;
  globalThis.fetch = mock.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requestedUrl = String(url);
    requestedInit = init;
    return new Response(JSON.stringify({ value: 'ready' }), { status: 200 });
  }) as typeof fetch;
  const client = createBackendClient({ tokenProvider: async () => 'secret', baseUrl: 'http://example.test///' });

  const result = await client.request('/api/example', z.object({ value: z.string() }));

  assert.deepEqual(result, { ok: true, data: { value: 'ready' } });
  assert.equal(requestedUrl, 'http://example.test/api/example');
  assert.equal(new Headers(requestedInit?.headers).get('Authorization'), 'Bearer secret');
  assert.equal(new Headers(requestedInit?.headers).get('Cache-Control'), 'no-store');
  assert.equal(requestedInit?.cache, 'no-store');
});

it('uses the default session token and URL precedence for each factory', async (): Promise<void> => {
  session = { accessToken: 'session-token' };
  process.env.API_URL = 'http://private.test/';
  process.env.NEXT_PUBLIC_API_URL = 'http://public.test/';
  const urls: string[] = [];
  globalThis.fetch = mock.fn(async (url: string | URL | Request): Promise<Response> => {
    urls.push(String(url));
    return Response.json({ value: 'ok' });
  }) as typeof fetch;
  const schema = z.object({ value: z.string() });
  await backendClient.request('/item', schema);
  await createBackendClient({ baseUrl: 'http://override.test/' }).request('/item', schema);
  delete process.env.API_URL;
  await createBackendClient().request('/item', schema);
  delete process.env.NEXT_PUBLIC_API_URL;
  await createBackendClient().request('/item', schema);
  assert.deepEqual(urls, [
    'http://private.test/item',
    'http://override.test/item',
    'http://public.test/item',
    'http://localhost:3001/item',
  ]);
  assert.equal(getServerSession.mock.callCount(), 4);
});

it('does not send a request without a nonblank token', async (): Promise<void> => {
  const sent = mock.fn(async (): Promise<Response> => Response.json({ value: 'unexpected' }));
  globalThis.fetch = sent as typeof fetch;
  for (const token of [null, '', '   ']) {
    const result = await createBackendClient({ tokenProvider: async () => token }).request(
      '/item', z.object({ value: z.string() }),
    );
    assert.deepEqual(result, { ok: false, kind: 'transport', cause: 'missing_token' });
  }
  assert.equal(sent.mock.callCount(), 0);
});

it('keeps the HTTP status when an error body is malformed', async (): Promise<void> => {
  globalThis.fetch = mock.fn(async (): Promise<Response> => new Response('{broken', { status: 422 })) as typeof fetch;
  const result = await createBackendClient({ tokenProvider: async () => 'token' }).request(
    '/item', z.object({ value: z.string() }),
  );
  assert.deepEqual(result, { ok: false, kind: 'http', status: 422 });
});

it('returns a safe cause for malformed successful JSON', async (): Promise<void> => {
  globalThis.fetch = mock.fn(async (): Promise<Response> => new Response('{broken', { status: 200 })) as typeof fetch;
  const result = await createBackendClient({ tokenProvider: async () => 'token' }).request(
    '/item', z.object({ value: z.string() }),
  );
  assert.deepEqual(result, { ok: false, kind: 'transport', cause: 'invalid_json' });
});

it('accepts a bodyless 2xx response in none mode without reading it', async (): Promise<void> => {
  const response = new Response(null, { status: 204 });
  const json = mock.fn(async (): Promise<unknown> => { throw new Error('body read'); });
  response.json = json;
  globalThis.fetch = mock.fn(async (): Promise<Response> => response) as typeof fetch;
  const result = await createBackendClient({ tokenProvider: async () => 'token' }).request<void>(
    '/item', z.void(), { method: 'POST', responseMode: 'none' },
  );
  assert.deepEqual(result, { ok: true, data: undefined });
  assert.equal(json.mock.callCount(), 0);
});

it('returns only the safe network cause after a rejected mutation', async (): Promise<void> => {
  globalThis.fetch = mock.fn(async (): Promise<Response> => { throw new Error('token body url PII'); }) as typeof fetch;
  const result = await createBackendClient({ tokenProvider: async () => 'token' }).request(
    '/item', z.object({ value: z.string() }), { method: 'POST', body: 'private body' },
  );
  assert.deepEqual(result, { ok: false, kind: 'transport', cause: 'network' });
});

it('retries a failed GET at most three times with 100 ms then 200 ms backoff', async (): Promise<void> => {
  const sentAt: number[] = [];
  globalThis.fetch = mock.fn(async (): Promise<Response> => {
    sentAt.push(Date.now());
    throw new Error('temporary');
  }) as typeof fetch;
  const result = await createBackendClient({ tokenProvider: async () => 'token' }).request(
    '/item', z.object({ value: z.string() }),
  );
  assert.deepEqual(result, { ok: false, kind: 'transport', cause: 'network' });
  assert.equal(sentAt.length, 3);
  assert.ok(sentAt[1] - sentAt[0] >= 90);
  assert.ok(sentAt[2] - sentAt[1] >= 190);
});

it('aborts a stalled mutation at the ten second attempt deadline', async (): Promise<void> => {
  mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  let signal: AbortSignal | undefined;
  globalThis.fetch = mock.fn(async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>(() => {});
  }) as typeof fetch;
  const pending = createBackendClient({ tokenProvider: async () => 'token' }).request(
    '/item', z.object({ value: z.string() }), { method: 'POST' },
  );
  await Promise.resolve();
  mock.timers.tick(10_000);
  assert.deepEqual(await pending, { ok: false, kind: 'transport', cause: 'timeout' });
  assert.equal(signal?.aborted, true);
});

it('recovers GET reads after gateway 502, 503, and 504 responses', async (): Promise<void> => {
  for (const status of [502, 503, 504]) {
    let calls = 0;
    globalThis.fetch = mock.fn(async (): Promise<Response> => {
      calls += 1;
      return calls < 3 ? new Response('{}', { status }) : Response.json({ value: 'ok' });
    }) as typeof fetch;
    const result = await createBackendClient({ tokenProvider: async () => 'token' }).request(
      '/item', z.object({ value: z.string() }),
    );
    assert.deepEqual(result, { ok: true, data: { value: 'ok' } });
    assert.equal(calls, 3);
  }
});

it('does not retry deterministic HTTP statuses or 429 without a valid Retry-After', async (): Promise<void> => {
  for (const status of [400, 401, 403, 404, 409, 422, 500]) {
    const sent = mock.fn(async (): Promise<Response> => Response.json({ message: 'error' }, { status }));
    globalThis.fetch = sent as typeof fetch;
    const result = await createBackendClient({ tokenProvider: async () => 'token' }).request(
      '/item', z.object({ value: z.string() }),
    );
    assert.deepEqual(result, { ok: false, kind: 'http', status, body: { message: 'error' } });
    assert.equal(sent.mock.callCount(), 1);
  }
  for (const header of [null, 'nonsense', '-1']) {
    const sent = mock.fn(async (): Promise<Response> =>
      new Response('{}', { status: 429, headers: header ? { 'Retry-After': header } : {} }));
    globalThis.fetch = sent as typeof fetch;
    const result = await createBackendClient({ tokenProvider: async () => 'token' }).request(
      '/item', z.object({ value: z.string() }),
    );
    assert.deepEqual(result, { ok: false, kind: 'http', status: 429, body: {} });
    assert.equal(sent.mock.callCount(), 1);
  }
});

it('never replays POST, PUT, PATCH, or DELETE on retryable HTTP or network failures', async (): Promise<void> => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const failure of ['network', 'gateway', 'rate-limit']) {
      const sent = mock.fn(async (): Promise<Response> => {
        if (failure === 'network') throw new Error('temporary');
        return new Response('{}', {
          status: failure === 'gateway' ? 503 : 429,
          headers: failure === 'rate-limit' ? { 'Retry-After': '1' } : {},
        });
      });
      globalThis.fetch = sent as typeof fetch;
      const result = await createBackendClient({ tokenProvider: async () => 'token' }).request(
        '/item', z.object({ value: z.string() }), { method },
      );
      assert.equal(result.ok, false);
      assert.equal(sent.mock.callCount(), 1, `${method} ${failure}`);
    }
  }
});

it('honors delta-seconds Retry-After before retrying a GET', async (): Promise<void> => {
  const sentAt: number[] = [];
  globalThis.fetch = mock.fn(async (): Promise<Response> => {
    sentAt.push(Date.now());
    return sentAt.length === 1
      ? new Response('{}', { status: 429, headers: { 'Retry-After': '0.2' } })
      : Response.json({ value: 'ok' });
  }) as typeof fetch;
  const result = await createBackendClient({ tokenProvider: async () => 'token' }).request(
    '/item', z.object({ value: z.string() }),
  );
  assert.deepEqual(result, { ok: true, data: { value: 'ok' } });
  assert.ok(sentAt[1] - sentAt[0] >= 190);
});

it('honors an HTTP-date Retry-After and refuses a delay beyond the total deadline', async (): Promise<void> => {
  const date = new Date(Date.now() + 2_000).toUTCString();
  const sentAt: number[] = [];
  globalThis.fetch = mock.fn(async (): Promise<Response> => {
    sentAt.push(Date.now());
    return sentAt.length === 1
      ? new Response('{}', { status: 429, headers: { 'Retry-After': date } })
      : Response.json({ value: 'ok' });
  }) as typeof fetch;
  const result = await createBackendClient({ tokenProvider: async () => 'token' }).request(
    '/item', z.object({ value: z.string() }),
  );
  assert.deepEqual(result, { ok: true, data: { value: 'ok' } });
  assert.ok(sentAt[1] >= Date.parse(date));

  const sent = mock.fn(async (): Promise<Response> => new Response('{}', {
    status: 429, headers: { 'Retry-After': new Date(Date.now() + 60_000).toUTCString() },
  }));
  globalThis.fetch = sent as typeof fetch;
  const farFuture = await createBackendClient({ tokenProvider: async () => 'token' }).request(
    '/item', z.object({ value: z.string() }),
  );
  assert.deepEqual(farFuture, { ok: false, kind: 'http', status: 429, body: {} });
  assert.equal(sent.mock.callCount(), 1);
});

it('does not start another GET attempt when the 31 second total budget cannot fit its wait', async (): Promise<void> => {
  const started = originalDateNow();
  const sent = mock.fn(async (): Promise<Response> => {
    Date.now = (): number => started + 30_950;
    return new Response('{}', { status: 503 });
  });
  globalThis.fetch = sent as typeof fetch;
  const result = await createBackendClient({ tokenProvider: async () => 'token' }).request(
    '/item', z.object({ value: z.string() }),
  );
  assert.deepEqual(result, { ok: false, kind: 'http', status: 503, body: {} });
  assert.equal(sent.mock.callCount(), 1);
});

it('retries timed-out GETs and keeps each attempt to ten seconds', async (): Promise<void> => {
  mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const signals: AbortSignal[] = [];
  globalThis.fetch = mock.fn(async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (init?.signal) signals.push(init.signal);
    return signals.length < 3 ? new Promise<Response>(() => {}) : Response.json({ value: 'ok' });
  }) as typeof fetch;
  const pending = createBackendClient({ tokenProvider: async () => 'token' }).request(
    '/item', z.object({ value: z.string() }),
  );
  await Promise.resolve();
  mock.timers.tick(10_000);
  await Promise.resolve();
  await Promise.resolve();
  mock.timers.tick(100);
  await Promise.resolve();
  await Promise.resolve();
  mock.timers.tick(10_000);
  await Promise.resolve();
  await Promise.resolve();
  mock.timers.tick(200);
  assert.deepEqual(await pending, { ok: true, data: { value: 'ok' } });
  assert.equal(signals.length, 3);
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, true);
});

it('logs bounded transport diagnostics without tokens, paths, bodies, or exception text', async (): Promise<void> => {
  const warning = mock.method(console, 'warn', (): void => {});
  try {
    globalThis.fetch = mock.fn(async (): Promise<Response> => Response.json({ secret: 'passenger@example.test' })) as typeof fetch;
    const result = await createBackendClient({ tokenProvider: async () => 'bearer-secret' }).request(
      '/private-passenger-path', z.object({ value: z.string() }), { method: 'POST', body: 'request-secret' },
    );
    assert.deepEqual(result, { ok: false, kind: 'transport', cause: 'invalid_payload' });
    const output = JSON.stringify(warning.mock.calls.map((call) => call.arguments));
    assert.match(output, /invalid_payload/);
    for (const secret of ['bearer-secret', 'private-passenger-path', 'passenger@example.test', 'request-secret']) {
      assert.equal(output.includes(secret), false);
    }
  } finally {
    warning.mock.restore();
  }
});

it('bounds a stalled successful response body by the same ten second attempt deadline', async (): Promise<void> => {
  mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const response = Response.json({ value: 'unused' });
  response.json = async (): Promise<unknown> => new Promise<unknown>(() => {});
  globalThis.fetch = mock.fn(async (): Promise<Response> => response) as typeof fetch;
  const pending = createBackendClient({ tokenProvider: async () => 'token' }).request(
    '/item', z.object({ value: z.string() }), { method: 'POST' },
  );
  for (let step = 0; step < 5; step += 1) await Promise.resolve();
  mock.timers.tick(10_000);
  for (let step = 0; step < 5; step += 1) await Promise.resolve();
  const result = await Promise.race([pending, Promise.resolve('pending')]);
  assert.deepEqual(result, { ok: false, kind: 'transport', cause: 'timeout' });
});
