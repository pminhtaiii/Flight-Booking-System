import assert from 'node:assert/strict';
import test from 'node:test';
import { getSafeReturnTarget } from '../lib/safeReturnTarget';

test('safeReturnTarget - rejects null, undefined, empty, or whitespace inputs', () => {
  assert.equal(getSafeReturnTarget(null), '/');
  assert.equal(getSafeReturnTarget(undefined), '/');
  assert.equal(getSafeReturnTarget(''), '/');
  assert.equal(getSafeReturnTarget('   '), '/');
  assert.equal(getSafeReturnTarget(' /dashboard'), '/');
  assert.equal(getSafeReturnTarget('/dashboard '), '/');
});

test('safeReturnTarget - rejects protocol-relative URLs', () => {
  assert.equal(getSafeReturnTarget('//evil.com'), '/');
  assert.equal(getSafeReturnTarget('//localhost'), '/');
  assert.equal(getSafeReturnTarget('///evil.com'), '/');
  assert.equal(getSafeReturnTarget('////localhost:3000'), '/');
  assert.equal(getSafeReturnTarget('//dashboard'), '/');
});

test('safeReturnTarget - rejects backslash evasion attempts', () => {
  assert.equal(getSafeReturnTarget('/\\evil.com'), '/');
  assert.equal(getSafeReturnTarget('\\\\evil.com'), '/');
  assert.equal(getSafeReturnTarget('\\evil.com'), '/');
  assert.equal(getSafeReturnTarget('/checkout\\evil.com'), '/');
  assert.equal(getSafeReturnTarget('/checkout\\..\\admin'), '/');
  assert.equal(getSafeReturnTarget('/%5cevil.com'), '/');
  assert.equal(getSafeReturnTarget('/%5Cevil.com'), '/');
  assert.equal(getSafeReturnTarget('/checkout%5cevil.com'), '/');
  assert.equal(getSafeReturnTarget('/checkout%5Cevil.com'), '/');
});

test('safeReturnTarget - rejects schemes and absolute URLs', () => {
  assert.equal(getSafeReturnTarget('javascript:alert(1)'), '/');
  assert.equal(getSafeReturnTarget('javascript:void(0)'), '/');
  assert.equal(getSafeReturnTarget('data:text/html,<script>alert(1)</script>'), '/');
  assert.equal(getSafeReturnTarget('vbscript:msgbox(1)'), '/');
  assert.equal(getSafeReturnTarget('https://evil.com'), '/');
  assert.equal(getSafeReturnTarget('http://evil.com'), '/');
  assert.equal(getSafeReturnTarget('https://evil.com/dashboard'), '/');
  assert.equal(getSafeReturnTarget('http://localhost:3000/dashboard'), '/');
  assert.equal(getSafeReturnTarget('file:///etc/passwd'), '/');
  assert.equal(getSafeReturnTarget('blob:http://evil.com/uuid'), '/');
});

test('safeReturnTarget - rejects non-allowlisted internal routes and path traversals', () => {
  assert.equal(getSafeReturnTarget('/admin'), '/');
  assert.equal(getSafeReturnTarget('/admin/users'), '/');
  assert.equal(getSafeReturnTarget('/api/profile'), '/');
  assert.equal(getSafeReturnTarget('/settings'), '/');
  assert.equal(getSafeReturnTarget('/login'), '/');
  assert.equal(getSafeReturnTarget('/profile'), '/');
  assert.equal(getSafeReturnTarget('/checkout-fake'), '/');
  assert.equal(getSafeReturnTarget('/dashboard-admin'), '/');
  assert.equal(getSafeReturnTarget('/search-hack'), '/');
  assert.equal(getSafeReturnTarget('/bookings-leak'), '/');
  assert.equal(getSafeReturnTarget('/prototype/other'), '/');
  assert.equal(getSafeReturnTarget('/dashboard/../admin'), '/');
  assert.equal(getSafeReturnTarget('/search/../../evil'), '/');
});

test('safeReturnTarget - rejects control characters', () => {
  assert.equal(getSafeReturnTarget('/dashboard\n'), '/');
  assert.equal(getSafeReturnTarget('/dashboard\r\n/settings'), '/');
  assert.equal(getSafeReturnTarget('/checkout\0'), '/');
});

test('safeReturnTarget - accepts all allowlisted paths', () => {
  assert.equal(getSafeReturnTarget('/'), '/');
  assert.equal(getSafeReturnTarget('/dashboard'), '/dashboard');
  assert.equal(getSafeReturnTarget('/dashboard/settings'), '/dashboard/settings');
  assert.equal(getSafeReturnTarget('/search'), '/search');
  assert.equal(getSafeReturnTarget('/search/results'), '/search/results');
  assert.equal(getSafeReturnTarget('/bookings'), '/bookings');
  assert.equal(getSafeReturnTarget('/bookings/bk_123'), '/bookings/bk_123');
  assert.equal(getSafeReturnTarget('/checkout'), '/checkout');
  assert.equal(getSafeReturnTarget('/checkout/passengers'), '/checkout/passengers');
  assert.equal(getSafeReturnTarget('/checkout/intent-123/review'), '/checkout/intent-123/review');
  assert.equal(getSafeReturnTarget('/checkout/intent-123/ancillaries'), '/checkout/intent-123/ancillaries');
  assert.equal(getSafeReturnTarget('/prototype/chat'), '/prototype/chat');
});

test('safeReturnTarget - preserves allowlisted query parameters and strips hash fragments', () => {
  assert.equal(
    getSafeReturnTarget('/checkout/passengers?offerId=off_test_123#passenger-1'),
    '/checkout/passengers?offerId=off_test_123',
  );
  assert.equal(
    getSafeReturnTarget('/prototype/chat?sessionId=sess_123&scenario=mock-scenario-1&autoResume=true'),
    '/prototype/chat?sessionId=sess_123&autoResume=true&scenario=mock-scenario-1',
  );
  assert.equal(
    getSafeReturnTarget('/checkout?offerId=off_valid_456&sessionId=sess_789'),
    '/checkout?offerId=off_valid_456&sessionId=sess_789',
  );
});

test('safeReturnTarget - strips all PII and unallowlisted query parameters', () => {
  const result = getSafeReturnTarget(
    '/checkout/passengers?offerId=off_12345&name=Jane%20Doe&passport=P12345678&email=jane@example.com&password=secret123&token=tok_abc&dob=1990-01-01&ssn=000-00-0000',
  );
  assert.equal(result, '/checkout/passengers?offerId=off_12345');

  assert.equal(
    getSafeReturnTarget('/prototype/chat?name=Jane%20Doe&passport=P12345'),
    '/prototype/chat',
  );
});

test('safeReturnTarget - filters malformed parameter values', () => {
  assert.equal(getSafeReturnTarget('/checkout?offerId=invalid_format'), '/checkout');
  assert.equal(getSafeReturnTarget('/checkout?offerId=off_<script>'), '/checkout');
  assert.equal(getSafeReturnTarget('/checkout?sessionId=bad%20session'), '/checkout');
  assert.equal(getSafeReturnTarget('/checkout?autoResume=false'), '/checkout');
  assert.equal(getSafeReturnTarget('/checkout?autoResume=1'), '/checkout');
  assert.equal(getSafeReturnTarget('/checkout?autoResume=yes'), '/checkout');
});

test('safeReturnTarget - honors custom fallback on rejected targets', () => {
  assert.equal(getSafeReturnTarget(null, '/dashboard'), '/dashboard');
  assert.equal(getSafeReturnTarget('//evil.com', '/dashboard'), '/dashboard');
  assert.equal(getSafeReturnTarget('/admin', '/search'), '/search');
  assert.equal(getSafeReturnTarget('javascript:alert(1)', '/bookings'), '/bookings');
});
