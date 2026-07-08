import { test, expect, Page, APIRequestContext, BrowserContext } from '@playwright/test';

// Helper to log in a user by registering a unique email
async function loginUser(page: Page, request: APIRequestContext, context: BrowserContext) {
  const email = `searchtest-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = 'Password123!';

  // Reset database lockouts via test endpoint
  const res = await request.post('http://localhost:3001/api/auth/test/reset-lockout', {
    data: { clearAll: true },
  });
  expect(res.status()).toBe(200);
  await context.clearCookies();

  // Register and automatically log in
  await page.goto('/register');
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL(/\/dashboard/);
}

test.describe('Flight Search Integration E2E Flows', () => {
  test.beforeEach(async ({ page, request, context }) => {
    await loginUser(page, request, context);
  });

  test('should perform a successful one-way search and display complete result details', async ({ page }) => {
    // Navigate to search page
    await page.goto('/search');

    // Fill in Origin autocomplete
    const originInput = page.locator('div:has(> label:has-text("Origin")) input');
    await originInput.click();
    await originInput.fill('HAN');

    // Select HAN from suggestions
    const hanSuggestion = page.locator('button').filter({ has: page.locator('span', { hasText: /^HAN$/ }) }).first();
    await expect(hanSuggestion).toBeVisible();
    await hanSuggestion.click();

    // Fill in Destination autocomplete
    const destInput = page.locator('div:has(> label:has-text("Destination")) input');
    await destInput.click();
    await destInput.fill('SGN');

    // Select SGN from suggestions
    const sgnSuggestion = page.locator('button').filter({ has: page.locator('span', { hasText: /^SGN$/ }) }).first();
    await expect(sgnSuggestion).toBeVisible();
    await sgnSuggestion.click();

    // Fill in Passenger count
    const passengerInput = page.locator('div:has(> label:has-text("Passengers")) input');
    await passengerInput.fill('2');

    // Fill in Departure date (future date)
    const departDateInput = page.locator('div:has(> label:has-text("Departure Date")) input');
    await departDateInput.fill('2026-07-15');

    // Submit Search
    const searchBtn = page.locator('button[type="submit"]');
    await expect(searchBtn).toBeEnabled();
    await searchBtn.click();

    // Verify search results are displayed
    const resultsContainer = page.locator('text=Flight Offers');
    await expect(resultsContainer).toBeVisible();

    // Assert that the first result contains all required details
    const firstResult = page.locator('.chat-flight-card').first();
    await expect(firstResult).toBeVisible();

    // Assert Airline Name
    const airlineName = firstResult.locator('.chat-flight-name');
    await expect(airlineName).toBeVisible();
    await expect(airlineName).not.toBeEmpty();

    // Assert Price
    const priceText = firstResult.locator('.price-value');
    await expect(priceText).toBeVisible();
    await expect(priceText).toHaveText(/\$\d+(\.\d{2})?/);

    // Assert Departure and Arrival Airports
    const departureAirport = firstResult.locator('.route-details-row span').first();
    const arrivalAirport = firstResult.locator('.route-details-row span').last();
    await expect(departureAirport).toHaveText('HAN');
    await expect(arrivalAirport).toHaveText('SGN');

    // Assert Departure and Arrival Times
    const departureTime = firstResult.locator('.route-times-row .route-time').first();
    const arrivalTime = firstResult.locator('.route-times-row .route-time').last();
    await expect(departureTime).toBeVisible();
    await expect(departureTime).not.toBeEmpty();
    await expect(arrivalTime).toBeVisible();
    await expect(arrivalTime).not.toBeEmpty();

    // Assert Stops
    const stopsIndicator = firstResult.locator('.path-stops');
    await expect(stopsIndicator).toBeVisible();
    await expect(stopsIndicator).toHaveText(/Non-stop|\d+ Stop/i);

    // Assert Fare Class (should fail because not implemented yet)
    const fareClass = firstResult.locator('.fare-class-value');
    await expect(fareClass).toBeVisible();
    await expect(fareClass).toHaveText(/Economy|Business|First/i);

    // Assert Baggage Allowance (should fail because not implemented yet)
    const baggageAllowance = firstResult.locator('.baggage-value');
    await expect(baggageAllowance).toBeVisible();
    await expect(baggageAllowance).not.toBeEmpty();
  });

  test('should perform a successful round-trip search and display both outbound and return segments', async ({ page }) => {
    // Navigate to search page
    await page.goto('/search');

    // Toggle round-trip option (should fail because toggle doesn't exist yet)
    const roundTripToggle = page.locator('button:has-text("Round-trip"), input[value="round-trip"], label:has-text("Round-trip")').first();
    await expect(roundTripToggle).toBeVisible();
    await roundTripToggle.click();

    // Fill in Origin autocomplete
    const originInput = page.locator('div:has(> label:has-text("Origin")) input');
    await originInput.click();
    await originInput.fill('HAN');
    const hanSuggestion = page.locator('button').filter({ has: page.locator('span', { hasText: /^HAN$/ }) }).first();
    await expect(hanSuggestion).toBeVisible();
    await hanSuggestion.click();

    // Fill in Destination autocomplete
    const destInput = page.locator('div:has(> label:has-text("Destination")) input');
    await destInput.click();
    await destInput.fill('SGN');
    const sgnSuggestion = page.locator('button').filter({ has: page.locator('span', { hasText: /^SGN$/ }) }).first();
    await expect(sgnSuggestion).toBeVisible();
    await sgnSuggestion.click();

    // Fill in Passenger count
    const passengerInput = page.locator('div:has(> label:has-text("Passengers")) input');
    await passengerInput.fill('2');

    // Fill in Departure date (future date)
    const departDateInput = page.locator('div:has(> label:has-text("Departure Date")) input');
    await departDateInput.fill('2026-07-15');

    // Fill in Return date (future date >= departure)
    const returnDateInput = page.locator('div:has(> label:has-text("Return Date")) input');
    await expect(returnDateInput).toBeVisible();
    await returnDateInput.fill('2026-07-20');

    // Submit Search
    const searchBtn = page.locator('button[type="submit"]');
    await expect(searchBtn).toBeEnabled();
    await searchBtn.click();

    // Verify search results are displayed
    const resultsContainer = page.locator('text=Flight Offers');
    await expect(resultsContainer).toBeVisible();

    const firstResult = page.locator('.chat-flight-card').first();
    await expect(firstResult).toBeVisible();

    // Assert that outbound segments are rendered (should fail because not implemented yet)
    const outboundSegments = firstResult.locator('.outbound-segments');
    await expect(outboundSegments).toBeVisible();

    // Assert that return segments are rendered (should fail because not implemented yet)
    const returnSegments = firstResult.locator('.return-segments');
    await expect(returnSegments).toBeVisible();
  });

  test('should display validation error message when submitting an invalid IATA code or date', async ({ page }) => {
    // Navigate to search page
    await page.goto('/search');

    // Case 1: Past departure date
    const originInput = page.locator('div:has(> label:has-text("Origin")) input');
    await originInput.click();
    await originInput.fill('HAN');
    const hanSuggestion = page.locator('button').filter({ has: page.locator('span', { hasText: /^HAN$/ }) }).first();
    await expect(hanSuggestion).toBeVisible();
    await hanSuggestion.click();

    const destInput = page.locator('div:has(> label:has-text("Destination")) input');
    await destInput.click();
    await destInput.fill('SGN');
    const sgnSuggestion = page.locator('button').filter({ has: page.locator('span', { hasText: /^SGN$/ }) }).first();
    await expect(sgnSuggestion).toBeVisible();
    await sgnSuggestion.click();

    const departDateInput = page.locator('div:has(> label:has-text("Departure Date")) input');
    // Set past date
    await departDateInput.fill('2020-01-01');

    const searchBtn = page.locator('button[type="submit"]');
    await expect(searchBtn).toBeEnabled();
    await searchBtn.click();

    // Verify validation error message is shown (should fail because not implemented/handled in UI yet)
    const dateError = page.locator('.error-message, [role="alert"]').filter({ hasText: /future|invalid/i });
    await expect(dateError).toBeVisible();
  });
});
