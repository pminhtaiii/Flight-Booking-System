import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createTransport } from '../../scripts/security/dast-transport.mjs';

async function server(t, handler) {
  const instance = http.createServer(handler);
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => { instance.closeAllConnections(); instance.close(); });
  return `http://127.0.0.1:${instance.address().port}`;
}

test('permits explicitly scoped localhost requests and returns text', async (t) => {
  const origin = await server(t, (_request, response) => response.end('{"ok":true}'));
  const local = origin.replace('127.0.0.1', 'localhost');
  const transport = createTransport({ origins: [local] });
  t.after(() => transport.close());
  assert.deepEqual(await transport.request(`${local}/ready`), { status: 200, body: '{"ok":true}' });
  assert.equal(transport.requests, 1);
});

test('refuses unsafe origins, credentials, and unscoped destinations before network', async (t) => {
  let calls = 0;
  const origin = await server(t, (_request, response) => { calls += 1; response.end(); });
  for (const unsafe of ['https://localhost', 'http://example.com', 'http://user:secret@localhost', 'http://127.1']) {
    assert.throws(() => createTransport({ origins: [unsafe] }), /DAST destination refused/);
  }
  const transport = createTransport({ origins: [origin] });
  t.after(() => transport.close());
  for (const unsafe of [`${origin.replace('http://', 'http://user:secret@')}/`, 'http://example.com', 'http://127.0.0.1:1']) {
    await assert.rejects(transport.request(unsafe), /DAST destination refused/);
  }
  assert.equal(calls, 0);
  assert.equal(transport.requests, 0);
});

test('rejects redirects without contacting even another allowed origin', async (t) => {
  let destinationCalls = 0;
  const destination = await server(t, (_request, response) => { destinationCalls += 1; response.end(); });
  const origin = await server(t, (_request, response) => { response.writeHead(302, { location: destination }); response.end(); });
  const transport = createTransport({ origins: [origin, destination] });
  t.after(() => transport.close());
  await assert.rejects(transport.request(origin), /DAST redirect refused/);
  assert.equal(destinationCalls, 0);
  assert.equal(transport.requests, 1);
});

test('shares a hard request budget and spaces concurrent dispatches', async (t) => {
  const arrivals = [];
  const origin = await server(t, (_request, response) => { arrivals.push(performance.now()); response.end(); });
  const transport = createTransport({ origins: [origin], maxRequests: 3 });
  t.after(() => transport.close());
  await Promise.all([transport.request(`${origin}/health`), transport.request(`${origin}/auth`), transport.request(`${origin}/test`)]);
  await assert.rejects(transport.request(origin), /DAST request budget exhausted/);
  assert.equal(transport.requests, 3);
  assert.equal(arrivals.length, 3);
  assert.ok(arrivals[2] - arrivals[0] >= 390);
});

test('wall deadline aborts a stalled response body and refuses further requests', { timeout: 3000 }, async (t) => {
  const origin = await server(t, (_request, response) => { response.writeHead(200); response.write('private'); });
  const transport = createTransport({ origins: [origin], maxDurationMs: 150 });
  t.after(() => transport.close());
  await assert.rejects(transport.request(origin), /DAST time budget exhausted/);
  assert.equal(transport.remainingMs, 0);
  await assert.rejects(transport.request(origin), /DAST time budget exhausted/);
});

test('bounds response bytes and never exposes response secrets in errors', async (t) => {
  const origin = await server(t, (_request, response) => response.end('secret'.repeat(100)));
  const transport = createTransport({ origins: [origin], maxResponseBytes: 32 });
  t.after(() => transport.close());
  await assert.rejects(transport.request(origin), { message: 'DAST response too large' });
});

test('external cancellation stops pending and queued requests', async (t) => {
  let received;
  const started = new Promise((resolve) => { received = resolve; });
  const origin = await server(t, () => received());
  const controller = new AbortController();
  const transport = createTransport({ origins: [origin], signal: controller.signal });
  t.after(() => transport.close());
  const first = assert.rejects(transport.request(origin), { message: 'DAST transport closed' });
  const second = assert.rejects(transport.request(origin), { message: 'DAST transport closed' });
  await started;
  controller.abort(new Error('secret'));
  await Promise.all([first, second]);
  assert.equal(transport.requests, 1);
});

test('request options cannot override the destination or connection lookup', async (t) => {
  const origin = await server(t, (_request, response) => response.end('ok'));
  const transport = createTransport({ origins: [origin] });
  t.after(() => transport.close());
  await assert.rejects(transport.request(origin, { hostname: 'example.com' }), /DAST request options refused/);
  assert.equal(transport.requests, 0);
});
