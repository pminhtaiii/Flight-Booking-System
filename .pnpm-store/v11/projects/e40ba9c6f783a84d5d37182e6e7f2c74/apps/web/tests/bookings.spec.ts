import { expect, test } from '@playwright/test';

const bookingId = '8a7466ab-78bd-4a45-8e9e-9b3c62269a9a';

test.describe('My Bookings list', () => {
  test('lets a newly registered traveler switch tabs and shows the empty-state search action', async ({ page, request, context }) => {
    page.on('console', msg => console.log('[Browser Console]', msg.text()));
    page.on('pageerror', err => console.log('[Browser PageError]', err.message));

    await request.post('http://127.0.0.1:3001/api/auth/test/reset-lockout', {
      data: { clearAll: true },
    }).catch(err => console.log('[ResetLockout Connection Error]', err));

    await context.clearCookies();

    const email = `bookings-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    await page.goto('http://localhost:3000/register');
    await page.getByRole('textbox', { name: 'Email' }).fill(email);
    await page.getByRole('textbox', { name: 'Password' }).fill('Password123!');
    await page.getByRole('button', { name: 'Create account' }).click();

    // Check for page validation or API errors on failure
    const errorAlert = page.locator('form [role="alert"]');
    if (await errorAlert.count() > 0) {
      console.log('[Register Form Alert Text]', await errorAlert.textContent());
    }

    await expect(page).toHaveURL(/.*localhost:3000\/home$/, { timeout: 30000 });

    await page.goto('http://localhost:3000/bookings');

    await expect(page.getByRole('heading', { name: 'My Bookings' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Upcoming' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('No bookings yet — start planning your next trip.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Search Flights' }).first()).toHaveAttribute('href', '/search');

    await page.getByRole('tab', { name: 'Past' }).click();
    await expect(page).toHaveURL(/\/bookings\?tab=past&page=1$/);
    await expect(page.getByRole('tab', { name: 'Past' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('No bookings yet — start planning your next trip.')).toBeVisible();
  });
});

test('renders a confirmed booking snapshot and confirmation banner', async ({ page, context }) => {
  await context.addCookies([{
    name: 'mock-scenario',
    value: 'confirmed-booking',
    domain: '127.0.0.1',
    path: '/',
  }]);

  await page.goto(`/bookings/${bookingId}?confirmed=true`);

  await expect(page.getByRole('heading', { name: 'Booking confirmed' })).toBeVisible();
  await expect(page.getByText('PNR123').first()).toBeVisible();
  await expect(page.getByText('Example Air EA101')).toBeVisible();
  await expect(page.getByText('Ada Lovelace')).toBeVisible();
});

test('does not show the confirmation banner after the confirmation query is absent', async ({ page, context }) => {
  await context.addCookies([{
    name: 'mock-scenario',
    value: 'confirmed-booking',
    domain: '127.0.0.1',
    path: '/',
  }]);

  await page.goto(`/bookings/${bookingId}`);

  await expect(page.getByRole('heading', { name: 'Booking confirmed' })).toHaveCount(0);
  await expect(page.getByText('PNR123').first()).toBeVisible();
});

test('renders a processing booking state while the reservation is pending', async ({ page, context }) => {
  await context.addCookies([{
    name: 'mock-scenario',
    value: 'processing-booking',
    domain: '127.0.0.1',
    path: '/',
  }]);

  await page.goto(`/bookings/${bookingId}`);

  await expect(page.getByRole('heading', { name: 'Your booking is being processed' })).toBeVisible();
  await expect(page.getByText('Please refresh this page shortly to check its status.')).toBeVisible();
});

test('explains an expired offer and provides a route-aware retry without assuming a charge', async ({ page, context }) => {
  await context.addCookies([{
    name: 'mock-scenario',
    value: 'expired-offer',
    domain: '127.0.0.1',
    path: '/',
  }]);

  await page.goto(`/bookings/${bookingId}`);

  await expect(page.getByText('This offer is no longer available.')).toBeVisible();
  await expect(page.getByText('No charge was made to your card.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Search flights again' })).toHaveAttribute('href', '/search?origin=LHR&destination=JFK');
});

test('routes price changes back to the original flight detail', async ({ page, context }) => {
  await context.addCookies([{
    name: 'mock-scenario',
    value: 'price-changed',
    domain: '127.0.0.1',
    path: '/',
  }]);

  await page.goto(`/bookings/${bookingId}`);

  await expect(page.getByText("A hold was placed on your card — we're working to release it.")).toBeVisible();
  await expect(page.getByRole('link', { name: 'Review this flight' })).toHaveAttribute('href', '/search/offer-123');
});

test('redirects unauthenticated request to login page', async ({ page, context }) => {
  await context.clearCookies();
  await page.goto(`/bookings/${bookingId}`);
  await expect(page).toHaveURL(/\/login/);
});
