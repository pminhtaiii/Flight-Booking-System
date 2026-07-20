import { expect, Page, test } from '@playwright/test';

async function authenticateCheckout(page: Page) {
  await page.route('**/api/auth/session', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        user: { id: 'user-123', email: 'checkout@example.com' },
        accessToken: 'test-access-token',
        expires: '2099-01-01T00:00:00.000Z',
      }),
    });
  });
}

async function openAuthenticatedCheckout(page: Page) {
  const sessionResponse = page.waitForResponse((response) => response.url().includes('/api/auth/session'));
  await page.goto('/checkout?paymentId=payment-123');
  await sessionResponse;
}

test.describe('Checkout loading escalation', () => {
  test('shows an accessible recovery state when the payment id is absent', async ({ page }) => {
    await page.goto('/checkout');

    await expect(page.getByRole('heading', { name: 'Payment information is missing' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Return to flight search' })).toBeVisible();
  });

  test('requires sign-in before a payment can be confirmed', async ({ page }) => {
    await page.route('**/api/auth/session', async (route) => {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({}) });
    });

    await openAuthenticatedCheckout(page);

    await expect(page.getByRole('link', { name: 'Sign in to continue' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Confirm payment' })).toHaveCount(0);
  });

  test('generates a UUID v4 booking id and redirects to the confirmed booking', async ({ page }) => {
    let confirmPayload: Record<string, unknown> | undefined;
    let authorizationHeader: string | undefined;
    let idempotencyKey: string | undefined;

    await authenticateCheckout(page);

    await page.route('**/api/bookings/payment/confirm', async (route) => {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      confirmPayload = payload;
      authorizationHeader = route.request().headers().authorization;
      idempotencyKey = route.request().headers()['idempotency-key'];
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          bookingId: payload.bookingId,
          paymentId: 'payment-123',
          status: 'CONFIRMED',
        }),
      });
    });

    await openAuthenticatedCheckout(page);
    await page.getByRole('button', { name: 'Confirm payment' }).click();

    await expect(page).toHaveURL(/\/bookings\/[\da-f-]+\?confirmed=true$/);
    expect(confirmPayload?.paymentId).toBe('payment-123');
    expect(authorizationHeader).toBe('Bearer test-access-token');
    expect(idempotencyKey).toBe(confirmPayload?.bookingId);
    expect(confirmPayload?.bookingId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  test('keeps the user on checkout when the server response lacks a canonical booking id', async ({ page }) => {
    await authenticateCheckout(page);
    await page.route('**/api/bookings/payment/confirm', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ success: true, paymentId: 'payment-123', status: 'SUCCEEDED', bookingReference: 'PNR123' }),
      });
    });

    await openAuthenticatedCheckout(page);
    await page.getByRole('button', { name: 'Confirm payment' }).click();

    await expect(page).toHaveURL(/\/checkout\?paymentId=payment-123$/);
    await expect(page.getByRole('alert')).toHaveText(/booking is still being prepared/i);
  });

  test('shows a friendly error when payment confirmation returns a non-JSON response', async ({ page }) => {
    await authenticateCheckout(page);
    await page.route('**/api/bookings/payment/confirm', async (route) => {
      await route.fulfill({
        status: 502,
        contentType: 'text/html',
        body: '<html><body>Bad Gateway</body></html>',
      });
    });

    await openAuthenticatedCheckout(page);
    await page.getByRole('button', { name: 'Confirm payment' }).click();

    await expect(page.getByRole('alert')).toHaveText('We could not confirm your payment.');
  });

  test('reuses the booking id and idempotency key after an ambiguous request failure', async ({ page }) => {
    const confirmRequests: Array<{ bookingId: unknown; idempotencyKey: string | undefined }> = [];

    await authenticateCheckout(page);
    await page.route('**/api/bookings/payment/confirm', async (route) => {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      confirmRequests.push({
        bookingId: payload.bookingId,
        idempotencyKey: route.request().headers()['idempotency-key'],
      });

      if (confirmRequests.length === 1) {
        await route.abort('failed');
        return;
      }

      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ success: true, bookingId: payload.bookingId, status: 'CONFIRMED' }),
      });
    });

    await openAuthenticatedCheckout(page);
    await page.getByRole('button', { name: 'Confirm payment' }).click();
    await expect(page.getByRole('alert')).toHaveText(/could not confirm your payment/i);
    await page.getByRole('button', { name: 'Confirm payment' }).click();

    await expect(page).toHaveURL(/\/bookings\/[\da-f-]+\?confirmed=true$/);
    expect(confirmRequests).toHaveLength(2);
    expect(confirmRequests[0]).toEqual(confirmRequests[1]);
  });

  test('shows reassurance at ten seconds, an escape hatch at twenty seconds, and redirects at forty-five seconds', async ({ page }) => {
    test.slow();
    await authenticateCheckout(page);
    await page.route('**/api/bookings/payment/confirm', () => new Promise(() => undefined));

    await openAuthenticatedCheckout(page);
    await page.getByRole('button', { name: 'Confirm payment' }).click();

    await expect(page.getByText('Please keep this page open while we confirm your payment and reserve your flight.')).toBeVisible();
    await page.waitForTimeout(10_000);
    await expect(page.getByText('This is taking a little longer than usual. Your payment is still being processed securely.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check My Bookings' })).toBeHidden();
    await page.waitForTimeout(10_000);
    await expect(page.getByRole('button', { name: 'Check My Bookings' })).toBeVisible();
    await page.waitForTimeout(25_000);
    await expect(page).toHaveURL(/\/bookings\/[\da-f-]+$/);
  });

  test('uses the canonical processing id for the escape hatch', async ({ page }) => {
    test.slow();
    const canonicalBookingId = '8a7466ab-78bd-4a45-8e9e-9b3c62269a9a';
    await authenticateCheckout(page);
    await page.route('**/api/bookings/payment/confirm', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ success: true, bookingId: canonicalBookingId, status: 'PROCESSING' }),
      });
    });

    await openAuthenticatedCheckout(page);
    await page.getByRole('button', { name: 'Confirm payment' }).click();
    await expect(page.getByRole('button', { name: 'Check My Bookings' })).toBeVisible({ timeout: 25_000 });
    await page.getByRole('button', { name: 'Check My Bookings' }).click();

    await expect(page).toHaveURL(new RegExp(`/bookings/${canonicalBookingId}$`));
  });

  test('redirects failed confirmations with the canonical booking id and no confirmation query', async ({ page }) => {
    const canonicalBookingId = 'a4b02d35-4b11-44eb-81bf-29bf5739e91c';
    await authenticateCheckout(page);
    await page.route('**/api/bookings/payment/confirm', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ success: false, bookingId: canonicalBookingId, status: 'FAILED' }),
      });
    });

    await openAuthenticatedCheckout(page);
    await page.getByRole('button', { name: 'Confirm payment' }).click();

    await expect(page).toHaveURL(new RegExp(`/bookings/${canonicalBookingId}$`));
  });
});
