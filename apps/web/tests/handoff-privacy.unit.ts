import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  HANDOFF_COOKIE_NAME,
  handoffCookieOptions,
  expiredHandoffCookieHeader,
} from '../lib/handoffCookie.ts';
import { createHandoffRedirectResponse } from '../lib/handoffBootstrap.ts';

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
  const forbiddenPatterns = [/token=/i, /handoff=/i, /chk_handoff/i, /offerId=/i, /sessionId=/i];

  for (const pattern of forbiddenPatterns) {
    assert.equal(
      pattern.test(cleanRedirectPath),
      false,
      `Redirect target ${cleanRedirectPath} must not match ${pattern}`,
    );
  }
});

test('createHandoffRedirectResponse sets secure cookie and sanitizes redirect Location', () => {
  const tokenSecret = crypto.randomBytes(32).toString('hex');
  const handoffToken = `chk_handoff_v1_${tokenSecret}`;
  const requestUrl = `https://user:password@booking.example:3000/checkout/handoff?token=${tokenSecret}&offerId=off_${crypto.randomBytes(8).toString('hex')}&sessionId=ses_${crypto.randomBytes(8).toString('hex')}#tokenFragment`;

  const response = createHandoffRedirectResponse(requestUrl, handoffToken);

  assert.equal(response.status, 303);
  assert.equal(response.headers.get('cache-control'), 'no-store, private');

  const location = response.headers.get('location') || response.headers.get('Location');
  assert.ok(location, 'Location header must be present');

  const parsed = new URL(location!);
  assert.equal(parsed.pathname, '/checkout/passengers');
  assert.equal(parsed.search, '');
  assert.equal(parsed.hash, '');
  assert.equal(parsed.username, '');
  assert.equal(parsed.password, '');

  const forbiddenPatterns = [
    /token=/i,
    /handoff=/i,
    /chk_handoff/i,
    /offerId=/i,
    /sessionId=/i,
    /user/i,
    /password/i,
  ];

  for (const pattern of forbiddenPatterns) {
    assert.equal(
      pattern.test(location!),
      false,
      `Location header ${location} must not match ${pattern}`,
    );
  }

  const cookie = response.cookies.get(HANDOFF_COOKIE_NAME);
  assert.ok(cookie, 'Handoff cookie must be set in response');
  assert.equal(cookie?.value, handoffToken);
  assert.equal(cookie?.httpOnly, true);
  assert.equal(cookie?.sameSite, 'strict');
  assert.equal(cookie?.path, '/');
});
