import assert from 'node:assert/strict';
import test from 'node:test';
import {
  handoffCookieOptions,
  expiredHandoffCookieHeader,
} from '../lib/handoffCookie.ts';

test('clears the handoff credential using the same cookie scope that stored it', () => {
  const storedCookie = handoffCookieOptions();
  const clearedCookie = expiredHandoffCookieHeader();

  assert.equal(storedCookie.path, '/');
  assert.match(clearedCookie, /(?:^|; )Path=\/(?:;|$)/);
  assert.match(clearedCookie, /(?:^|; )Max-Age=0(?:;|$)/);
  assert.match(clearedCookie, /(?:^|; )HttpOnly(?:;|$)/);
  assert.match(clearedCookie, /(?:^|; )Secure(?:;|$)/);
  assert.match(clearedCookie, /(?:^|; )SameSite=Strict(?:;|$)/);
});
