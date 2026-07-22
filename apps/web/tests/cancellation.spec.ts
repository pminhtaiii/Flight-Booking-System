import { expect, test } from '@playwright/test';

const bookingId = '8a7466ab-78bd-4a45-8e9e-9b3c62269a9a';

const confirmedBooking = {
  id: bookingId,
  status: 'CONFIRMED',
  pnrReference: 'PNR123',
  totalAmount: '499.00',
  currency: 'GBP',
  cancellationDeadline: '2099-08-01T09:00:00.000Z',
  flightSnapshot: {
    segments: [{
      airline: { name: 'Example Air', iataCode: 'EA' },
      flightNumber: 'EA101',
      departureAirport: { iataCode: 'LHR', name: 'Heathrow', city: 'London' },
      arrivalAirport: { iataCode: 'JFK', name: 'John F. Kennedy', city: 'New York' },
      departureAt: '2026-08-01T09:00:00.000Z',
      arrivalAt: '2026-08-01T17:00:00.000Z',
      duration: 'PT8H',
    }],
    totalDuration: 'PT8H',
    stops: 0,
    cabinClass: 'ECONOMY',
  },
};

async function authenticate(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/auth/session', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        user: { id: 'user-123', email: 'traveler@example.com' },
        accessToken: 'test-access-token',
        expires: '2099-01-01T00:00:00.000Z',
      }),
    });
  });
}

async function mockBooking(page: import('@playwright/test').Page, booking: Record<string, unknown>): Promise<void> {
  await page.route(`**/api/bookings/${bookingId}`, async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(booking) });
  });
}

test('reviews a supplier quote and submits its quote ID only after acknowledgement', async ({ page }) => {
  await authenticate(page);
  await mockBooking(page, confirmedBooking);
  await page.route(`**/api/bookings/${bookingId}/cancellation-quote`, async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        bookingId,
        quoteId: 'quote-123',
        refundAmount: '399.00',
        currency: 'GBP',
        expiresAt: '2099-08-01T09:30:00.000Z',
      }),
    });
  });

  let submittedQuoteId: string | undefined;
  await page.route(`**/api/bookings/${bookingId}/cancel`, async (route) => {
    submittedQuoteId = (route.request().postDataJSON() as { quoteId: string }).quoteId;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ bookingId, bookingStatus: 'CANCELLED_PENDING_REFUND', refundStatus: 'REFUND_RETRY_SCHEDULED' }),
    });
  });

  await page.goto(`/bookings/${bookingId}`);
  await page.getByRole('button', { name: 'Cancel booking' }).click();

  await expect(page.getByRole('heading', { name: 'Cancel Booking' })).toBeVisible();
  await expect(page.getByText('Refund Amount:')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm Cancellation' })).toBeDisabled();

  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Confirm Cancellation' }).click();

  await expect.poll(() => submittedQuoteId).toBe('quote-123');
  await expect(page.getByRole('heading', { name: 'Cancel Booking' })).toHaveCount(0);
});

test('renders the durable pending-refund state without quoting or cancelling again', async ({ page }) => {
  await authenticate(page);
  await mockBooking(page, { ...confirmedBooking, status: 'CANCELLED_PENDING_REFUND', cancellationDeadline: null });
  await page.route(`**/api/bookings/${bookingId}/cancellation`, async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        bookingId,
        bookingStatus: 'CANCELLED_PENDING_REFUND',
        customerRefundAmount: '399.00',
        refundStatus: 'REFUND_RETRY_SCHEDULED',
        retryCount: 1,
        nextRetryAt: '2099-08-01T10:00:00.000Z',
      }),
    });
  });

  await page.goto(`/bookings/${bookingId}`);

  await expect(page.getByText('Refund Pending')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Cancellation Status' })).toBeVisible();
  await expect(page.getByText('Expected Refund:')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel booking' })).toHaveCount(0);
});

test('shows the long-running refund support hand-off from the read-only status response', async ({ page }) => {
  await authenticate(page);
  await mockBooking(page, { ...confirmedBooking, status: 'REFUND_FAILED_NEEDS_ATTENTION', cancellationDeadline: null });
  await page.route(`**/api/bookings/${bookingId}/cancellation`, async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        bookingId,
        bookingStatus: 'REFUND_FAILED_NEEDS_ATTENTION',
        customerRefundAmount: '399.00',
        refundStatus: 'REFUND_FAILED_NEEDS_ATTENTION',
        retryCount: 3,
        lastErrorCode: 'IDEMPOTENCY_KEY_SAFETY_WINDOW',
        escalationMessage: 'Refund requires attention. Please contact support.',
      }),
    });
  });

  await page.goto(`/bookings/${bookingId}`);

  await expect(page.getByText('Refund Failed')).toBeVisible();
  await expect(page.getByText('Refund requires attention. Please contact support.')).toBeVisible();
  await expect(page.getByText('Last Error: IDEMPOTENCY_KEY_SAFETY_WINDOW')).toBeVisible();
});

test('renders a completed customer refund from the durable booking state', async ({ page }) => {
  await authenticate(page);
  await mockBooking(page, { ...confirmedBooking, status: 'CANCELLED_AND_REFUNDED', cancellationDeadline: null });
  await page.route(`**/api/bookings/${bookingId}/cancellation`, async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        bookingId,
        bookingStatus: 'CANCELLED_AND_REFUNDED',
        customerRefundAmount: '399.00',
        refundStatus: 'SUCCEEDED',
        retryCount: 0,
      }),
    });
  });

  await page.goto(`/bookings/${bookingId}`);

  await expect(page.getByText('Cancelled & Refunded')).toBeVisible();
  await expect(page.getByText('Expected Refund:')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel booking' })).toHaveCount(0);
});

test('renders a no-refund supplier cancellation without a retry or support alarm', async ({ page }) => {
  await authenticate(page);
  await mockBooking(page, { ...confirmedBooking, status: 'CANCELLED_NO_REFUND', cancellationDeadline: null });
  await page.route(`**/api/bookings/${bookingId}/cancellation`, async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        bookingId,
        bookingStatus: 'CANCELLED_NO_REFUND',
        customerRefundAmount: '0.00',
        refundStatus: 'NOT_REQUIRED',
        retryCount: 0,
      }),
    });
  });

  await page.goto(`/bookings/${bookingId}`);

  await expect(page.getByText('Cancelled', { exact: true })).toBeVisible();
  await expect(page.getByText('Expected Refund:')).toBeVisible();
  await expect(page.getByText('Refund requires attention. Please contact support.')).toHaveCount(0);
});

test('does not offer cancellation after the stored cancellation deadline', async ({ page }) => {
  await authenticate(page);
  await mockBooking(page, { ...confirmedBooking, cancellationDeadline: '2020-08-01T09:00:00.000Z' });

  await page.goto(`/bookings/${bookingId}`);

  await expect(page.getByText('Confirmed')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel booking' })).toHaveCount(0);
});
