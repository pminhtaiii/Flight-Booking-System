import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import * as path from 'node:path';
import { encode } from 'next-auth/jwt';

const flightSearchFixtureUrl = process.env.FLIGHT_SEARCH_FIXTURE_API_URL || 'http://127.0.0.1:3101';
const fixtureRequests: Array<{ method: string; pathname: string }> = [];
let fixtureServer: Server | undefined;

const searchFixtureOffer = {
  id: 'char-offer-book-123',
  duffelOfferId: 'off_char_book_123',
  airline: 'Mock Pacific',
  flightNumber: 'MP100',
  departureAirport: 'LAX',
  arrivalAirport: 'NRT',
  departureTime: '2026-12-01T10:00:00.000Z',
  arrivalTime: '2026-12-02T15:00:00.000Z',
  duration: 660,
  stops: 0,
  price: 750,
  currency: 'USD',
  fareClass: 'M',
  baggageAllowance: '1 checked bag',
  requestedCabinClass: 'economy',
  cabinClassMatch: 'full',
  cabinMismatchDetails: null,
  segments: [
    {
      carrierCode: 'MP',
      flightNumber: '100',
      operatingCarrier: 'Mock Pacific',
      departureAirport: 'LAX',
      departureTerminal: null,
      departureTime: '2026-12-01T10:00:00.000Z',
      arrivalAirport: 'NRT',
      arrivalTerminal: null,
      arrivalTime: '2026-12-02T15:00:00.000Z',
      duration: 660,
      aircraft: null,
      cabinClass: 'economy',
    },
  ],
  returnSegments: null,
};

async function startFlightSearchFixture(): Promise<void> {
  const fixtureUrl = new URL(flightSearchFixtureUrl);
  if (!['127.0.0.1', 'localhost'].includes(fixtureUrl.hostname) || !fixtureUrl.port) {
    throw new Error('FLIGHT_SEARCH_FIXTURE_API_URL must target a local port.');
  }

  const server = createServer((request, response) => {
    const pathname = new URL(request.url || '/', flightSearchFixtureUrl).pathname;
    if (pathname.startsWith('/api/flights')) {
      fixtureRequests.push({ method: request.method || 'GET', pathname });
    }
    response.setHeader('Content-Type', 'application/json');

    if (request.method === 'POST' && pathname === '/api/flights/search') {
      response.end(JSON.stringify({ results: [searchFixtureOffer] }));
      return;
    }

    if (request.method === 'GET' && pathname === `/api/flights/${searchFixtureOffer.id}`) {
      response.end(
        JSON.stringify({
          ...searchFixtureOffer,
          originalPrice: 750,
          confirmedPrice: 750,
          priceChanged: false,
          adults: 1,
          children: 0,
          infants: 0,
          passengers: [{ id: 'char-passenger-1', type: 'ADULT' }],
        }),
      );
      return;
    }

    if (request.method === 'GET' && pathname === '/api/profile') {
      response.end(JSON.stringify(null));
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ message: 'Fixture route not found.' }));
  });
  fixtureServer = server;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(fixtureUrl.port), fixtureUrl.hostname, resolve);
  });
}

async function stopFlightSearchFixture(): Promise<void> {
  const server = fixtureServer;
  if (!server) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  fixtureServer = undefined;
}

async function authenticateSearchSession(context: BrowserContext): Promise<void> {
  const sessionToken = await encode({
    secret: process.env.NEXTAUTH_SECRET || 'test_secret',
    token: {
      sub: 'user-search-char-123',
      id: 'user-search-char-123',
      accessToken: 'char-test-access-token',
      name: 'Search Characterization Traveler',
      email: 'search-char@example.com',
    },
  });
  await context.addCookies([
    {
      name: 'next-auth.session-token',
      value: sessionToken,
      url: 'http://127.0.0.1:3000',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
}

async function hideAgentChat(page: Page): Promise<void> {
  await page
    .addStyleTag({ content: 'aside[aria-label="Agent chat"] { display: none !important; }' })
    .catch(() => {});
}

test.describe('Search Seam Characterization - User Flows', () => {
  test.slow();

  test.beforeAll(startFlightSearchFixture);
  test.afterAll(stopFlightSearchFixture);

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

  test('unauthenticated users navigating to /search are redirected to /login', async ({
    page,
    context,
  }) => {
    await context.clearCookies();
    await page.goto('/search');
    await expect(page).toHaveURL(/.*\/login/);
  });

  test('renders search form elements with required inputs and default values', async ({
    page,
    context,
  }) => {
    await authenticateSearchSession(context);
    await page.goto('/search');
    await hideAgentChat(page);

    await expect(page.getByRole('heading', { name: 'Search Flights' })).toBeVisible();
    await expect(
      page.getByText('Find and compare flight offers for your next destination.'),
    ).toBeVisible();
    await expect(page.getByLabel('Origin (IATA)')).toHaveAttribute('required', '');
    await expect(page.getByLabel('Origin (IATA)')).toHaveAttribute('maxLength', '3');
    await expect(page.getByLabel('Origin (IATA)')).toHaveAttribute('placeholder', 'e.g. JFK');
    await expect(page.getByLabel('Destination (IATA)')).toHaveAttribute('required', '');
    await expect(page.getByLabel('Destination (IATA)')).toHaveAttribute('maxLength', '3');
    await expect(page.getByLabel('Destination (IATA)')).toHaveAttribute('placeholder', 'e.g. LHR');
    await expect(page.getByLabel('Departure Date')).toHaveAttribute('required', '');
    await expect(page.getByLabel('Cabin Class')).toHaveValue('economy');
    await expect(page.getByLabel('Adults')).toHaveValue('1');
    await expect(page.getByLabel('Children')).toHaveValue('0');
    await expect(page.getByLabel('Infants')).toHaveValue('0');
    await expect(page.getByRole('button', { name: 'Search Flights' })).toBeVisible();
    await expect(
      page.getByText('No flight offers search results yet. Enter search criteria and search.'),
    ).toBeVisible();
  });

  test('submits invalid criteria through a same-origin Server Action', async ({
    page,
    context,
  }) => {
    await authenticateSearchSession(context);
    const actionRequests: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.headers()['next-action'])
        actionRequests.push(request.url());
    });

    await page.goto('/search');
    await hideAgentChat(page);
    await page.getByLabel('Origin (IATA)').fill('JFK');
    await page.getByLabel('Destination (IATA)').fill('JFK');
    await page.getByLabel('Departure Date').fill('2026-12-01');
    await page.getByRole('button', { name: 'Search Flights' }).click();

    await expect(page.locator('[role="alert"]').first()).toBeVisible();
    await expect(page.getByText('Search Error')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Search Flights' })).toBeEnabled();
    expect(actionRequests).toEqual(['http://127.0.0.1:3000/search']);
  });

  test('searches and selects an offer through the API_URL server fixture', async ({
    page,
    context,
  }) => {
    await authenticateSearchSession(context);
    fixtureRequests.length = 0;

    await page.goto('/search');
    await hideAgentChat(page);
    await page.getByLabel('Origin (IATA)').fill('lax');
    await page.getByLabel('Destination (IATA)').fill('nrt');
    await page.getByLabel('Departure Date').fill('2026-12-01');
    await page.getByRole('button', { name: 'Search Flights' }).click();

    await expect(page.getByRole('heading', { name: 'Flight Offers' })).toBeVisible();
    await expect(page.getByText('Mock Pacific')).toBeVisible();
    await expect(page.getByText('Flight MP100')).toBeVisible();
    await expect(page.getByText('750 USD')).toBeVisible();

    await page.getByRole('button', { name: 'Book' }).click();
    await expect(page).toHaveURL(/\/checkout\/passengers\?offerId=char-offer-book-123/);
    await expect(page.getByRole('heading', { name: 'Passenger Details' })).toBeVisible();
    expect(fixtureRequests).toEqual([
      { method: 'POST', pathname: '/api/flights/search' },
      { method: 'GET', pathname: '/api/flights/char-offer-book-123' },
      { method: 'GET', pathname: '/api/flights/char-offer-book-123' },
    ]);
  });
});

test.describe('Search Seam Characterization - Static Privacy Boundary', () => {
  function scanDirectory(dirPath: string): Array<{ filePath: string; content: string }> {
    const files: Array<{ filePath: string; content: string }> = [];
    if (!fs.existsSync(dirPath)) return files;
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) files.push(...scanDirectory(fullPath));
      else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
        files.push({ filePath: fullPath, content: fs.readFileSync(fullPath, 'utf8') });
      }
    }
    return files;
  }

  test('keeps credentials and transport out of the search rendering tree', () => {
    const appFiles = scanDirectory(path.resolve(__dirname, '../../app/search'));
    const componentFiles = scanDirectory(path.resolve(__dirname, '../../components/search'));
    const allSearchFiles = [...appFiles, ...componentFiles];
    expect(allSearchFiles.length).toBeGreaterThanOrEqual(3);

    const forbiddenClientMarkers = [
      'accessToken',
      'NEXT_PUBLIC_API_URL',
      '/api/flights',
      'duffelOfferId',
      'provider',
      'raw',
      'retry',
    ];

    for (const { content } of allSearchFiles) {
      expect(content).not.toMatch(/\bfetch\s*\(/);
      for (const marker of forbiddenClientMarkers) expect(content).not.toContain(marker);
    }

    expect(appFiles.find((file) => file.filePath.endsWith('page.tsx'))?.content).toContain(
      'protectCheckoutRoute',
    );
    const actions = appFiles.find((file) => file.filePath.endsWith('actions.ts'))?.content;
    expect(actions).toContain("'use server'");
    expect(actions).toContain('searchFlightsAction');
    expect(actions).toContain('selectFlightOfferAction');
  });
});
