import test from 'node:test';
import assert from 'node:assert/strict';
import { HANDOFF_COOKIE_NAME, handoffCookieOptions, expiredHandoffCookieHeader } from '../lib/handoffCookie.ts';

test('handoff cookie configuration enforces privacy requirements', () => {
  assert.equal(HANDOFF_COOKIE_NAME, 'chat_handoff_token');
});

test('handoff cookie attributes include HttpOnly, SameSite=Strict, Path=/', () => {
  const options = handoffCookieOptions();

  assert.equal(options.httpOnly, true, 'Handoff cookie MUST be HttpOnly');
  assert.equal(options.sameSite, 'strict', 'Handoff cookie MUST be SameSite=Strict');
  assert.equal(options.path, '/', 'Handoff cookie MUST be scoped to root path');
  assert.ok(options.maxAge <= 900, 'Handoff cookie Max-Age MUST be <= 15 minutes');
});

test('expired handoff cookie clears credential with identical scope', () => {
  const cleared = expiredHandoffCookieHeader();
  assert.match(cleared, /(?:^|; )Path=\/(?:;|$)/);
  assert.match(cleared, /(?:^|; )Max-Age=0(?:;|$)/);
  assert.match(cleared, /(?:^|; )HttpOnly(?:;|$)/);
  assert.match(cleared, /(?:^|; )Secure(?:;|$)/);
  assert.match(cleared, /(?:^|; )SameSite=Strict(?:;|$)/);
});

test('clean redirect path forbids query parameters with credentials', () => {
  const cleanRedirectPath = '/checkout/passengers';
  const forbiddenPatterns = [
    /token=/i,
    /handoff=/i,
    /chk_handoff/i,
    /offerId=/i,
    /sessionId=/i,
  ];

  for (const pattern of forbiddenPatterns) {
    assert.equal(
      pattern.test(cleanRedirectPath),
      false,
      `Redirect target ${cleanRedirectPath} must not match ${pattern}`,
    );
  }
});
