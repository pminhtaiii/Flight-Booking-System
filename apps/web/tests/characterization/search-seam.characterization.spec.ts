import { expect, test, type BrowserContext } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { encode } from 'next-auth/jwt';

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

test.describe('Search Seam Characterization - User Flows', () => {
  test.slow();

  test.beforeEach(async ({ page }) => {
    // Prevent floating chat drawer from intercepting pointer clicks on search and offer actions
    await page.addStyleTag({
      content: 'aside[aria-label="Agent chat"] { display: none !important; }',
    }).catch(() => {});
  });

  test('unauthenticated users navigating to /search are redirected to /login', async ({ page, context }) => {
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
    await page.addStyleTag({ content: 'aside[aria-label="Agent chat"] { display: none !important; }' }).catch(() => {});

    await expect(page.getByRole('heading', { name: 'Search Flights' })).toBeVisible();
    await expect(page.getByText('Find and compare flight offers for your next destination.')).toBeVisible();

    const originInput = page.getByLabel('Origin (IATA)');
    const destinationInput = page.getByLabel('Destination (IATA)');
    const departureDateInput = page.getByLabel('Departure Date');
    const cabinClassSelect = page.getByLabel('Cabin Class');
    const adultsInput = page.getByLabel('Adults');
    const childrenInput = page.getByLabel('Children');
    const infantsInput = page.getByLabel('Infants');
    const searchButton = page.getByRole('button', { name: 'Search Flights' });

    await expect(originInput).toBeVisible();
    await expect(originInput).toHaveAttribute('required', '');
    await expect(originInput).toHaveAttribute('maxLength', '3');
    await expect(originInput).toHaveAttribute('placeholder', 'e.g. JFK');

    await expect(destinationInput).toBeVisible();
    await expect(destinationInput).toHaveAttribute('required', '');
    await expect(destinationInput).toHaveAttribute('maxLength', '3');
    await expect(destinationInput).toHaveAttribute('placeholder', 'e.g. LHR');

    await expect(departureDateInput).toBeVisible();
    await expect(departureDateInput).toHaveAttribute('required', '');

    await expect(cabinClassSelect).toBeVisible();
    await expect(cabinClassSelect).toHaveValue('economy');

    await expect(adultsInput).toBeVisible();
    await expect(adultsInput).toHaveValue('1');

    await expect(childrenInput).toBeVisible();
    await expect(childrenInput).toHaveValue('0');

    await expect(infantsInput).toBeVisible();
    await expect(infantsInput).toHaveValue('0');

    await expect(searchButton).toBeVisible();
    await expect(
      page.getByText('No flight offers search results yet. Enter search criteria and search.'),
    ).toBeVisible();
  });

  test('executes flight search with uppercased parameters and renders flight offers', async ({
    page,
    context,
  }) => {
    await authenticateSearchSession(context);

    let capturedSearchPayload: {
      origin?: string;
      destination?: string;
      departureDate?: string;
      adults?: number;
      children?: number;
      infants?: number;
      cabinClass?: string;
    } | null = null;
    let authHeader: string | null = null;

    await page.route('**/api/flights/search', async (route) => {
      capturedSearchPayload = route.request().postDataJSON();
      authHeader = route.request().headers()['authorization'] || null;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          results: [
            {
              id: 'char-offer-001',
              duffelOfferId: 'off_char_001',
              airline: 'Mock Horizon Air',
              flightNumber: 'HZ789',
              departureAirport: 'SFO',
              arrivalAirport: 'JFK',
              departureTime: '2026-11-15T08:00:00.000Z',
              arrivalTime: '2026-11-15T16:30:00.000Z',
              duration: 510,
              stops: 0,
              price: 285,
              currency: 'USD',
              fareClass: 'Y',
              requestedCabinClass: 'economy',
              cabinClassMatch: 'exact',
            },
          ],
        }),
      });
    });

    await page.goto('/search');
    await page.addStyleTag({ content: 'aside[aria-label="Agent chat"] { display: none !important; }' }).catch(() => {});

    await page.getByLabel('Origin (IATA)').fill('sfo');
    await page.getByLabel('Destination (IATA)').fill('jfk');
    await page.getByLabel('Departure Date').fill('2026-11-15');
    await page.getByLabel('Cabin Class').selectOption('economy');
    await page.getByLabel('Adults').fill('2');
    await page.getByLabel('Children').fill('1');
    await page.getByLabel('Infants').fill('0');

    await page.getByRole('button', { name: 'Search Flights' }).click();

    await expect(page.getByRole('heading', { name: 'Flight Offers' })).toBeVisible();
    await expect(page.getByText('Mock Horizon Air')).toBeVisible();
    await expect(page.getByText('Flight HZ789')).toBeVisible();
    await expect(page.getByText('SFO').first()).toBeVisible();
    await expect(page.getByText('JFK').first()).toBeVisible();
    await expect(page.getByText('Non-stop')).toBeVisible();
    await expect(page.getByText('8h 30m')).toBeVisible();
    await expect(page.getByText('285 USD')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Book' })).toBeVisible();

    expect(capturedSearchPayload).not.toBeNull();
    expect(capturedSearchPayload?.origin).toBe('SFO');
    expect(capturedSearchPayload?.destination).toBe('JFK');
    expect(capturedSearchPayload?.departureDate).toBe('2026-11-15');
    expect(capturedSearchPayload?.adults).toBe(2);
    expect(capturedSearchPayload?.children).toBe(1);
    expect(capturedSearchPayload?.infants).toBe(0);
    expect(capturedSearchPayload?.cabinClass).toBe('economy');
    expect(authHeader).toMatch(/^Bearer\s+/);
  });

  test('selecting an offer verifies flight details and navigates to passenger checkout', async ({
    page,
    context,
  }) => {
    await authenticateSearchSession(context);

    await page.route('**/api/flights/search', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          results: [
            {
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
              requestedCabinClass: 'economy',
              cabinClassMatch: 'exact',
            },
          ],
        }),
      });
    });

    let offerVerified = false;
    await page.route('**/api/flights/char-offer-book-123', async (route) => {
      offerVerified = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'char-offer-book-123',
          airline: 'Mock Pacific',
          flightNumber: 'MP100',
          departureAirport: 'LAX',
          arrivalAirport: 'NRT',
        }),
      });
    });

    await page.goto('/search');
    await page.addStyleTag({ content: 'aside[aria-label="Agent chat"] { display: none !important; }' }).catch(() => {});

    await page.getByLabel('Origin (IATA)').fill('LAX');
    await page.getByLabel('Destination (IATA)').fill('NRT');
    await page.getByLabel('Departure Date').fill('2026-12-01');
    await page.getByRole('button', { name: 'Search Flights' }).click();

    await expect(page.getByText('Mock Pacific')).toBeVisible();

    const bookButton = page.getByRole('button', { name: 'Book' });
    await expect(bookButton).toBeVisible();
    await bookButton.click();

    await expect(page).toHaveURL(/.*checkout\/passengers\?offerId=char-offer-book-123/, { timeout: 30000 });
    expect(offerVerified).toBe(true);
  });

  test('displays search error alert when flight search API returns error response', async ({
    page,
    context,
  }) => {
    await authenticateSearchSession(context);

    await page.route('**/api/flights/search', async (route) => {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          message: 'Origin and destination must be different IATA codes.',
        }),
      });
    });

    await page.goto('/search');
    await page.addStyleTag({ content: 'aside[aria-label="Agent chat"] { display: none !important; }' }).catch(() => {});

    await page.getByLabel('Origin (IATA)').fill('JFK');
    await page.getByLabel('Destination (IATA)').fill('JFK');
    await page.getByLabel('Departure Date').fill('2026-12-01');
    await page.getByRole('button', { name: 'Search Flights' }).click();

    const errorAlert = page.locator('[role="alert"]').first();
    await expect(errorAlert).toBeVisible();
    await expect(page.getByText('Search Error')).toBeVisible();
    await expect(page.getByText('Origin and destination must be different IATA codes.')).toBeVisible();
  });

  test('displays error message when flight offer verification fails on book click', async ({
    page,
    context,
  }) => {
    await authenticateSearchSession(context);

    await page.route('**/api/flights/search', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          results: [
            {
              id: 'char-offer-stale',
              airline: 'Mock Stale Air',
              flightNumber: 'ST101',
              departureAirport: 'LHR',
              arrivalAirport: 'JFK',
              departureTime: '2026-12-01T10:00:00.000Z',
              arrivalTime: '2026-12-01T14:00:00.000Z',
              duration: 480,
              stops: 0,
              price: 500,
              currency: 'GBP',
            },
          ],
        }),
      });
    });

    await page.route('**/api/flights/char-offer-stale', async (route) => {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Offer expired' }),
      });
    });

    await page.goto('/search');
    await page.addStyleTag({ content: 'aside[aria-label="Agent chat"] { display: none !important; }' }).catch(() => {});

    await page.getByLabel('Origin (IATA)').fill('LHR');
    await page.getByLabel('Destination (IATA)').fill('JFK');
    await page.getByLabel('Departure Date').fill('2026-12-01');
    await page.getByRole('button', { name: 'Search Flights' }).click();

    await expect(page.getByText('Mock Stale Air')).toBeVisible();
    await page.getByRole('button', { name: 'Book' }).click();

    const errorAlert = page.locator('[role="alert"]').first();
    await expect(errorAlert).toBeVisible();
    await expect(
      page.getByText('Flight offer is temporarily unavailable. Please try again in a few moments.'),
    ).toBeVisible();
  });
});

test.describe('Search Seam Characterization - Static Baseline Metrics', () => {
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

  test('asserts baseline metrics and pattern occurrences across search files', () => {
    const searchAppDir = path.resolve(__dirname, '../../app/search');
    const searchComponentsDir = path.resolve(__dirname, '../../components/search');

    const appFiles = scanDirectory(searchAppDir);
    const componentFiles = scanDirectory(searchComponentsDir);
    const allSearchFiles = [...appFiles, ...componentFiles];

    expect(allSearchFiles.length).toBeGreaterThanOrEqual(2);

    let accessTokenMatches = 0;
    let nextPublicApiUrlMatches = 0;
    let directFetchMatches = 0;
    let directFlightEndpointMatches = 0;

    for (const { content } of allSearchFiles) {
      const tokenMatches = content.match(/accessToken/g);
      if (tokenMatches) accessTokenMatches += tokenMatches.length;

      const apiUrlMatches = content.match(/NEXT_PUBLIC_API_URL/g);
      if (apiUrlMatches) nextPublicApiUrlMatches += apiUrlMatches.length;

      const fetchMatches = content.match(/fetch\(/g);
      if (fetchMatches) directFetchMatches += fetchMatches.length;

      const endpointMatches = content.match(/\/api\/flights/g);
      if (endpointMatches) directFlightEndpointMatches += endpointMatches.length;
    }

    // Baseline assertions for Slice 0 safety rails
    expect(accessTokenMatches).toBe(7);
    expect(nextPublicApiUrlMatches).toBe(2);
    expect(directFetchMatches).toBe(2);
    expect(directFlightEndpointMatches).toBe(2);

    // Verify search page server component uses protectCheckoutRoute
    const searchPage = appFiles.find((f) => f.filePath.endsWith('page.tsx'));
    expect(searchPage).toBeDefined();
    expect(searchPage?.content).toContain('protectCheckoutRoute');
  });
});
