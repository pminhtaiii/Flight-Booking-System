import { expect, test } from '@playwright/test';

const bookingId = '8a7466ab-78bd-4a45-8e9e-9b3c62269a9a';

test('renders a confirmed booking snapshot and confirmation banner', async ({ page }) => {
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
  await page.route(`**/api/bookings/${bookingId}`, async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        id: bookingId,
        status: 'CONFIRMED',
        pnrReference: 'PNR123',
        totalAmount: '49900',
        currency: 'GBP',
        paymentStatus: 'SUCCEEDED',
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
          baggageAllowance: '1 checked bag',
        },
        passengerSnapshot: {
          passengers: [{ type: 'adult', firstName: 'Ada', lastName: 'Lovelace' }],
          contactEmail: 'traveler@example.com',
        },
      }),
    });
  });

  await page.goto(`/bookings/${bookingId}?confirmed=true`);

  await expect(page.getByRole('heading', { name: 'Booking confirmed' })).toBeVisible();
  await expect(page.getByText('PNR123')).toBeVisible();
  await expect(page.getByText('Example Air EA101')).toBeVisible();
  await expect(page.getByText('Ada Lovelace')).toBeVisible();
});

test('renders a processing booking state while the reservation is pending', async ({ page }) => {
  await page.route('**/api/auth/session', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ user: { id: 'user-123' } }) });
  });
  await page.route(`**/api/bookings/${bookingId}`, async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ id: bookingId, status: 'PROCESSING', totalAmount: '49900', currency: 'GBP' }),
    });
  });

  await page.goto(`/bookings/${bookingId}`);

  await expect(page.getByRole('heading', { name: 'Your booking is being processed' })).toBeVisible();
});

test('explains an expired offer and provides a route-aware retry without assuming a charge', async ({ page }) => {
  await page.route('**/api/auth/session', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ user: { id: 'user-123' } }) });
  });
  await page.route(`**/api/bookings/${bookingId}`, async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        id: bookingId,
        status: 'FAILED',
        failureReason: 'OFFER_EXPIRED',
        totalAmount: '49900',
        currency: 'GBP',
        flightSnapshot: {
          segments: [{
            airline: { name: 'Example Air', iataCode: 'EA' },
            flightNumber: 'EA101',
            departureAirport: { iataCode: 'LHR', name: 'Heathrow', city: 'London' },
            arrivalAirport: { iataCode: 'JFK', name: 'John F. Kennedy', city: 'New York' },
            departureAt: '2026-08-01T09:00:00.000Z', arrivalAt: '2026-08-01T17:00:00.000Z', duration: 'PT8H',
          }],
          totalDuration: 'PT8H', stops: 0, cabinClass: 'ECONOMY',
        },
      }),
    });
  });

  await page.goto(`/bookings/${bookingId}`);

  await expect(page.getByText('This offer is no longer available.')).toBeVisible();
  await expect(page.getByText('No charge was made to your card.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Search flights again' })).toHaveAttribute('href', '/search?origin=LHR&destination=JFK');
});

test('routes price changes back to the original flight detail', async ({ page }) => {
  await page.route('**/api/auth/session', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ user: { id: 'user-123' } }) });
  });
  await page.route(`**/api/bookings/${bookingId}`, async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        id: bookingId, status: 'FAILED', failureReason: 'PRICE_CHANGED', totalAmount: '49900', currency: 'GBP',
        bookingIntent: { id: 'intent-123', offerId: 'offer-123' }, payment: { status: 'AUTHORIZED' },
      }),
    });
  });

  await page.goto(`/bookings/${bookingId}`);

  await expect(page.getByText("A hold was placed on your card — we're working to release it.")).toBeVisible();
  await expect(page.getByRole('link', { name: 'Review this flight' })).toHaveAttribute('href', '/search/offer-123');
});

test('renders a booking after an unauthenticated request is retried with the session token', async ({ page }) => {
  await page.route('**/api/auth/session', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        user: { id: 'user-123', email: 'traveler@example.com' },
        accessToken: 'test-access-token',
        expires: '2099-01-01T00:00:00.000Z',
      }),
    });
  });

  let requestCount = 0;
  await page.route(`**/api/bookings/${bookingId}`, async (route) => {
    requestCount += 1;
    if (requestCount === 1) {
      await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ message: 'Unauthorized' }) });
      return;
    }

    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ id: bookingId, status: 'PROCESSING', totalAmount: '49900', currency: 'GBP' }),
    });
  });

  await page.goto(`/bookings/${bookingId}`);

  await expect(page.getByRole('heading', { name: 'Your booking is being processed' })).toBeVisible();
});
