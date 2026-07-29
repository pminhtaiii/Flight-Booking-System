import { expect, test } from '@playwright/test';

test.describe('Checkout Foundation Flow', () => {
  // Test 1: Redirect unauthenticated user to login
  test('unauthenticated users are redirected to login', async ({ page }) => {
    await page.goto('http://localhost:3000/search');
    await expect(page).toHaveURL(/.*\/login/);

    await page.goto('http://localhost:3000/checkout/passengers?offerId=123');
    await expect(page).toHaveURL(/.*\/login/);

    await page.goto('http://localhost:3000/checkout/mock-intent-id/ancillaries');
    await expect(page).toHaveURL(/.*\/login/);
  });

  // Test 2: Standard domestic booking flow
  test('registered user can search and book a domestic flight', async ({ page, request, context }) => {
    page.on('console', msg => console.log('[Browser Console]', msg.text()));
    page.on('pageerror', err => console.log('[Browser PageError]', err.message));

    // Reset login lockouts and create a user
    await request.post('http://127.0.0.1:3001/api/auth/test/reset-lockout', {
      data: { clearAll: true },
    }).catch(() => {});
    await context.clearCookies();

    const email = `checkout-dom-${Date.now()}@example.com`;
    await page.goto('http://localhost:3000/register');
    await page.getByRole('textbox', { name: 'Email' }).fill(email);
    await page.getByRole('textbox', { name: 'Password' }).fill('Password123!');
    await page.getByRole('button', { name: 'Create account' }).click();

    // Check for page validation or API errors on failure
    const errorAlert = page.locator('form [role="alert"]');
    if (await errorAlert.count() > 0) {
      console.log('[Register Form Alert Text]', await errorAlert.textContent());
    }

    await expect(page).toHaveURL(/.*localhost:3000\/$/, { timeout: 15000 });

    // Set cookie for domestic mock scenario
    await context.addCookies([{
      name: 'mock-scenario',
      value: 'domestic-offer',
      url: 'http://localhost:3000',
    }]);

    // Go to search
    await page.goto('http://localhost:3000/search');
    await page.getByLabel('Origin (IATA)').fill('LAX');
    await page.getByLabel('Destination (IATA)').fill('SFO');
    await page.getByLabel('Departure Date').fill('2026-12-12');
    
    // Intercept Search API
    await page.route('**/api/flights/search', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          results: [{
            id: 'mock-dom-offer-id',
            airline: 'Delta Air Lines',
            flightNumber: 'DL456',
            departureAirport: 'LAX',
            arrivalAirport: 'SFO',
            departureTime: '2026-12-12T12:00:00Z',
            arrivalTime: '2026-12-12T13:30:00Z',
            duration: 90,
            stops: 0,
            price: 150,
            currency: 'USD',
          }],
          meta: { totalResults: 1 },
        }),
      });
    });

    await page.getByRole('button', { name: 'Search Flights' }).click();

    // Verify search results render
    await expect(page.getByText('Delta Air Lines')).toBeVisible();
    await expect(page.getByText('Flight DL456')).toBeVisible();
    await expect(page.getByText('150 USD')).toBeVisible();

    // Click Book
    // Intercept flight details & prefill APIs
    await page.route('**/api/flights/mock-dom-offer-id', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'mock-dom-offer-id',
          airline: 'Delta Air Lines',
          flightNumber: 'DL456',
          departureAirport: 'LAX',
          arrivalAirport: 'SFO',
          departureTime: '2026-12-12T12:00:00Z',
          arrivalTime: '2026-12-12T13:30:00Z',
          originalPrice: 150,
          confirmedPrice: 150,
          priceChanged: false,
          currency: 'USD',
          adults: 1,
          children: 1,
          infants: 0,
          segments: [{ departureAirport: 'LAX', arrivalAirport: 'SFO' }],
        }),
      });
    });

    await page.route('**/api/bookings/intent/prefill', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          hasProfile: true,
          passenger: {
            givenName: 'Jane',
            familyName: 'Doe',
            dateOfBirth: '1995-05-05',
            gender: 'female',
            nationality: 'US',
            passportNumber: 'P12345',
            passportExpiry: '2030-05-05',
          },
        }),
      });
    });

    await page.getByRole('link', { name: 'Book' }).click();

    // We should be on passengers page
    await expect(page).toHaveURL(/.*checkout\/passengers\?offerId=mock-dom-offer-id/);

    // Verify Dynamic sections exist
    await expect(page.getByRole('heading', { name: 'Passenger 1 (ADULT)' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Passenger 2 (CHILD)' })).toBeVisible();

    // Use prefill for the first passenger
    await page.getByRole('button', { name: 'Use my traveler profile details' }).click();

    // Fill in second passenger (Child) details
    await page.locator('div:has-text("Passenger 2 (CHILD)") input').nth(0).fill('Timmy');
    await page.locator('div:has-text("Passenger 2 (CHILD)") input').nth(1).fill('Doe');
    await page.locator('div:has-text("Passenger 2 (CHILD)") input').nth(2).fill('2015-05-05');
    await page.locator('div:has-text("Passenger 2 (CHILD)") select').nth(0).selectOption('male');

    // Intercept Create Intent API
    await page.route('**/api/bookings/intent', async (route) => {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          intentId: 'mock-intent-id',
        }),
      });
    });

    // Intercept Booking Intent details
    await page.route('**/api/bookings/intent/mock-intent-id', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          intentId: 'mock-intent-id',
          status: 'PENDING',
          originalPrice: 150,
          confirmedPrice: 150,
          priceChanged: false,
          currency: 'USD',
          pricedAt: new Date().toISOString(),
          intentExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          createdAt: new Date().toISOString(),
          passengers: [
            {
              id: 'p1',
              type: 'ADULT',
              givenName: 'Jane',
              familyName: 'Doe',
              dateOfBirth: '1995-05-05',
              gender: 'female',
              nationality: 'US',
              passportNumber: 'P12345',
              passportExpiry: '2030-05-05',
            },
            {
              id: 'p2',
              type: 'CHILD',
              givenName: 'Timmy',
              familyName: 'Doe',
              dateOfBirth: '2015-05-05',
              gender: 'male',
              nationality: '',
              passportNumber: '',
              passportExpiry: '',
            }
          ],
          flight: {
            origin: 'LAX',
            destination: 'SFO',
            departureDate: '2026-12-12',
            cabinClass: 'economy',
            adults: 1,
            children: 1,
            infants: 0,
          }
        }),
      });
    });

    // Submit form
    await page.getByRole('button', { name: 'Continue to Ancillaries' }).click();

    // Verify redirects to ancillaries
    await expect(page).toHaveURL(/.*checkout\/mock-intent-id\/ancillaries/);

    // Verify context elements
    await expect(page.getByRole('heading', { name: 'Ancillary Services' })).toBeVisible();
    await expect(page.getByText('LAX to SFO')).toBeVisible();
    await expect(page.getByText('Jane Doe')).toBeVisible();
    await expect(page.getByText('Timmy Doe')).toBeVisible();

    // Continue to Review
    await page.getByRole('link', { name: 'Continue to Review' }).click();
    await expect(page).toHaveURL(/.*checkout\/mock-intent-id\/review/);

    // Verify passenger details as read-only
    await expect(page.getByRole('heading', { name: 'Review Booking' })).toBeVisible();
    await expect(page.getByText('1. Jane Doe')).toBeVisible();
    await expect(page.getByText('2. Timmy Doe')).toBeVisible();

    // Continue to Payment
    await page.getByRole('link', { name: 'Proceed to Payment' }).click();
    await expect(page).toHaveURL(/.*checkout\/mock-intent-id\/payment/);

    // Verify Payment page and confirmed price
    await expect(page.getByRole('heading', { name: 'Payment' })).toBeVisible();
    await expect(page.getByText('150 USD')).toBeVisible();
    await expect(page.getByText('Credit Card Payment Placeholder')).toBeVisible();
  });

  // Test 3: Cookie mock error scenarios
  test('renders error screens based on mock scenarios', async ({ page, request, context }) => {
    page.on('console', msg => console.log('[Browser Console]', msg.text()));
    page.on('pageerror', err => console.log('[Browser PageError]', err.message));

    // Reset login lockouts and create a user
    await request.post('http://127.0.0.1:3001/api/auth/test/reset-lockout', {
      data: { clearAll: true },
    }).catch(() => {});
    await context.clearCookies();

    const email = `checkout-err-${Date.now()}@example.com`;
    await page.goto('http://localhost:3000/register');
    await page.getByRole('textbox', { name: 'Email' }).fill(email);
    await page.getByRole('textbox', { name: 'Password' }).fill('Password123!');
    await page.getByRole('button', { name: 'Create account' }).click();

    // Check for page validation or API errors on failure
    const errorAlert = page.locator('form [role="alert"]');
    if (await errorAlert.count() > 0) {
      console.log('[Register Form Alert Text]', await errorAlert.textContent());
    }

    await expect(page).toHaveURL(/.*localhost:3000\/$/, { timeout: 15000 });

    // Scenario 404: Not Found
    await context.addCookies([{
      name: 'mock-scenario',
      value: 'intent-not-found',
      url: 'http://localhost:3000',
    }]);
    await page.goto('http://localhost:3000/checkout/some-id/ancillaries');
    await expect(page.getByRole('heading', { name: 'Booking Intent Not Found' })).toBeVisible();

    // Scenario 403: Forbidden
    await context.addCookies([{
      name: 'mock-scenario',
      value: 'intent-forbidden',
      url: 'http://localhost:3000',
    }]);
    await page.goto('http://localhost:3000/checkout/some-id/ancillaries');
    await expect(page.getByRole('heading', { name: 'Forbidden' })).toBeVisible();

    // Scenario 410: Expired
    await context.addCookies([{
      name: 'mock-scenario',
      value: 'intent-expired',
      url: 'http://localhost:3000',
    }]);
    await page.goto('http://localhost:3000/checkout/some-id/ancillaries');
    await expect(page.getByRole('heading', { name: 'Booking Intent Expired' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Return to Search' })).toBeVisible();

    // Scenario 500: Service Unavailable
    await context.addCookies([{
      name: 'mock-scenario',
      value: 'intent-unavailable',
      url: 'http://localhost:3000',
    }]);
    await page.goto('http://localhost:3000/checkout/some-id/ancillaries');
    await expect(page.getByRole('heading', { name: 'Service Unavailable' })).toBeVisible();
  });
});
