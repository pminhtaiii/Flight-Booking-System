import { expect, test, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const bookingId = '8a7466ab-78bd-4a45-8e9e-9b3c62269a9a';
const revisionId = '9b8577bc-89cd-5b56-9f0f-0c4d73370b0b';

async function authenticateClientSession(page: Page) {
  await page.route('**/api/auth/session', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: { id: 'user-char-123', email: 'traveler-char@example.com' },
        accessToken: 'char-test-access-token',
        expires: '2099-01-01T00:00:00.000Z',
      }),
    });
  });
}

test.describe('Booking Seam Characterization - User Flows', () => {
  test.slow();

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const style = document.createElement('style');
      style.textContent = 'aside[aria-label="Agent chat"] { display: none !important; }';
      if (document.head) {
        document.head.appendChild(style);
      } else {
        document.addEventListener('DOMContentLoaded', () => document.head?.appendChild(style));
      }
    });
  });

  test('unauthenticated users navigating to booking details are redirected to /login', async ({
    page,
    context,
  }) => {
    await context.clearCookies();
    await page.goto(`/bookings/${bookingId}`, { waitUntil: 'commit' });
    await expect(page).toHaveURL(/.*\/login/);
  });

  test('renders confirmed booking details with PNR, flight segments, passengers, and payment summary', async ({
    page,
    context,
  }) => {
    await context.addCookies([
      {
        name: 'mock-scenario',
        value: 'confirmed-booking',
        domain: '127.0.0.1',
        path: '/',
      },
    ]);

    await page.goto(`/bookings/${bookingId}`);

    await expect(page.getByRole('heading', { name: 'Flight details' })).toBeVisible();
    await expect(page.getByText('PNR: PNR123')).toBeVisible();
    await expect(page.getByText('Example Air EA101')).toBeVisible();
    await expect(page.getByText(/London \(LHR\) to New York \(JFK\)/)).toBeVisible();
    await expect(page.getByText('Ada Lovelace')).toBeVisible();
    await expect(page.getByText('Total paid: £499.00')).toBeVisible();

    // Confirmation banner must NOT be rendered when query is absent
    await expect(page.getByRole('heading', { name: 'Booking confirmed' })).toHaveCount(0);
  });

  test('renders booking confirmation banner when confirmed=true query is present', async ({
    page,
    context,
  }) => {
    await context.addCookies([
      {
        name: 'mock-scenario',
        value: 'confirmed-booking',
        domain: '127.0.0.1',
        path: '/',
      },
    ]);

    await page.goto(`/bookings/${bookingId}?confirmed=true`);

    await expect(page.getByRole('heading', { name: 'Booking confirmed' })).toBeVisible();
    await expect(page.getByText('PNR123').first()).toBeVisible();
  });

  test('renders processing booking state when booking status is PROCESSING', async ({
    page,
    context,
  }) => {
    await context.addCookies([
      {
        name: 'mock-scenario',
        value: 'processing-booking',
        domain: '127.0.0.1',
        path: '/',
      },
    ]);

    await page.goto(`/bookings/${bookingId}`);

    await expect(page.getByRole('heading', { name: 'Your booking is being processed' })).toBeVisible();
    await expect(page.getByText('Please refresh this page shortly to check its status.')).toBeVisible();
  });

  test('renders disruption alert and handles acknowledge action', async ({ page, context }) => {
    let ackCalled = false;
    let authHeaderValue: string | null = null;

    await authenticateClientSession(page);

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
        authHeaderValue = route.request().headers()['authorization'] || null;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            bookingId,
            activeRevisionId: revisionId,
            disruptionStatus: 'ACKNOWLEDGED',
          }),
        });
      },
    );

    const sessionPromise = page.waitForResponse((res) => res.url().includes('/api/auth/session'));
    await page.goto(`/bookings/${bookingId}`);
    await sessionPromise;

    // Disruption Alert & Summary checks
    await expect(page.getByText('Flight Disruption Detected')).toBeVisible();
    await expect(page.getByText('Departure time moved later by more than 2 hours').first()).toBeVisible();
    await expect(page.getByText('Schedule Instability Alert')).toBeVisible();
    await expect(page.getByText('Review Required')).toBeVisible();

    const ackButton = page.getByRole('button', { name: 'I understand' });
    await expect(ackButton).toBeVisible();
    await ackButton.click();

    expect(ackCalled).toBe(true);
    expect(authHeaderValue).toBe('Bearer char-test-access-token');
  });

  test('renders disruption alert and handles accept action', async ({ page, context }) => {
    let acceptCalled = false;
    let authHeaderValue: string | null = null;

    await authenticateClientSession(page);

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
        authHeaderValue = route.request().headers()['authorization'] || null;
        await route.fulfill({
          status: 200,
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

    const sessionPromise = page.waitForResponse((res) => res.url().includes('/api/auth/session'));
    await page.goto(`/bookings/${bookingId}`);
    await sessionPromise;

    const acceptButton = page.getByRole('button', { name: 'Accept current itinerary' });
    await expect(acceptButton).toBeVisible();
    await acceptButton.click();

    expect(acceptCalled).toBe(true);
    expect(authHeaderValue).toBe('Bearer char-test-access-token');
  });

  test('handles 409 conflict during disruption action gracefully', async ({ page, context }) => {
    await authenticateClientSession(page);

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
            activeRevisionId: 'new-revision-id-456',
            disruptionStatus: 'DETECTED',
          }),
        });
      },
    );

    const sessionPromise = page.waitForResponse((res) => res.url().includes('/api/auth/session'));
    await page.goto(`/bookings/${bookingId}`);
    await sessionPromise;

    // Wait for the booking detail and disruption review section to mount
    await expect(page.getByText('Review Required')).toBeVisible();

    const ackButton = page.getByRole('button', { name: 'I understand' });
    await expect(ackButton).toBeVisible();
    await ackButton.click();

    await expect(page.getByText('A newer change exists and must be reviewed.')).toBeVisible();
  });

  test('renders cancellation review modal and completes cancellation flow', async ({
    page,
    context,
  }) => {
    await authenticateClientSession(page);

    let quoteRequested = false;
    let cancelRequested = false;
    let capturedCancelPayload: { quoteId?: string } | null = null;

    await context.addCookies([
      {
        name: 'mock-scenario',
        value: 'disruption-detected',
        domain: '127.0.0.1',
        path: '/',
      },
    ]);

    await page.route(`**/api/bookings/${bookingId}/cancellation-quote`, async (route) => {
      quoteRequested = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          quoteId: 'quote-char-789',
          refundAmount: '450.00',
          currency: 'GBP',
          refundTo: 'Original Payment Card (•••• 4242)',
          nonRefundableAncillaryAmount: '49.00',
          nonRefundableAncillaryCurrency: 'GBP',
        }),
      });
    });

    await page.route(`**/api/bookings/${bookingId}/cancel`, async (route) => {
      cancelRequested = true;
      capturedCancelPayload = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          bookingId,
          bookingStatus: 'CANCELLATION_PENDING',
        }),
      });
    });

    const sessionPromise = page.waitForResponse((res) => res.url().includes('/api/auth/session'));
    await page.goto(`/bookings/${bookingId}`);
    await sessionPromise;

    // Click "Cancel booking" button
    const cancelBookingButton = page.getByRole('button', { name: 'Cancel booking' });
    await expect(cancelBookingButton).toBeVisible();
    await cancelBookingButton.click();

    // Verify modal elements
    await expect(page.getByRole('heading', { name: 'Cancel Booking' })).toBeVisible();
    await expect(page.getByText('Total Paid:', { exact: true })).toBeVisible();
    await expect(page.getByText('Refund Amount:')).toBeVisible();
    await expect(page.getByText('£450.00')).toBeVisible();
    await expect(page.getByText('Penalty / Fees:')).toBeVisible();
    await expect(page.getByText('Refund Destination:')).toBeVisible();
    await expect(page.getByText('Original Payment Card (•••• 4242)')).toBeVisible();
    await expect(page.getByText('Non-refundable Extras:')).toBeVisible();

    const confirmCancelButton = page.getByRole('button', { name: 'Confirm Cancellation' });
    await expect(confirmCancelButton).toBeDisabled();

    // Check acknowledgment checkbox
    await page.getByRole('checkbox').check();
    await expect(confirmCancelButton).toBeEnabled();

    // Submit cancellation
    await confirmCancelButton.click();

    expect(quoteRequested).toBe(true);
    expect(cancelRequested).toBe(true);
    expect(capturedCancelPayload?.quoteId).toBe('quote-char-789');
  });
});

test.describe('Booking Seam Characterization - Static Baseline Metrics', () => {
  function scanDirectory(dirPath: string): Array<{ filePath: string; content: string }> {
    const files: Array<{ filePath: string; content: string }> = [];
    if (!fs.existsSync(dirPath)) return files;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        files.push(...scanDirectory(fullPath));
      } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
        files.push({ filePath: fullPath, content: fs.readFileSync(fullPath, 'utf8') });
      }
    }
    return files;
  }

  test('asserts baseline metrics and pattern occurrences across booking management files', () => {
    const bookingsAppDir = path.resolve(__dirname, '../../app/bookings');
    const bookingsComponentsDir = path.resolve(__dirname, '../../components/bookings');

    const appFiles = scanDirectory(bookingsAppDir);
    const componentFiles = scanDirectory(bookingsComponentsDir);
    const allBookingFiles = [...appFiles, ...componentFiles];

    expect(allBookingFiles.length).toBeGreaterThanOrEqual(10);

    let useSessionMatches = 0;
    let accessTokenMatches = 0;
    let nextPublicApiUrlMatches = 0;
    let directFetchMatches = 0;

    for (const { content } of allBookingFiles) {
      const sessionMatches = content.match(/useSession/g);
      if (sessionMatches) useSessionMatches += sessionMatches.length;

      const tokenMatches = content.match(/accessToken/g);
      if (tokenMatches) accessTokenMatches += tokenMatches.length;

      const apiUrlMatches = content.match(/NEXT_PUBLIC_API_URL/g);
      if (apiUrlMatches) nextPublicApiUrlMatches += apiUrlMatches.length;

      const fetchMatches = content.match(/fetch\(/g);
      if (fetchMatches) directFetchMatches += fetchMatches.length;
    }

    // Baseline assertions for Slice 0 safety rails
    expect(useSessionMatches).toBe(2);
    expect(accessTokenMatches).toBe(32);
    expect(nextPublicApiUrlMatches).toBe(8);
    expect(directFetchMatches).toBe(8);
  });
});
