import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createMockServer } from './mock-server.mjs';

test('local mock serves deterministic model responses and refuses unknown supplier operations', async (t) => {
  const server = createMockServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${origin}/health`)).status, 200);
  const reply = await fetch(`${origin}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'system', content: 'Classify SAFE or UNSAFE' }] }),
  });
  assert.equal((await reply.json()).choices[0].message.content, 'SAFE');
  const payment = await fetch(`${origin}/v1/payment_intents`, { method: 'POST' });
  assert.equal(payment.status, 501);
  assert.equal((await payment.json()).error.code, 'security_stub_unsupported');
  const offers = await fetch(`${origin}/air/offer_requests`, { method: 'POST' });
  assert.deepEqual((await offers.json()).data.offers, []);
});
