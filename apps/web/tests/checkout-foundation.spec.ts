import {
  expect,
  test,
  type Page,
  type APIRequestContext,
  type BrowserContext,
} from '@playwright/test';

async function registerAndLoginUser(
  page: Page,
  request: APIRequestContext,
  context: BrowserContext,
): Promise<string> {
  page.on('console', (msg) => console.log('[Browser Console]', msg.text()));
  page.on('pageerror', (err) => console.log('[Browser PageError]', err.message));

  await request
    .post('http://127.0.0.1:3001/api/auth/test/reset-lockout', {
      data: { clearAll: true },
    })
    .catch(() => {});
  await context.clearCookies();

  const email = `checkout-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  await page.goto('http://127.0.0.1:3000/register');
  await page.getByRole('textbox', { name: 'Email' }).fill(email);
  await page.getByRole('textbox', { name: 'Password' }).fill('Password123!');
  await page.getByRole('button', { name: 'Create account' }).click();

  const errorAlert = page.locator('form [role="alert"]');
  if ((await errorAlert.count()) > 0) {
    console.log('[Register Form Alert Text]', await errorAlert.textContent());
  }

  await expect(page).toHaveURL(/.*127\.0\.0\.1:3000\/$/, { timeout: 45000 });

  // Cold start fallback if session cookie not immediately populated
  if (page.url().includes('/login')) {
    await page.getByRole('textbox', { name: 'Email address' }).fill(email);
    await page.getByRole('textbox', { name: 'Password' }).fill('Password123!');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/.*127\.0\.0\.1:3000\/$/, { timeout: 45000 });
  }

  return email;
}

test.describe('Checkout Foundation Flow', () => {
  test.slow();

  // Test 1: Redirect unauthenticated user to login
  test('unauthenticated users are redirected to login', async ({ page }) => {
    await page.goto('http://127.0.0.1:3000/search');
    await expect(page).toHaveURL(/.*\/login/);

    await page.goto('http://127.0.0.1:3000/checkout/passengers?offerId=123');
    await expect(page).toHaveURL(/.*\/login/);

    await page.goto('http://127.0.0.1:3000/checkout/mock-intent-id/ancillaries');
    await expect(page).toHaveURL(/.*\/login/);

    await page.goto('http://127.0.0.1:3000/checkout/mock-intent-id/review');
    await expect(page).toHaveURL(/.*\/login/);

    await page.goto('http://127.0.0.1:3000/checkout/mock-intent-id/payment');
    await expect(page).toHaveURL(/.*\/login/);
  });

  // Test 2: Plural passenger sources (primary profile + companion inline), readiness query, review page masking & PII omission
  test('registered user can book with plural passenger sources (primary profile + companion inline)', async ({
    page,
    request,
    context,
  }) => {
    await registerAndLoginUser(page, request, context);

    // Set cookie for domestic mock scenario
    await context.addCookies([
      {
        name: 'mock-scenario',
        value: 'mock-ancillary-phase4',
        url: 'http://127.0.0.1:3000',
      },
    ]);

    let readinessQueried = false;
    let intentCreated = false;
    let capturedReadinessPayload: { passengers?: Array<{ source?: { type?: string } }> } | null =
      null;
    let capturedIntentPayload: {
      flightOfferId?: string;
      passengers?: Array<{ source?: { type?: string } }>;
    } | null = null;

    // Intercept readiness API
    await page.route('**/api/bookings/intents/readiness', async (route) => {
      readinessQueried = true;
      capturedReadinessPayload = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          scope: 'DOMESTIC',
          ready: true,
          passengers: [
            {
              passengerType: 'ADULT',
              passengerOrdinal: 1,
              ready: true,
              profileRevision: 1,
              sections: [],
            },
            {
              passengerType: 'CHILD',
              passengerOrdinal: 2,
              ready: true,
              profileRevision: null,
              sections: [],
            },
          ],
        }),
      });
    });

    // Intercept canonical create intent API
    await page.route('**/api/bookings/intents', async (route) => {
      intentCreated = true;
      capturedIntentPayload = route.request().postDataJSON();
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          intentId: 'mock-intent-id',
        }),
      });
    });

    // Intercept Booking Intent details
    await page.route('**/api/bookings/intents/mock-intent-id', async (route) => {
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
              passengerType: 'ADULT',
              passengerOrdinal: 1,
              nameSummary: 'J••• D•••',
              documentSummary: {
                documentType: 'passport',
                issuingCountry: 'US',
                hasPassport: true,
                maskedPassportSummary: '•••• 5678',
              },
              contactSummary: {
                email: 'j•••@example.test',
                phone: '+1••••00',
                maskedContactSummary: 'j•••@example.test · +1••••00',
              },
              maskedPassportSummary: '•••• 5678',
              maskedContactSummary: 'j•••@example.test · +1••••00',
              preFilledFromProfile: true,
              passportNumber: null,
              passportExpiry: null,
            },
            {
              id: 'p2',
              passengerType: 'CHILD',
              passengerOrdinal: 2,
              nameSummary: 'T••• D•••',
              documentSummary: {
                documentType: 'passport',
                issuingCountry: 'US',
                hasPassport: true,
                maskedPassportSummary: '•••• ••••',
              },
              contactSummary: {
                email: 't•••@example.test',
                phone: '+1••••01',
                maskedContactSummary: 't•••@example.test · +1••••01',
              },
              maskedPassportSummary: '•••• ••••',
              maskedContactSummary: 't•••@example.test · +1••••01',
              preFilledFromProfile: false,
              passportNumber: null,
              passportExpiry: null,
            },
          ],
          flight: {
            origin: 'LAX',
            destination: 'SFO',
            departureDate: '2026-12-12',
            cabinClass: 'economy',
            adults: 1,
            children: 1,
            infants: 0,
          },
        }),
      });
    });

    // Go to search
    await page.goto('http://127.0.0.1:3000/search');
    await page.getByLabel('Origin (IATA)').fill('LAX');
    await page.getByLabel('Destination (IATA)').fill('SFO');
    await page.getByLabel('Departure Date').fill('2026-12-12');
    await page.getByRole('button', { name: 'Search Flights' }).click();

    // Verify search results render
    await expect(page.getByText('Delta Air Lines')).toBeVisible();
    await expect(page.getByText('Flight DL456')).toBeVisible();
    await expect(page.getByText('150 USD')).toBeVisible();

    // Click Book
    await page.getByRole('button', { name: 'Book' }).click();
    await expect(page).toHaveURL(/.*checkout\/passengers\?offerId=mock-dom-offer-id/);

    // Verify Dynamic passenger sections exist
    await expect(page.getByRole('heading', { name: 'Passenger 1 (ADULT)' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Passenger 2 (CHILD)' })).toBeVisible();

    // Use profile prefill for Passenger 1 (Primary)
    await page.getByRole('button', { name: 'Use my traveler profile details' }).click();

    // Fill contact details for Passenger 1
    const passenger1 = page.locator('.card', { hasText: 'Passenger 1 (ADULT)' });
    await passenger1.getByLabel('Email *').fill('alex@example.test');
    await passenger1.getByLabel('Phone Country Code *').fill('+1');
    await passenger1.getByLabel('Phone Number *').fill('5551234567');

    // Fill companion Passenger 2 (CHILD) inline
    const passenger2 = page.locator('.card', { hasText: 'Passenger 2 (CHILD)' });
    await passenger2.getByLabel('Given Name *').fill('Timmy');
    await passenger2.getByLabel('Family Name *').fill('Doe');
    await passenger2.getByLabel('Date of Birth *').fill('2015-05-05');
    await passenger2.getByLabel('Gender *').selectOption('male');
    await passenger2.getByLabel('Email *').fill('timmy@example.test');
    await passenger2.getByLabel('Phone Country Code *').fill('+1');
    await passenger2.getByLabel('Phone Number *').fill('5550000001');

    // Submit form
    await page.getByRole('button', { name: 'Continue to Ancillaries' }).click();

    // Verify route queries /api/bookings/intents/readiness and /api/bookings/intents
    expect(readinessQueried).toBe(true);
    expect(capturedReadinessPayload?.passengers).toHaveLength(2);
    expect(capturedReadinessPayload.passengers[0].source.type).toBe('traveler_profile');
    expect(capturedReadinessPayload.passengers[1].source.type).toBe('inline');

    expect(intentCreated).toBe(true);
    expect(capturedIntentPayload?.flightOfferId).toBe('mock-dom-offer-id');
    expect(capturedIntentPayload?.passengers[0].source.type).toBe('traveler_profile');
    expect(capturedIntentPayload?.passengers[1].source.type).toBe('inline');

    // Verify navigation to ancillaries
    await expect(page).toHaveURL(/.*checkout\/mock-intent-id\/ancillaries/);
    await expect(page.getByRole('heading', { name: 'Your flight extras' })).toBeVisible();

    // Intercept ancillaries save and proceed to review
    await page.route('**/api/bookings/intent/mock-intent-id/ancillaries', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          selectionId: 'sel_123',
          selectionVersion: 1,
          intentExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        }),
      });
    });

    await page.getByRole('button', { name: 'Continue to review' }).click();
    await expect(page).toHaveURL(/.*checkout\/mock-intent-id\/review/);

    // Verify Review Page masked summaries
    await expect(page.getByRole('heading', { name: 'Review Booking' })).toBeVisible();

    // Passenger 1 (Profile source) assertions
    await expect(page.getByText('1. J••• D•••')).toBeVisible();
    await expect(page.getByText('•••• 5678')).toBeVisible();
    await expect(page.getByText(/j•••@example\.test/)).toBeVisible();
    await expect(page.getByText('Traveler profile')).toBeVisible();
    const secureEditLink = page.getByRole('link', { name: 'Edit traveler profile securely' });
    await expect(secureEditLink).toBeVisible();
    await expect(secureEditLink).toHaveAttribute(
      'href',
      '/profile?returnTo=/checkout/mock-intent-id/review',
    );

    // Passenger 2 (Inline companion) assertions
    await expect(page.getByText('2. T••• D•••')).toBeVisible();
    await expect(page.getByText('•••• ••••')).toBeVisible();
    await expect(page.getByText(/t•••@example\.test/)).toBeVisible();
    await expect(page.getByText('Entered for this booking')).toBeVisible();

    // Assert raw PII (passport numbers, birth dates, raw full names) do NOT appear in the review page DOM
    await expect(page.getByText('Jane Doe')).not.toBeVisible();
    await expect(page.getByText('Timmy Doe')).not.toBeVisible();
    await expect(page.getByText('P12345')).not.toBeVisible();
    await expect(page.getByText('1995-05-05')).not.toBeVisible();
    await expect(page.getByText('2015-05-05')).not.toBeVisible();

    const pageContent = await page.content();
    expect(pageContent).not.toContain('P12345');
    expect(pageContent).not.toContain('1995-05-05');
    expect(pageContent).not.toContain('2015-05-05');

    // Proceed to Payment
    await page.getByRole('link', { name: 'Proceed to Payment' }).click();
    await expect(page).toHaveURL(/.*checkout\/mock-intent-id\/payment/);
    await expect(page.getByRole('heading', { name: 'Payment', exact: true })).toBeVisible();
    await expect(page.getByText('150 USD')).toBeVisible();
    await expect(page.getByText('Credit Card Payment Placeholder')).toBeVisible();
  });

  // Test 3: Stale revision conflict recovery (409 PROFILE_CHANGED)
  test('recovers gracefully from stale traveler profile revision conflict (409 PROFILE_CHANGED)', async ({
    page,
    request,
    context,
  }) => {
    await registerAndLoginUser(page, request, context);

    // Set cookie for domestic mock scenario
    await context.addCookies([
      {
        name: 'mock-scenario',
        value: 'international-offer',
        url: 'http://127.0.0.1:3000',
      },
    ]);

    // Mock readiness to pass
    await page.route('**/api/bookings/intents/readiness', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          scope: 'DOMESTIC',
          ready: true,
          passengers: [
            {
              passengerType: 'ADULT',
              passengerOrdinal: 1,
              ready: true,
              profileRevision: 1,
              sections: [],
            },
          ],
        }),
      });
    });

    let createAttempt = 0;
    // Intercept create intent API: First attempt returns 409 PROFILE_CHANGED, second attempt returns 201
    await page.route('**/api/bookings/intents', async (route) => {
      createAttempt += 1;
      if (createAttempt === 1) {
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'PROFILE_CHANGED',
            message: 'Your traveler profile was updated in another session.',
          }),
        });
      } else {
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            intentId: 'mock-recovered-intent-id',
          }),
        });
      }
    });

    // Navigate to passenger details page
    await page.goto('http://127.0.0.1:3000/checkout/passengers?offerId=mock-conflict-offer-id');
    await expect(page.getByRole('heading', { name: 'Passenger 1 (ADULT)' })).toBeVisible();

    // Use profile details
    const useProfileButton = page.getByRole('button', { name: 'Use my traveler profile details' });
    await expect(useProfileButton).toBeVisible();
    await useProfileButton.click();

    // Fill contact info
    const passenger1 = page.locator('.card', { hasText: 'Passenger 1 (ADULT)' });
    await passenger1.getByLabel('Email *').fill('jane@example.test');
    await passenger1.getByLabel('Phone Country Code *').fill('+1');
    await passenger1.getByLabel('Phone Number *').fill('5551234567');

    // Submit form (Attempt 1 -> 409 Conflict)
    await page.getByRole('button', { name: 'Continue to Ancillaries' }).click();

    // Verify error message rendered
    const errorBanner = page.locator('[role="alert"]');
    await expect(errorBanner).toBeVisible();
    await expect(
      page.getByText(
        'Your traveler profile changed. Review the passenger details before trying again.',
      ),
    ).toBeVisible();

    // Verify "Use my traveler profile details" button is no longer available due to stale revision
    await expect(useProfileButton).not.toBeVisible();

    // User recovers by entering passenger info inline
    await passenger1.getByLabel('Given Name *').fill('Jane');
    await passenger1.getByLabel('Family Name *').fill('Doe');
    await passenger1.getByLabel('Date of Birth *').fill('1995-05-05');
    await passenger1.getByLabel('Gender *').selectOption('female');
    await passenger1.getByLabel('Email *').fill('jane.recovered@example.test');
    await passenger1.getByLabel('Phone Country Code *').fill('+1');
    await passenger1.getByLabel('Phone Number *').fill('5559876543');

    // Submit form again (Attempt 2 -> 201 Success)
    await page.getByRole('button', { name: 'Continue to Ancillaries' }).click();

    // Verify successful progression to ancillaries
    await expect(page).toHaveURL(/.*checkout\/mock-recovered-intent-id\/ancillaries/);
  });

  // Test 4: Cookie mock error scenarios (404, 403, 410, 500)
  test('renders error screens based on mock scenarios', async ({ page, request, context }) => {
    await registerAndLoginUser(page, request, context);

    // Scenario 404: Not Found
    await context.addCookies([
      {
        name: 'mock-scenario',
        value: 'intent-not-found',
        url: 'http://127.0.0.1:3000',
      },
    ]);
    await page.goto('http://127.0.0.1:3000/checkout/some-id/ancillaries');
    await expect(page.getByRole('heading', { name: 'Booking Intent Not Found' })).toBeVisible();

    await page.goto('http://127.0.0.1:3000/checkout/some-id/review');
    await expect(page.getByRole('heading', { name: 'Booking Intent Not Found' })).toBeVisible();

    // Scenario 403: Forbidden
    await context.addCookies([
      {
        name: 'mock-scenario',
        value: 'intent-forbidden',
        url: 'http://127.0.0.1:3000',
      },
    ]);
    await page.goto('http://127.0.0.1:3000/checkout/some-id/ancillaries');
    await expect(page.getByRole('heading', { name: 'Forbidden' })).toBeVisible();

    await page.goto('http://127.0.0.1:3000/checkout/some-id/review');
    await expect(page.getByRole('heading', { name: 'Forbidden' })).toBeVisible();

    // Scenario 410: Expired
    await context.addCookies([
      {
        name: 'mock-scenario',
        value: 'intent-expired',
        url: 'http://127.0.0.1:3000',
      },
    ]);
    await page.goto('http://127.0.0.1:3000/checkout/some-id/ancillaries');
    await expect(page.getByRole('heading', { name: 'Booking Intent Expired' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Return to Search' })).toBeVisible();

    await page.goto('http://127.0.0.1:3000/checkout/some-id/review');
    await expect(page.getByRole('heading', { name: 'Booking Intent Expired' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Return to Search' })).toBeVisible();

    // Scenario 500: Service Unavailable
    await context.addCookies([
      {
        name: 'mock-scenario',
        value: 'intent-unavailable',
        url: 'http://127.0.0.1:3000',
      },
    ]);
    await page.goto('http://127.0.0.1:3000/checkout/some-id/ancillaries');
    await expect(page.getByRole('heading', { name: 'Service Unavailable' })).toBeVisible();

    await page.goto('http://127.0.0.1:3000/checkout/some-id/review');
    await expect(page.getByRole('heading', { name: 'Service Unavailable' })).toBeVisible();
  });
});
