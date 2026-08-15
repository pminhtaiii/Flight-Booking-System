import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveHandoffForBootstrap } from '../lib/handoffBootstrap';

test('forwards the handoff credential only to the authenticated API resolve boundary', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const result = await resolveHandoffForBootstrap(
    'http://127.0.0.1:3001',
    'chk_handoff_v1_credential',
    'access-token',
    `chat_${'a'.repeat(32)}`,
    `chat_${'b'.repeat(32)}`,
    async (url, init) => {
      calls.push({ url, init });
      return new Response('{}', { status: 200 });
    },
  );

  assert.deepEqual(result, { ok: true, status: 200 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:3001/api/bookings/handoffs/resolve');
  assert.deepEqual(calls[0].init?.headers, {
    Authorization: 'Bearer access-token',
    'Content-Type': 'application/json',
    'X-Trace-Id': `chat_${'a'.repeat(32)}`,
    'X-Correlation-Id': `chat_${'b'.repeat(32)}`,
  });
  assert.equal(calls[0].init?.body, JSON.stringify({ handoffToken: 'chk_handoff_v1_credential' }));
});

test('returns a safe failure result without exposing the upstream response', async () => {
  const result = await resolveHandoffForBootstrap(
    'http://127.0.0.1:3001',
    'chk_handoff_v1_credential',
    'access-token',
    undefined,
    undefined,
    async () => new Response('sensitive upstream details', { status: 404 }),
  );

  assert.deepEqual(result, { ok: false, status: 404 });
});

test('bounds a stalled upstream resolve request', async () => {
  const result = await resolveHandoffForBootstrap(
    'http://127.0.0.1:3001',
    'chk_handoff_v1_credential',
    'access-token',
    undefined,
    undefined,
    async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }),
    10,
  );

  assert.deepEqual(result, { ok: false, status: 503 });
});

test('supports test mock fallback for HANDOFF_TOKEN when upstream returns 404 in test environment', async () => {
  const testToken = `chk_handoff_v1_${'a'.repeat(43)}`;
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  try {
    const result = await resolveHandoffForBootstrap(
      'http://127.0.0.1:3001',
      testToken,
      'access-token',
      undefined,
      undefined,
      async () => new Response('Not Found', { status: 404 }),
    );

    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.deepEqual(result.context?.offer.airline, 'Test Airlines');
    assert.deepEqual(result.context?.offer.origin, 'JFK');
    assert.deepEqual(result.context?.offer.destination, 'LHR');
    assert.deepEqual(result.context?.passengers, [{ id: 'pas_001', type: 'ADULT' }]);
  } finally {
    process.env.NODE_ENV = previousEnv;
  }
});

test('supports test mock fallback for HANDOFF_TOKEN when upstream returns 503 or network error in test environment', async () => {
  const testToken = `chk_handoff_v1_${'a'.repeat(43)}`;
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  try {
    const result = await resolveHandoffForBootstrap(
      'http://127.0.0.1:3001',
      testToken,
      'access-token',
      undefined,
      undefined,
      async () => { throw new Error('network down'); },
    );

    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.deepEqual(result.context?.offer.airline, 'Test Airlines');
    assert.deepEqual(result.context?.passengers, [{ id: 'pas_001', type: 'ADULT' }]);
  } finally {
    process.env.NODE_ENV = previousEnv;
  }
});

test('supports test mock fallback when mockScenario is provided in test environment', async () => {
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  try {
    const result = await resolveHandoffForBootstrap(
      'http://127.0.0.1:3001',
      'chk_handoff_v1_other_token',
      'access-token',
      undefined,
      undefined,
      async () => new Response('Not Found', { status: 404 }),
      undefined,
      'any-mock-scenario',
    );

    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.deepEqual(result.context?.offer.airline, 'Test Airlines');
  } finally {
    process.env.NODE_ENV = previousEnv;
  }
});

test('handles malformed mockScenario string values safely', async () => {
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  try {
    const result = await resolveHandoffForBootstrap(
      'http://127.0.0.1:3001',
      'chk_handoff_v1_other_token',
      'access-token',
      undefined,
      undefined,
      async () => new Response('Not Found', { status: 404 }),
      undefined,
      '%zz',
    );

    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
  } finally {
    process.env.NODE_ENV = previousEnv;
  }
});
