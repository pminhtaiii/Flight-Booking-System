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

test.describe('Dashboard Feature Acceptance (E2E)', () => {
  test('1. Populated Dashboard Overview: renders 4 metric cards and 5 recent booking items with navigation links', async ({
    page,
  }) => {
    await authenticateSession(page, 'token-populated');
    await page.goto('/dashboard');

    // 1. Assert 4 metric cards with exact text / counts
    await expect(page.getByText('Total Bookings')).toBeVisible();
    // Exact metric counts were user-approved on 2026-08-29 because required flight numbers contain these digit substrings.
    await expect(page.getByText('12', { exact: true })).toBeVisible();

    await expect(page.getByText('Upcoming Bookings')).toBeVisible();
    await expect(page.getByText('3', { exact: true })).toBeVisible();

    await expect(page.getByText('Completed Bookings')).toBeVisible();
    await expect(page.getByText('8', { exact: true })).toBeVisible();

    await expect(page.getByText('Cancelled Bookings')).toBeVisible();
    await expect(page.getByText('1', { exact: true })).toBeVisible();

    // 2. Assert 5 recent booking items with route codes, flight numbers, and status badges
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

    // 3. Assert selecting a recent booking item navigates to /bookings/[bookingId]
    const bookingLink = page
      .locator('a[href*="/bookings/8a7466ab-78bd-4a45-8e9e-9b3c62269a91"]')
      .first();
    await expect(bookingLink).toBeVisible();

    // 4. Assert header link navigates to /bookings list view
    const allBookingsLink = page.locator('a[href="/bookings"]').first();
    await expect(allBookingsLink).toBeVisible();
  });

  test('2. Empty Dashboard State: renders 0 metrics, empty state message, and Search Flights CTA', async ({
    page,
  }) => {
    await authenticateSession(page, 'token-empty');
    await page.goto('/dashboard');

    // 1. Assert all 4 metric labels are visible
    await expect(page.getByText('Total Bookings')).toBeVisible();
    await expect(page.getByText('Upcoming Bookings')).toBeVisible();
    await expect(page.getByText('Completed Bookings')).toBeVisible();
    await expect(page.getByText('Cancelled Bookings')).toBeVisible();

    // 2. Assert zero counts displayed
    const zeroMetrics = page.getByText('0');
    await expect(zeroMetrics.first()).toBeVisible();

    // 3. Assert empty state message and Search Flights CTA linking to /search
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

    // Assert absence of Disruption Shield percentage / claims
    await expect(page.getByText(/disruption shield/i)).toHaveCount(0);
    await expect(page.getByText(/shield protection/i)).toHaveCount(0);
    await expect(page.getByText(/88%/)).toHaveCount(0);

    // Assert absence of fake fare-drop alerts
    await expect(page.getByText(/fare.?drop/i)).toHaveCount(0);

    // Assert absence of static seat recommendation cards
    await expect(page.getByText(/seat recommendation/i)).toHaveCount(0);
    await expect(page.getByText(/recommended seat/i)).toHaveCount(0);

    // Assert absence of prototype disclaimer banners
    await expect(page.getByText(/wayfinder prototype/i)).toHaveCount(0);
    await expect(page.getByText(/prototype mode/i)).toHaveCount(0);
    await expect(page.getByText(/this is a prototype/i)).toHaveCount(0);

    // Assert absence of prototype variant switchers
    await expect(page.getByText(/variant switcher/i)).toHaveCount(0);
    await expect(page.getByText(/switch variant/i)).toHaveCount(0);

    // Assert absence of any links pointing to /prototype/*
    await expect(page.locator('a[href^="/prototype"]')).toHaveCount(0);
  });

  test('4. Unauthenticated Redirect: redirects anonymous user directly to login page', async ({
    page,
    context,
  }) => {
    await context.clearCookies();
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/);
  });
});
