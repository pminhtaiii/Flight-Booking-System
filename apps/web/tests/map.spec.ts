import { test, expect } from '@playwright/test';

test.describe('Map Integration E2E Flows', () => {
  const password = 'Password123!';

  test.beforeEach(async ({ request, context, page }) => {
    const email = `maptest-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    // Reset database lockouts
    const res = await request.post('http://localhost:3001/api/auth/test/reset-lockout', {
      data: { clearAll: true },
    });
    expect(res.status()).toBe(200);
    await context.clearCookies();

    // Register and log in
    await page.goto('/register');
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('should render search map with zoom and fullscreen controls', async ({ page }) => {
    await page.goto('/search');

    // Verify map container is visible
    const mapElement = page.locator('.maplibregl-map');
    await expect(mapElement).toBeVisible();

    // Click Zoom In
    const zoomInBtn = page.locator('button[title="Zoom In"]');
    await expect(zoomInBtn).toBeVisible();
    await zoomInBtn.click();

    // Click Zoom Out
    const zoomOutBtn = page.locator('button[title="Zoom Out"]');
    await expect(zoomOutBtn).toBeVisible();
    await zoomOutBtn.click();

    // Click Fullscreen
    const fullscreenBtn = page.locator('button[title="Toggle Fullscreen"]');
    await expect(fullscreenBtn).toBeVisible();
    await fullscreenBtn.click();
  });

  test('should perform flight search and display origin/destination markers', async ({ page }) => {
    await page.goto('/search');

    // Wait for the map to be fully loaded first
    const mapElement = page.locator('.maplibregl-map');
    await expect(mapElement).toBeVisible();

    // Fill Origin autocomplete
    const originInput = page.locator('div:has(> label:has-text("Origin")) input');
    await originInput.click();
    await originInput.fill('HAN');
    
    // Select HAN from suggestions using exact matching on any child span to avoid collision
    const hanSuggestion = page.locator('button').filter({ has: page.locator('span', { hasText: /^HAN$/ }) }).first();
    await expect(hanSuggestion).toBeVisible();
    await hanSuggestion.click();

    // Fill Destination autocomplete
    const destInput = page.locator('div:has(> label:has-text("Destination")) input');
    await destInput.click();
    await destInput.fill('NRT');

    // Select NRT from suggestions using exact matching on any child span
    const nrtSuggestion = page.locator('button').filter({ has: page.locator('span', { hasText: /^NRT$/ }) }).first();
    await expect(nrtSuggestion).toBeVisible();
    await nrtSuggestion.click();

    // Check autocomplete map preview markers before search (using whitespace-tolerant exact matching)
    const hanPreviewMarker = page.locator('.maplibregl-marker').filter({ hasText: /^\s*HAN\s*$/ });
    const nrtPreviewMarker = page.locator('.maplibregl-marker').filter({ hasText: /^\s*NRT\s*$/ });
    await expect(hanPreviewMarker).toBeVisible();
    await expect(nrtPreviewMarker).toBeVisible();

    // Submit Search
    const searchBtn = page.locator('button[type="submit"]');
    await expect(searchBtn).toBeEnabled();
    await searchBtn.click();

    // Wait for search results
    await expect(page.locator('text=Flight Offers')).toBeVisible();

    // Verify markers remain visible after search
    await expect(page.locator('.maplibregl-marker').filter({ hasText: /^\s*HAN\s*$/ })).toBeVisible();
    await expect(page.locator('.maplibregl-marker').filter({ hasText: /^\s*NRT\s*$/ })).toBeVisible();
  });

  test('should synchronize dark mode theme between app and map controls', async ({ page }) => {
    await page.goto('/search');

    // Wait for the map to be loaded
    const mapElement = page.locator('.maplibregl-map');
    await expect(mapElement).toBeVisible();

    // Theme toggle button in header
    const themeToggle = page.locator('[aria-label="Toggle theme"]');
    await expect(themeToggle).toBeVisible();

    // Local map dark mode toggle
    const mapThemeBtn = page.locator('button[title="Switch to Dark Map"], button[title="Switch to Light Map"]');
    await expect(mapThemeBtn).toBeVisible();

    // Initial check (light mode app theme)
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await expect(page.locator('button[title="Switch to Dark Map"]')).toBeVisible();

    // Toggle global theme to dark
    await themeToggle.click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await expect(page.locator('button[title="Switch to Light Map"]')).toBeVisible();

    // Toggle map theme locally back to light style
    const localLightBtn = page.locator('button[title="Switch to Light Map"]');
    await localLightBtn.click();
    await expect(page.locator('button[title="Switch to Dark Map"]')).toBeVisible();
  });

  test('should allow popular destination clicks from dashboard and pre-fill search form', async ({ page }) => {
    await page.goto('/dashboard');

    // Wait for popular destinations map to render
    const mapElement = page.locator('.maplibregl-map');
    await expect(mapElement).toBeVisible();

    // Find a popular destination marker (e.g. Singapore) and click it
    // Note: Popular destinations list shows city names like Singapore, Hanoi, Tokyo etc.
    const popularMarker = page.locator('.maplibregl-marker:has-text("Singapore")').first();
    await expect(popularMarker).toBeVisible({ timeout: 15000 });
    await popularMarker.click();

    // Verify navigation to search page with the correct destination pre-filled
    await expect(page).toHaveURL(/.*search.*to=SIN.*/);

    // Verify search page destination input has the IATA + name pre-filled
    const destInput = page.locator('div:has(> label:has-text("Destination")) input');
    await expect(destInput).toHaveValue(/SIN - .*/);

    // Verify destination marker displays SIN on the map (whitespace-tolerant exact match)
    await expect(page.locator('.maplibregl-marker').filter({ hasText: /^\s*SIN\s*$/ })).toBeVisible();
  });
});
