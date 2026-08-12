import assert from 'node:assert/strict';
import test from 'node:test';
import { readHandoffCredential } from '../lib/handoffCredential';

const HANDOFF_TOKEN = `chk_handoff_v1_${'a'.repeat(43)}`;

test('reads the strict handoff credential from the browser urlencoded form', async () => {
  const request = new Request('http://127.0.0.1:3000/checkout/handoff', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: new URLSearchParams({ handoffToken: HANDOFF_TOKEN }),
  });

  assert.equal(await readHandoffCredential(request), HANDOFF_TOKEN);
});

test('rejects extra fields, invalid media, and non-contract credentials', async () => {
  const extraFieldRequest = new Request('http://127.0.0.1:3000/checkout/handoff', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ handoffToken: HANDOFF_TOKEN, extra: 'nope' }),
  });
  const invalidTokenRequest = new Request('http://127.0.0.1:3000/checkout/handoff', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ handoffToken: `chk_handoff_v1_${'a'.repeat(42)}` }),
  });
  const jsonRequest = new Request('http://127.0.0.1:3000/checkout/handoff', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handoffToken: HANDOFF_TOKEN }),
  });

  assert.equal(await readHandoffCredential(extraFieldRequest), null);
  assert.equal(await readHandoffCredential(invalidTokenRequest), null);
  assert.equal(await readHandoffCredential(jsonRequest), null);
});
