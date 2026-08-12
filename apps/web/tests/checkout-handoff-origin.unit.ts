import assert from 'node:assert/strict';
import test from 'node:test';
import { isSameOrigin } from '../lib/checkoutHandoffOrigin';

test('accepts an exact checkout bootstrap origin', () => {
  assert.equal(
    isSameOrigin('http://127.0.0.1:3000/checkout/handoff', 'http://127.0.0.1:3000/search'),
    true,
  );
});

test('rejects loopback aliases, foreign hosts, schemes, and ports', () => {
  const requestUrl = 'http://localhost:3000/checkout/handoff';

  for (const candidate of [
    'http://127.0.0.1:3000/search',
    'http://localhost.evil:3000/search',
    'https://localhost:3000/search',
    'http://localhost:4444/search',
  ]) {
    assert.equal(isSameOrigin(requestUrl, candidate), false, candidate);
  }
});

test('rejects malformed origin values', () => {
  assert.equal(isSameOrigin('http://localhost:3000/checkout/handoff', 'not a URL'), false);
});
