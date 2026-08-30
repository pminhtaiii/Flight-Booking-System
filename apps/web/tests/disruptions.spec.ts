import { expect, test } from '@playwright/test';

const bookingId = '8a7466ab-78bd-4a45-8e9e-9b3c62269a9a';
const revisionId = '9b8577bc-89cd-5b56-9f0f-0c4d73370b0b';

async function authenticate(page: import('@playwright/test').Page) {
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

test.describe('Traveller Disruption Experience', () => {
  test.beforeEach(async ({ page }) => {
    await authenticate(page);
  });

  test('renders original vs revised segments and disruption details', async ({ page, context }) => {
    await context.addCookies([
      {
        name: 'mock-scenario',
        value: 'disruption-detected',
        domain: '127.0.0.1',
        path: '/',
      },
    ]);

    await page.route(`**/api/bookings/${bookingId}/disruptions?page=1&limit=5`, async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              revisionId,
              version: 1,
              observedAt: '2026-07-25T10:00:00.000Z',
              isMaterial: true,
              materialReasons: ['DEPARTURE_MOVED_LATER'],
              segments: [
                {
                  airline: { name: 'Revised Air', iataCode: 'RA' },
                  flightNumber: 'RA202',
                  departureAirport: { iataCode: 'LHR', name: 'Heathrow', city: 'London' },
                  arrivalAirport: { iataCode: 'JFK', name: 'John F. Kennedy', city: 'New York' },
                  departureAt: '2026-08-01T13:00:00.000Z',
                  arrivalAt: '2026-08-01T21:00:00.000Z',
                  duration: 'PT8H',
                },
              ],
            },
          ],
          page: 1,
          limit: 5,
          total: 1,
          totalPages: 1,
        }),
      });
    });

    await page.goto(`/bookings/${bookingId}`);

    // Disruption Alert & Accessibility checks
    await expect(page.locator('[role="alert"]').first()).toBeVisible();
    await expect(page.getByText('Flight Disruption Detected')).toBeVisible();
    await expect(
      page.getByText('Departure time moved later by more than 2 hours').first(),
    ).toBeVisible();
    await expect(page.getByText('Schedule Instability Alert')).toBeVisible();

    // Itinerary change summary checks
    await expect(page.getByText('Itinerary Change Summary')).toBeVisible();
    await expect(page.getByText('Latest Changes (This Update)')).toBeVisible();
    await expect(page.getByText('+4h').first()).toBeVisible();

    // Verify current itinerary segments are shown, not original
    await expect(page.getByText('Revised Air RA202')).toBeVisible();
    await expect(page.getByText('Original Air OA101')).toHaveCount(0);

    // Timeline check
    await expect(page.getByText('Itinerary Revision History')).toBeVisible();
    await expect(page.getByText('Version 1')).toBeVisible();
  });

  test('supports Acknowledge action and refreshes state', async ({ page, context }) => {
    let ackCalled = false;

    await context.addCookies([
      {
        name: 'mock-scenario',
        value: 'disruption-detected',
        domain: '127.0.0.1',
        path: '/',
      },
    ]);

    await page.route(
      `**/api/bookings/${bookingId}/disruptions/${revisionId}/acknowledge`,
      async (route) => {
        ackCalled = true;
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            bookingId,
            activeRevisionId: revisionId,
            disruptionStatus: 'ACKNOWLEDGED',
          }),
        });
      },
    );

    await page.goto(`/bookings/${bookingId}`);

    const ackButton = page.getByRole('button', { name: 'I understand' });
    await expect(ackButton).toBeVisible();
    await ackButton.click();

    expect(ackCalled).toBe(true);
  });

  test('supports Accept action and refreshes state', async ({ page, context }) => {
    let acceptCalled = false;

    await context.addCookies([
      {
        name: 'mock-scenario',
        value: 'disruption-acknowledged',
        domain: '127.0.0.1',
        path: '/',
      },
    ]);

    await page.route(
      `**/api/bookings/${bookingId}/disruptions/${revisionId}/accept`,
      async (route) => {
        acceptCalled = true;
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            bookingId,
            activeRevisionId: revisionId,
            disruptionStatus: 'RESOLVED',
            resolvedReason: 'TRAVELLER_ACCEPTED',
          }),
        });
      },
    );

    await page.goto(`/bookings/${bookingId}`);

    const acceptButton = page.getByRole('button', { name: 'Accept current itinerary' });
    await expect(acceptButton).toBeVisible();
    await acceptButton.click();

    expect(acceptCalled).toBe(true);
  });

  test('handles 409 Conflict during action gracefully', async ({ page, context }) => {
    await context.addCookies([
      {
        name: 'mock-scenario',
        value: 'disruption-detected',
        domain: '127.0.0.1',
        path: '/',
      },
    ]);

    await page.route(
      `**/api/bookings/${bookingId}/disruptions/${revisionId}/acknowledge`,
      async (route) => {
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'STALE_DISRUPTION_REVISION',
            activeRevisionId: 'new-revision-id',
            disruptionStatus: 'DETECTED',
          }),
        });
      },
    );

    await page.goto(`/bookings/${bookingId}`);
    await page.getByRole('button', { name: 'I understand' }).click();

    await expect(page.getByText('A newer change exists and must be reviewed.')).toBeVisible();
  });

  test('coexists with cancellation option', async ({ page, context }) => {
    await context.addCookies([
      {
        name: 'mock-scenario',
        value: 'disruption-detected',
        domain: '127.0.0.1',
        path: '/',
      },
    ]);

    await page.goto(`/bookings/${bookingId}`);

    // Cancellation button remains visible
    await expect(page.getByRole('button', { name: 'Cancel booking' })).toBeVisible();
  });
});
