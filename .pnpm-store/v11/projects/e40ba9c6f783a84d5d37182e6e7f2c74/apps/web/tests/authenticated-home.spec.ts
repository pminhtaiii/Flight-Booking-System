import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';

async function registerAndOpenHome(
  page: Page,
  request: APIRequestContext,
  context: BrowserContext,
): Promise<void> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:3001';
  await request.post(`${apiUrl}/api/auth/test/reset-lockout`, {
    data: { clearAll: true },
  });
  await context.clearCookies();
  const email = `home-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  await page.goto('/register');
  await page.getByRole('textbox', { name: 'Email' }).fill(email);
  await page.getByRole('textbox', { name: 'Password' }).fill('Password123!');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/home$/, { timeout: 30_000 });
}

test('preserves the public landing page for signed-out visitors', async ({ page, context }) => {
  await context.clearCookies();
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Log in to explore' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Where would you like to go next?' })).toHaveCount(0);
});

test('redirects signed-out visitors from the authenticated home to login', async ({ page, context }) => {
  await context.clearCookies();
  await page.goto('/home');

  await expect(page).toHaveURL(/\/login$/);
});

test('keeps the public landing page at the root after authentication', async ({ page, request, context }) => {
  await registerAndOpenHome(page, request, context);
  await page.goto('/');

  await expect(page.getByRole('link', { name: 'Log in to explore' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Where would you like to go next?' })).toHaveCount(0);
});

test('shows the authenticated launch surface and routes to search', async ({ page, request, context }) => {
  await registerAndOpenHome(page, request, context);
  await expect(page.getByRole('heading', { name: 'Where would you like to go next?' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Plan a trip' })).toHaveAttribute('href', '/search');
  await expect(page.getByRole('link', { name: 'Dashboard' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Profile' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Plan a trip' }).click();
  await expect(page).toHaveURL(/\/search$/);
});

test('keeps the primary action visible on a narrow phone viewport', async ({ page, request, context }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await registerAndOpenHome(page, request, context);
  await expect(page.getByRole('link', { name: 'Search flights', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'My bookings', exact: true })).toBeVisible();
  const cta = page.getByRole('link', { name: 'Plan a trip' });
  await expect(cta).toBeVisible();
  const box = await cta.boundingBox();
  expect(box).not.toBeNull();
  expect((box?.y ?? 780) + (box?.height ?? 0)).toBeLessThanOrEqual(780);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('renders the airport map as a non-interactive decorative layer', async ({ page, request, context }) => {
  await page.route('https://tiles.openfreemap.org/styles/dark', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ version: 8, sources: {}, layers: [] }),
    }),
  );
  await registerAndOpenHome(page, request, context);
  const map = page.getByTestId('home-map');
  await expect(map).toBeVisible();
  await expect(map).toHaveAttribute('aria-hidden', 'true');
  expect(await map.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('none');
  await expect(page.locator('.maplibregl-ctrl')).toHaveCount(0);
});

test('credits the map data providers outside the decorative map', async ({ page, request, context }) => {
  await registerAndOpenHome(page, request, context);
  const attribution = page.getByRole('complementary', { name: 'Map attribution' });

  await expect(attribution).toBeVisible();
  await expect(attribution).toHaveText('OpenFreeMap © OpenMapTiles Data from OpenStreetMap.');
  await expect(attribution.getByRole('link', { name: 'OpenFreeMap' })).toHaveAttribute('href', 'https://openfreemap.org/');
  await expect(attribution.getByRole('link', { name: 'OpenMapTiles' })).toHaveAttribute('href', 'https://openmaptiles.org/');
  await expect(attribution.getByRole('link', { name: 'OpenStreetMap' })).toHaveAttribute(
    'href',
    'https://www.openstreetmap.org/copyright',
  );
  expect(await attribution.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('auto');
  await expect(page.getByTestId('home-map').locator('[aria-label="Map attribution"]')).toHaveCount(0);
});

test('keeps the launch action usable when map tiles fail', async ({ page, request, context }) => {
  await page.route('https://tiles.openfreemap.org/**', (route) => route.abort());
  await registerAndOpenHome(page, request, context);
  await expect(page.getByRole('heading', { name: 'Where would you like to go next?' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Plan a trip' })).toBeVisible();
});

test('marks the brand as the visibly current page', async ({ page, request, context }) => {
  await registerAndOpenHome(page, request, context);
  const brand = page.getByRole('link', { name: /wayfinder/i });
  await expect(brand).toHaveAttribute('href', '/home');
  await expect.soft(brand).toHaveAttribute('aria-current', 'page');
  expect(await brand.evaluate((element) => getComputedStyle(element).textDecorationLine)).toContain('underline');
});

test('renders the primary action with AA text contrast', async ({ page, request, context }) => {
  await registerAndOpenHome(page, request, context);
  const contrastRatio = await page.getByRole('link', { name: 'Plan a trip' }).evaluate((element) => {
    function resolveRgb(color: string): [number, number, number] {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const context2d = canvas.getContext('2d', { willReadFrequently: true });
      if (!context2d) throw new Error('Canvas 2D context unavailable');
      context2d.fillStyle = color;
      context2d.fillRect(0, 0, 1, 1);
      const [red, green, blue, alpha] = context2d.getImageData(0, 0, 1, 1).data;
      if (alpha !== 255) throw new Error(`Expected opaque color, received ${color}`);
      return [red, green, blue];
    }

    function relativeLuminance([red, green, blue]: [number, number, number]): number {
      const [linearRed, linearGreen, linearBlue] = [red, green, blue].map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.04045
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * linearRed + 0.7152 * linearGreen + 0.0722 * linearBlue;
    }

    const styles = getComputedStyle(element);
    const foreground = relativeLuminance(resolveRgb(styles.color));
    const background = relativeLuminance(resolveRgb(styles.backgroundColor));
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  });

  expect(contrastRatio).toBeGreaterThanOrEqual(4.5);
});
