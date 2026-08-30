import * as http from 'node:http';
import { expect, test, type Page } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import type { DashboardSummary } from '@shared/types';

const FIXTURE_PORT = 3101;
let server: http.Server | undefined;

const mockPopulatedSummary: DashboardSummary = {
  stats: {
    totalBookings: 12,
    upcomingBookings: 3,
    completedBookings: 8,
    cancelledBookings: 1,
  },
  recentBookings: [
    {
      id: '8a7466ab-78bd-4a45-8e9e-9b3c62269a91',
      status: 'CONFIRMED',
      createdAt: '2026-08-20T10:00:00.000Z',
      departureAt: '2026-09-01T08:00:00.000Z',
      originCode: 'SGN',
      destinationCode: 'HAN',
      airlineCode: 'VN',
      flightNumber: 'VN123',
    },
    {
      id: '8a7466ab-78bd-4a45-8e9e-9b3c62269a92',
      status: 'COMPLETED',
      createdAt: '2026-07-15T12:00:00.000Z',
      departureAt: '2026-08-01T14:30:00.000Z',
      originCode: 'LHR',
      destinationCode: 'JFK',
      airlineCode: 'BA',
      flightNumber: 'BA178',
    },
    {
      id: '8a7466ab-78bd-4a45-8e9e-9b3c62269a93',
      status: 'CANCELLED_AND_REFUNDED',
      createdAt: '2026-06-10T09:00:00.000Z',
      departureAt: '2026-07-01T11:00:00.000Z',
      originCode: 'NRT',
      destinationCode: 'SIN',
      airlineCode: 'SQ',
      flightNumber: 'SQ637',
    },
    {
      id: '8a7466ab-78bd-4a45-8e9e-9b3c62269a94',
      status: 'PROCESSING',
      createdAt: '2026-08-28T16:00:00.000Z',
      departureAt: '2026-09-10T19:00:00.000Z',
      originCode: 'SYD',
      destinationCode: 'MEL',
      airlineCode: 'QF',
      flightNumber: 'QF401',
    },
    {
      id: '8a7466ab-78bd-4a45-8e9e-9b3c62269a95',
      status: 'CONFIRMED',
      createdAt: '2026-08-25T08:30:00.000Z',
      departureAt: '2026-09-15T06:00:00.000Z',
      originCode: 'CDG',
      destinationCode: 'DXB',
      airlineCode: 'EK',
      flightNumber: 'EK074',
    },
  ],
  generatedAt: '2026-08-29T08:00:00.000Z',
};

const mockEmptySummary: DashboardSummary = {
  stats: {
    totalBookings: 0,
    upcomingBookings: 0,
    completedBookings: 0,
    cancelledBookings: 0,
  },
  recentBookings: [],
  generatedAt: '2026-08-29T08:00:00.000Z',
};

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();

    if (req.url?.startsWith('/api/dashboard/summary')) {
      switch (token) {
        case 'token-populated':
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(mockPopulatedSummary));
          return;
        case 'token-empty':
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(mockEmptySummary));
          return;
        case 'token-expired':
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'Unauthorized' }));
          return;
        case 'token-server-error':
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'Internal Server Error' }));
          return;
        case 'token-malformed':
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ stats: { totalBookings: -5 } }));
          return;
        default:
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'Unauthorized' }));
          return;
      }
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Not found' }));
  });

  await new Promise<void>((resolve, reject) => {
    server?.once('error', reject);
    server?.listen(FIXTURE_PORT, '127.0.0.1', () => {
      resolve();
    });
  });
});

test.afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
  }
});

async function authenticateSession(page: Page, scenarioToken: string): Promise<void> {
  const sessionToken = await encode({
    secret: process.env.NEXTAUTH_SECRET || 'test_secret',
    token: {
      sub: 'user-test-123',
      id: 'user-test-123',
      accessToken: scenarioToken,
      email: 'traveler@example.com',
      name: 'Test Traveler',
    },
  });

  await page.context().addCookies([
    {
      name: 'next-auth.session-token',
      value: sessionToken,
      url: 'http://127.0.0.1:3000',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);

  await page.route('**/api/auth/session', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: { id: 'user-test-123', email: 'traveler@example.com', name: 'Test Traveler' },
        accessToken: scenarioToken,
        expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      }),
    });
  });
}

async function setMockScenario(page: Page, scenario: string): Promise<void> {
  await page.context().addCookies([
    {
      name: 'mock-scenario',
      value: scenario,
      url: 'http://127.0.0.1:3000',
    },
  ]);
}

test.describe('Dashboard Feature Acceptance (E2E)', () => {
  test('1. Populated Dashboard Overview: renders 4 metric cards and 5 recent booking items with navigation links', async ({
    page,
  }) => {
    await authenticateSession(page, 'token-populated');
    await page.goto('/dashboard');

    await expect(page.getByText('Total Bookings')).toBeVisible();
    // Exact metric counts were user-approved on 2026-08-29 because required flight numbers contain these digit substrings.
    await expect(page.getByText('12', { exact: true })).toBeVisible();

    await expect(page.getByText('Upcoming Bookings')).toBeVisible();
    await expect(page.getByText('3', { exact: true })).toBeVisible();

    await expect(page.getByText('Completed Bookings')).toBeVisible();
    await expect(page.getByText('8', { exact: true })).toBeVisible();

    await expect(page.getByText('Cancelled Bookings')).toBeVisible();
    await expect(page.getByText('1', { exact: true })).toBeVisible();

    await expect(page.getByText('SGN').first()).toBeVisible();
    await expect(page.getByText('HAN').first()).toBeVisible();
    await expect(page.getByText('VN123')).toBeVisible();

    await expect(page.getByText('LHR').first()).toBeVisible();
    await expect(page.getByText('JFK').first()).toBeVisible();
    await expect(page.getByText('BA178')).toBeVisible();

    await expect(page.getByText('NRT').first()).toBeVisible();
    await expect(page.getByText('SIN').first()).toBeVisible();
    await expect(page.getByText('SQ637')).toBeVisible();

    await expect(page.getByText('SYD').first()).toBeVisible();
    await expect(page.getByText('MEL').first()).toBeVisible();
    await expect(page.getByText('QF401')).toBeVisible();

    await expect(page.getByText('CDG').first()).toBeVisible();
    await expect(page.getByText('DXB').first()).toBeVisible();
    await expect(page.getByText('EK074')).toBeVisible();

    const bookingLink = page
      .locator('a[href*="/bookings/8a7466ab-78bd-4a45-8e9e-9b3c62269a91"]')
      .first();
    await expect(bookingLink).toBeVisible();

    const allBookingsLink = page.locator('a[href="/bookings"]').first();
    await expect(allBookingsLink).toBeVisible();
  });

  test('2. Empty Dashboard State: renders 0 metrics, empty state message, and Search Flights CTA', async ({
    page,
  }) => {
    await authenticateSession(page, 'token-empty');
    await page.goto('/dashboard');

    await expect(page.getByText('Total Bookings')).toBeVisible();
    await expect(page.getByText('Upcoming Bookings')).toBeVisible();
    await expect(page.getByText('Completed Bookings')).toBeVisible();
    await expect(page.getByText('Cancelled Bookings')).toBeVisible();

    const zeroMetrics = page.getByText('0');
    await expect(zeroMetrics.first()).toBeVisible();

    await expect(page.getByText(/no bookings/i).first()).toBeVisible();
    const searchFlightsCta = page.getByRole('link', { name: /search flights/i }).first();
    await expect(searchFlightsCta).toBeVisible();
    await expect(searchFlightsCta).toHaveAttribute('href', '/search');
  });

  test('3. Zero-Mock Assertion (Anti-Prototype Guardrail): verifies no prototype controls or fake claims exist', async ({
    page,
  }) => {
    await authenticateSession(page, 'token-populated');
    await page.goto('/dashboard');

    await expect(page.getByText(/disruption shield/i)).toHaveCount(0);
    await expect(page.getByText(/shield protection/i)).toHaveCount(0);
    await expect(page.getByText(/88%/)).toHaveCount(0);

    await expect(page.getByText(/fare.?drop/i)).toHaveCount(0);

    await expect(page.getByText(/seat recommendation/i)).toHaveCount(0);
    await expect(page.getByText(/recommended seat/i)).toHaveCount(0);

    await expect(page.getByText(/wayfinder prototype/i)).toHaveCount(0);
    await expect(page.getByText(/prototype mode/i)).toHaveCount(0);
    await expect(page.getByText(/this is a prototype/i)).toHaveCount(0);

    await expect(page.getByText(/variant switcher/i)).toHaveCount(0);
    await expect(page.getByText(/switch variant/i)).toHaveCount(0);

    await expect(page.locator('a[href^="/prototype"], a[href*="/prototype/"]')).toHaveCount(0);
  });

  test('4. Direct Dashboard Unauthenticated Access: redirects anonymous user to login page preserving callbackUrl', async ({
    page,
    context,
  }) => {
    await context.clearCookies();
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login\?callbackUrl=(%2F|\/)dashboard/);
  });

  test('5. Expired Session Redirect: redirects user with expired backend token to login page with callbackUrl', async ({
    page,
  }) => {
    await authenticateSession(page, 'token-expired');
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login\?callbackUrl=(%2F|\/)dashboard/);
  });

  test('6. Root Entry Redirection - Authenticated: redirects authenticated traveler from / to /dashboard', async ({
    page,
  }) => {
    await authenticateSession(page, 'token-populated');
    await page.goto('/');
    await expect(page).toHaveURL(/\/dashboard\/?$/);
  });

  test('7. Root Entry Redirection - Anonymous: preserves marketing landing page on / for anonymous visitor', async ({
    page,
    context,
  }) => {
    await context.clearCookies();
    await page.goto('/');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText(/From “I need to go” to cleared for takeoff/i)).toBeVisible();
  });

  test('8. Upstream API Failure Recovery: renders safe error boundary on 500 server error with zero secret leakage', async ({
    page,
  }) => {
    await authenticateSession(page, 'token-server-error');
    await page.goto('/dashboard');

    await expect(page.getByRole('heading', { name: /Unable to load dashboard/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Try Again/i })).toBeVisible();

    const pageText = await page.innerText('body');
    expect(pageText).not.toContain('token-server-error');
    expect(pageText).not.toContain('Internal Server Error');
    expect(pageText).not.toContain('3101');
  });

  test('9. Upstream Malformed Response Recovery: renders error boundary on invalid payload with zero raw data leakage', async ({
    page,
  }) => {
    await authenticateSession(page, 'token-malformed');
    await page.goto('/dashboard');

    await expect(page.getByRole('heading', { name: /Unable to load dashboard/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Try Again/i })).toBeVisible();

    const pageText = await page.innerText('body');
    expect(pageText).not.toContain('token-malformed');
    expect(pageText).not.toContain('totalBookings');
  });

  test('10. Viewport Geometry: renders without horizontal overflow across mobile, tablet, and desktop', async ({
    page,
  }) => {
    await authenticateSession(page, 'token-populated');

    const viewports = [
      { name: 'Mobile (360x800)', width: 360, height: 800 },
      { name: 'Tablet (768x1024)', width: 768, height: 1024 },
      { name: 'Desktop (1280x800)', width: 1280, height: 800 },
    ];

    for (const vp of viewports) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/dashboard');
      const hasOverflow = await page.evaluate(() => {
        return document.documentElement.scrollWidth > document.documentElement.clientWidth;
      });
      expect(hasOverflow).toBe(false);
    }
  });

  test('11. Landmark & Keyboard Focus Traversal: verifies landmarks and keyboard tabbing through interactive elements', async ({
    page,
  }) => {
    await authenticateSession(page, 'token-populated');
    await page.goto('/dashboard');

    await expect(page.locator('main')).toBeVisible();

    await page.keyboard.press('Tab');
    const focusedTag = await page.evaluate(() => document.activeElement?.tagName);
    expect(focusedTag).toBeTruthy();
    expect(focusedTag).not.toBe('BODY');

    const interactiveCount = await page.evaluate(() => {
      const focusable = document.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      return focusable.length;
    });
    expect(interactiveCount).toBeGreaterThan(0);
  });

  test('12. Reduced Motion Accessibility: enforces instant or bounded animations when reduced motion is preferred', async ({
    page,
  }) => {
    await authenticateSession(page, 'token-populated');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/dashboard');

    const motionDurations = await page.evaluate(() => {
      const elements = Array.from(
        document.querySelectorAll('article, a[href], button:not([disabled])'),
      );
      return elements.map((el) => {
        const style = window.getComputedStyle(el);
        return {
          animationDuration: style.animationDuration,
          transitionDuration: style.transitionDuration,
        };
      });
    });

    const parseSeconds = (dur: string): number => {
      if (!dur || dur === 'none') return 0;
      if (dur.endsWith('ms')) return parseFloat(dur) / 1000;
      if (dur.endsWith('s')) return parseFloat(dur);
      return parseFloat(dur) || 0;
    };

    expect(motionDurations.length).toBeGreaterThan(0);
    for (const motion of motionDurations) {
      expect(parseSeconds(motion.animationDuration)).toBeLessThanOrEqual(0.01);
      expect(parseSeconds(motion.transitionDuration)).toBeLessThanOrEqual(0.01);
    }
  });

  test('13. Quick Search: submits airport and date inputs to the production search route with defaults', async ({
    page,
  }) => {
    await authenticateSession(page, 'token-populated');
    await page.goto('/dashboard');

    await page.getByLabel('Departure airport code').fill('SGN');
    await page.getByLabel('Arrival airport code').fill('HAN');
    await page.getByLabel('Departure date').fill('2099-09-01');
    await page.getByLabel('Departure date').press('Enter');

    await expect(page).toHaveURL(/\/search/);
    const searchParams = new URL(page.url()).searchParams;
    expect(new URL(page.url()).pathname).toBe('/search');
    expect(searchParams.get('origin')).toBe('SGN');
    expect(searchParams.get('destination')).toBe('HAN');
    expect(searchParams.get('departureDate')).toBe('2099-09-01');
    expect(searchParams.get('adults')).toBe('1');
    expect(searchParams.get('cabinClass')).toBe('economy');
  });

  test('14. Quick Search: does not navigate for matching airport inputs', async ({ page }) => {
    await authenticateSession(page, 'token-populated');
    await page.goto('/dashboard');

    await page.getByLabel('Departure airport code').fill('SGN');
    await page.getByLabel('Arrival airport code').fill('sgn');
    await page.getByLabel('Departure date').fill('2099-09-01');
    await page.getByLabel('Departure date').press('Enter');

    await expect(page).toHaveURL(/\/dashboard\/?$/);
  });

  test('15. Quick Search: does not navigate for a past departure date', async ({ page }) => {
    await authenticateSession(page, 'token-populated');
    await page.goto('/dashboard');

    await page.getByLabel('Departure airport code').fill('SGN');
    await page.getByLabel('Arrival airport code').fill('HAN');
    await page.getByLabel('Departure date').fill('2000-01-01');
    await page.getByLabel('Departure date').press('Enter');

    await expect(page).toHaveURL(/\/dashboard\/?$/);
  });

  test('16. Quick Action Search Flights: navigates to search', async ({ page }) => {
    await authenticateSession(page, 'token-populated');
    await page.goto('/dashboard');

    const quickActions = page.getByRole('region', { name: 'Quick Actions' });
    const action = quickActions.getByRole('link', { name: 'Search Flights' });
    await action.focus();
    await expect(action).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/\/search$/);
  });

  test('17. Quick Action Upcoming Trips: navigates to upcoming bookings', async ({ page }) => {
    await authenticateSession(page, 'token-populated');
    await page.goto('/dashboard');

    const quickActions = page.getByRole('region', { name: 'Quick Actions' });
    const action = quickActions.getByRole('link', { name: 'Upcoming Trips' });
    await action.focus();
    await expect(action).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/\/bookings\?tab=upcoming$/);
  });

  test('18. Quick Action Past Bookings: navigates to past bookings', async ({ page }) => {
    await authenticateSession(page, 'token-populated');
    await page.goto('/dashboard');

    const quickActions = page.getByRole('region', { name: 'Quick Actions' });
    const action = quickActions.getByRole('link', { name: 'Past Bookings' });
    await action.focus();
    await expect(action).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/\/bookings\?tab=past$/);
  });

  test('19. Traveler Profile disabled: omits the profile action', async ({ page }) => {
    await authenticateSession(page, 'token-populated');
    await setMockScenario(page, 'dashboard-readiness-disabled');
    await page.goto('/dashboard');

    const quickActions = page.getByRole('region', { name: 'Quick Actions' });
    await expect(quickActions.getByRole('link', { name: 'Search Flights' })).toBeVisible();
    await expect(quickActions.getByRole('link', { name: 'Upcoming Trips' })).toBeVisible();
    await expect(quickActions.getByRole('link', { name: 'Past Bookings' })).toBeVisible();
    await expect(quickActions.getByRole('link', { name: 'Traveler Profile' })).toHaveCount(0);
  });

  test('20. Traveler Profile enabled: exposes the profile action', async ({ page }) => {
    await authenticateSession(page, 'token-populated');
    await setMockScenario(page, 'dashboard-readiness-enabled');
    await page.goto('/dashboard');

    const quickActions = page.getByRole('region', { name: 'Quick Actions' });
    const profileAction = quickActions.getByRole('link', { name: 'Traveler Profile' });
    await expect(profileAction).toBeVisible();
    await expect(profileAction).toHaveAttribute('href', '/profile');
  });
});
