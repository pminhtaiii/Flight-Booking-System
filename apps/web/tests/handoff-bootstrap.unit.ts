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
