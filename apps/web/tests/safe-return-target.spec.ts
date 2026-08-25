import { expect, test } from '@playwright/test';
import { getSafeReturnTarget } from '../lib/safeReturnTarget';

test.describe('getSafeReturnTarget', () => {
  test('rejects null, undefined, empty, or whitespace inputs', () => {
    expect(getSafeReturnTarget(null)).toBe('/');
    expect(getSafeReturnTarget(undefined)).toBe('/');
    expect(getSafeReturnTarget('')).toBe('/');
    expect(getSafeReturnTarget('   ')).toBe('/');
    expect(getSafeReturnTarget(' /dashboard')).toBe('/');
    expect(getSafeReturnTarget('/dashboard ')).toBe('/');
  });

  test('rejects protocol-relative URLs', () => {
    expect(getSafeReturnTarget('//evil.com')).toBe('/');
    expect(getSafeReturnTarget('//localhost')).toBe('/');
    expect(getSafeReturnTarget('///evil.com')).toBe('/');
    expect(getSafeReturnTarget('////localhost:3000')).toBe('/');
    expect(getSafeReturnTarget('//dashboard')).toBe('/');
  });

  test('rejects backslash evasion attempts', () => {
    expect(getSafeReturnTarget('/\\evil.com')).toBe('/');
    expect(getSafeReturnTarget('\\\\evil.com')).toBe('/');
    expect(getSafeReturnTarget('\\evil.com')).toBe('/');
    expect(getSafeReturnTarget('/checkout\\evil.com')).toBe('/');
    expect(getSafeReturnTarget('/checkout\\..\\admin')).toBe('/');
    expect(getSafeReturnTarget('/%5cevil.com')).toBe('/');
    expect(getSafeReturnTarget('/%5Cevil.com')).toBe('/');
    expect(getSafeReturnTarget('/checkout%5cevil.com')).toBe('/');
    expect(getSafeReturnTarget('/checkout%5Cevil.com')).toBe('/');
  });

  test('rejects schemes and absolute URLs', () => {
    expect(getSafeReturnTarget('javascript:alert(1)')).toBe('/');
    expect(getSafeReturnTarget('javascript:void(0)')).toBe('/');
    expect(getSafeReturnTarget('data:text/html,<script>alert(1)</script>')).toBe('/');
    expect(getSafeReturnTarget('vbscript:msgbox(1)')).toBe('/');
    expect(getSafeReturnTarget('https://evil.com')).toBe('/');
    expect(getSafeReturnTarget('http://evil.com')).toBe('/');
    expect(getSafeReturnTarget('https://evil.com/dashboard')).toBe('/');
    expect(getSafeReturnTarget('http://localhost:3000/dashboard')).toBe('/');
    expect(getSafeReturnTarget('file:///etc/passwd')).toBe('/');
    expect(getSafeReturnTarget('blob:http://evil.com/uuid')).toBe('/');
  });

  test('rejects non-allowlisted internal routes and path traversals', () => {
    expect(getSafeReturnTarget('/admin')).toBe('/');
    expect(getSafeReturnTarget('/admin/users')).toBe('/');
    expect(getSafeReturnTarget('/api/profile')).toBe('/');
    expect(getSafeReturnTarget('/settings')).toBe('/');
    expect(getSafeReturnTarget('/login')).toBe('/');
    expect(getSafeReturnTarget('/profile')).toBe('/');
    expect(getSafeReturnTarget('/checkout-fake')).toBe('/');
    expect(getSafeReturnTarget('/dashboard-admin')).toBe('/');
    expect(getSafeReturnTarget('/search-hack')).toBe('/');
    expect(getSafeReturnTarget('/bookings-leak')).toBe('/');
    expect(getSafeReturnTarget('/prototype/other')).toBe('/');
    expect(getSafeReturnTarget('/dashboard/../admin')).toBe('/');
    expect(getSafeReturnTarget('/search/../../evil')).toBe('/');
  });

  test('rejects control characters', () => {
    expect(getSafeReturnTarget('/dashboard\n')).toBe('/');
    expect(getSafeReturnTarget('/dashboard\r\n/settings')).toBe('/');
    expect(getSafeReturnTarget('/checkout\0')).toBe('/');
  });

  test('accepts all allowlisted paths', () => {
    expect(getSafeReturnTarget('/')).toBe('/');
    expect(getSafeReturnTarget('/dashboard')).toBe('/dashboard');
    expect(getSafeReturnTarget('/dashboard/settings')).toBe('/dashboard/settings');
    expect(getSafeReturnTarget('/search')).toBe('/search');
    expect(getSafeReturnTarget('/search/results')).toBe('/search/results');
    expect(getSafeReturnTarget('/bookings')).toBe('/bookings');
    expect(getSafeReturnTarget('/bookings/bk_123')).toBe('/bookings/bk_123');
    expect(getSafeReturnTarget('/checkout')).toBe('/checkout');
    expect(getSafeReturnTarget('/checkout/passengers')).toBe('/checkout/passengers');
    expect(getSafeReturnTarget('/checkout/intent-123/review')).toBe('/checkout/intent-123/review');
    expect(getSafeReturnTarget('/checkout/intent-123/ancillaries')).toBe('/checkout/intent-123/ancillaries');
    expect(getSafeReturnTarget('/prototype/chat')).toBe('/prototype/chat');
  });

  test('preserves allowlisted query parameters and strips hash fragments', () => {
    expect(getSafeReturnTarget('/checkout/passengers?offerId=off_test_123#passenger-1')).toBe(
      '/checkout/passengers?offerId=off_test_123',
    );
    expect(
      getSafeReturnTarget('/prototype/chat?sessionId=sess_123&scenario=mock-scenario-1&autoResume=true'),
    ).toBe('/prototype/chat?sessionId=sess_123&autoResume=true&scenario=mock-scenario-1');
    expect(getSafeReturnTarget('/checkout?offerId=off_valid_456&sessionId=sess_789')).toBe(
      '/checkout?offerId=off_valid_456&sessionId=sess_789',
    );
  });

  test('strips all PII and unallowlisted query parameters', () => {
    const result = getSafeReturnTarget(
      '/checkout/passengers?offerId=off_12345&name=Jane%20Doe&passport=P12345678&email=jane@example.com&password=secret123&token=tok_abc&dob=1990-01-01&ssn=000-00-0000',
    );
    expect(result).toBe('/checkout/passengers?offerId=off_12345');

    expect(getSafeReturnTarget('/prototype/chat?name=Jane%20Doe&passport=P12345')).toBe(
      '/prototype/chat',
    );
  });

  test('filters malformed parameter values', () => {
    expect(getSafeReturnTarget('/checkout?offerId=invalid_format')).toBe('/checkout');
    expect(getSafeReturnTarget('/checkout?offerId=off_<script>')).toBe('/checkout');
    expect(getSafeReturnTarget('/checkout?sessionId=bad%20session')).toBe('/checkout');
    expect(getSafeReturnTarget('/checkout?autoResume=false')).toBe('/checkout');
    expect(getSafeReturnTarget('/checkout?autoResume=1')).toBe('/checkout');
    expect(getSafeReturnTarget('/checkout?autoResume=yes')).toBe('/checkout');
  });

  test('honors custom fallback on rejected targets', () => {
    expect(getSafeReturnTarget(null, '/dashboard')).toBe('/dashboard');
    expect(getSafeReturnTarget('//evil.com', '/dashboard')).toBe('/dashboard');
    expect(getSafeReturnTarget('/admin', '/search')).toBe('/search');
    expect(getSafeReturnTarget('javascript:alert(1)', '/bookings')).toBe('/bookings');
  });
});
