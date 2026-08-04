import { expect, test } from '@playwright/test';
import { getSafeReturnTarget } from '../lib/safeReturnTarget';

test('preserves an opaque offer ID in an allowed return target', () => {
  expect(getSafeReturnTarget('/checkout/passengers?offerId=off_test_123#passenger-1')).toBe(
    '/checkout/passengers?offerId=off_test_123',
  );
});

test('strips personal-data query values from an allowed return target', () => {
  expect(getSafeReturnTarget('/prototype/chat?name=Jane%20Doe&passport=P12345')).toBe('/prototype/chat');
});
