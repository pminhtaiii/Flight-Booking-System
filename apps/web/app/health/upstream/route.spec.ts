import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { GET } from './route';

describe('apps/web/app/health/upstream/route', () => {
  const originalEnv = process.env;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
  });

  it('Cache-Control: Responses contain "Cache-Control: no-store" for both 200 and 503', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;

    const res200 = await GET();
    assert.equal(res200.headers.get('cache-control')?.includes('no-store'), true);

    globalThis.fetch = (async () => {
      throw new Error('Connection refused');
    }) as typeof fetch;

    const res503 = await GET();
    assert.equal(res503.headers.get('cache-control')?.includes('no-store'), true);
  });

  it('Success Contract: returns HTTP 200 with {"status": "ok", "upstream": "up"} when ping is ok', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;

    const res = await GET();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { status: 'ok', upstream: 'up' });
  });

  it('Failure Contract: returns HTTP 503 with {"status": "degraded", "upstream": "down"} on connection error', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;

    const res = await GET();
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.deepEqual(body, { status: 'degraded', upstream: 'down' });
  });

  it('Failure Contract: returns HTTP 503 when request times out or aborts', async () => {
    globalThis.fetch = (async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      throw abortError;
    }) as typeof fetch;

    const res = await GET();
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.deepEqual(body, { status: 'degraded', upstream: 'down' });
  });

  it('Failure Contract: returns HTTP 503 on non-200 status', async () => {
    for (const status of [404, 500, 502, 503]) {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ status: 'ok' }), {
          status,
          headers: { 'Content-Type': 'application/json' },
        })) as typeof fetch;

      const res = await GET();
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.deepEqual(body, { status: 'degraded', upstream: 'down' });
    }
  });

  it('Failure Contract: returns HTTP 503 on non-ok or invalid JSON payload', async () => {
    const invalidResponses = [
      JSON.stringify({ status: 'error' }),
      JSON.stringify({ status: 'degraded' }),
      JSON.stringify({}),
      'not-json',
      '',
    ];

    for (const payload of invalidResponses) {
      globalThis.fetch = (async () =>
        new Response(payload, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })) as typeof fetch;

      const res = await GET();
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.deepEqual(body, { status: 'degraded', upstream: 'down' });
    }
  });

  it('Private URL Resolution: resolves API_URL over NEXT_PUBLIC_API_URL and trims trailing slashes', async () => {
    let capturedUrl: string | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      capturedUrl = input.toString();
      return new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    // Both set -> API_URL takes precedence
    process.env.API_URL = 'http://private-api:9000///';
    process.env.NEXT_PUBLIC_API_URL = 'http://public-api:3000///';

    await GET();
    assert.equal(capturedUrl, 'http://private-api:9000/api/health/ping');

    // Only NEXT_PUBLIC_API_URL set
    delete process.env.API_URL;
    process.env.NEXT_PUBLIC_API_URL = 'http://public-api:3000//';

    await GET();
    assert.equal(capturedUrl, 'http://public-api:3000/api/health/ping');

    // Trailing /api or /api/ suffix is normalized without duplication
    process.env.API_URL = 'http://private-api:9000/api/';
    await GET();
    assert.equal(capturedUrl, 'http://private-api:9000/api/health/ping');

    // Neither set -> default to 'http://127.0.0.1:3001'
    delete process.env.API_URL;
    delete process.env.NEXT_PUBLIC_API_URL;

    await GET();
    assert.equal(capturedUrl, 'http://127.0.0.1:3001/api/health/ping');
  });

  it('Sanitization: response payloads never expose internal URLs, credentials, or stack traces', async () => {
    globalThis.fetch = (async () => {
      const err = new Error('Sensitive failure: http://admin:secret@internal-db:5432 failed');
      err.stack = 'Error at SecretModule (http://admin:secret@internal-db:5432)';
      throw err;
    }) as typeof fetch;

    const res = await GET();
    assert.equal(res.status, 503);
    const body = (await res.json()) as Record<string, unknown>;

    assert.deepEqual(Object.keys(body).sort(), ['status', 'upstream'].sort());
    assert.deepEqual(body, { status: 'degraded', upstream: 'down' });

    const text = JSON.stringify(body);
    assert.equal(text.includes('secret'), false);
    assert.equal(text.includes('internal-db'), false);
    assert.equal(text.includes('Error'), false);
    assert.equal(text.includes('stack'), false);
  });
});
