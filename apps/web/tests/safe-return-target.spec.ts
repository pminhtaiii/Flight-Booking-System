import { expect, test } from '@playwright/test';
import { getSafeReturnTarget } from '../lib/safeReturnTarget';

test('preserves routing state in an allowed return target', () => {
  expect(getSafeReturnTarget('/checkout/passengers?offerId=123#passenger-1')).toBe(
    '/checkout/passengers?offerId=123#passenger-1',
  );
});
