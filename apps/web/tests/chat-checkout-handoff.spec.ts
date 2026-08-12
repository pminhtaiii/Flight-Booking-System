import { test, expect, type Page, type Route } from '@playwright/test';

const WEB_ORIGIN = 'http://127.0.0.1:3000';
const HANDOFF_TOKEN = `chk_handoff_v1_${'a'.repeat(43)}`;

// User-approved review fix (2026-08-10): align existing expectations with the strict handoff contract.

async function loginAsNewUser(page: Page): Promise<void> {
  const unique = Date.now() + Math.floor(Math.random() * 10000);
  await page.goto('http://127.0.0.1:3000/register');
  await page.fill('input[name="email"]', `test${unique}@example.com`);
  await page.fill('input[name="password"]', 'Password123!');
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL(/.*127\.0\.0\.1:3000\/$/, { timeout: 15000 });
}

test.describe('Chat Checkout Handoff', () => {
  const mockHandoffEvent = {
    version: 1,
    action: 'begin_checkout',
    handoffToken: HANDOFF_TOKEN,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    display: {
      airline: 'Test Airlines',
      origin: 'JFK',
      destination: 'LHR',
      departureAt: new Date(Date.now() + 86400000).toISOString(),
      arrivalAt: new Date(Date.now() + 86400000 * 2).toISOString(),
      price: '150.00',
      currency: 'USD',
    }
  };

  const setupMockStream = async (page: Page): Promise<void> => {
    await page.route('**/api/chat/stream', async (route: Route) => {
      const streamContent = `event: ACTION_HANDOFF\ndata: ${JSON.stringify(mockHandoffEvent)}\n\n`;
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: streamContent,
      });
    });
  };

  test('rejects an unauthenticated handoff bootstrap', async ({ page }) => {
    const response = await page.request.post(`${WEB_ORIGIN}/checkout/handoff`, {
      form: { handoffToken: HANDOFF_TOKEN },
      headers: { Origin: WEB_ORIGIN },
    });

    expect(response.status()).toBe(401);
    expect(response.headers()['set-cookie']).toBeUndefined();
  });

  test('rejects malformed and non-contract handoff bodies', async ({ page }) => {
    await loginAsNewUser(page);

    const legacyTokenResponse = await page.request.post(`${WEB_ORIGIN}/checkout/handoff`, {
      form: { handoffToken: 'a'.repeat(43) },
      headers: { Origin: WEB_ORIGIN },
    });
    expect(legacyTokenResponse.status()).toBe(400);

    const extraFieldResponse = await page.request.post(`${WEB_ORIGIN}/checkout/handoff`, {
      form: { handoffToken: HANDOFF_TOKEN, unexpected: 'field' },
      headers: { Origin: WEB_ORIGIN },
    });
    expect(extraFieldResponse.status()).toBe(400);

    const invalidMediaResponse = await page.request.post(`${WEB_ORIGIN}/checkout/handoff`, {
      data: '{"handoffToken":',
      headers: { Origin: WEB_ORIGIN, 'Content-Type': 'application/json' },
    });
    expect(invalidMediaResponse.status()).toBe(400);
  });

  test('rejects missing, malformed, and non-identical origins', async ({ page }) => {
    await loginAsNewUser(page);

    for (const headers of [
      {},
      { Origin: 'not a URL' },
      { Origin: 'https://127.0.0.1:3000' },
      { Referer: 'http://127.0.0.1:3001/checkout' },
    ]) {
      const response = await page.request.post(`${WEB_ORIGIN}/checkout/handoff`, {
        form: { handoffToken: HANDOFF_TOKEN },
        headers,
      });
      expect(response.status()).toBe(403);
      expect(response.headers()['set-cookie']).toBeUndefined();
    }
  });

  test('should render strict checkout card from ACTION_HANDOFF event', async ({ page }) => {
    await setupMockStream(page);
    await page.goto('http://127.0.0.1:3000/search');
    
    // Type in chat to trigger the mocked stream
    await page.fill('input[placeholder="Type a message..."]', 'I want to checkout');
    await page.keyboard.press('Enter');
    
    await expect(page.locator('text=Continue to Checkout')).toBeVisible();
    await expect(page.locator('text=Test Airlines')).toBeVisible();
  });

  test('keeps legacy ACTION_REQUIRED separate from checkout handoff', async ({ page }) => {
    await page.route('**/api/chat/stream', async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: [
          'event: ACTION_REQUIRED',
          'data: ' + JSON.stringify({
            action: 'COMPLETE_PROFILE',
            scope: 'DOMESTIC',
            passengers: [{
              passengerType: 'ADULT',
              passengerOrdinal: 1,
              sections: [{
                name: 'identity',
                fields: [{ name: 'givenName', status: 'missing', reason: 'REQUIRED' }],
              }],
            }],
            target: '/profile',
          }),
          '',
        ].join('\n') + '\n',
      });
    });

    await page.goto('http://127.0.0.1:3000/search');
    await page.fill('input[placeholder="Type a message..."]', 'show profile requirements');
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('booking-action-card')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Complete profile' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue to Checkout' })).toHaveCount(0);
  });

  test('keeps the same-origin stream proxy available when direct streaming is disabled', async ({ page }) => {
    let proxyRequests = 0;
    let directRequests = 0;
    await page.route('**/api/chat/stream', async (route) => {
      proxyRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: 'event: done\ndata: {"sessionId":"proxy-session"}\n\n',
      });
    });
    await page.route('http://127.0.0.1:3002/chat/stream', async (route) => {
      directRequests += 1;
      await route.abort();
    });

    await page.goto('http://127.0.0.1:3000/search');
    await page.fill('input[placeholder="Type a message..."]', 'hello through rollback');
    await page.keyboard.press('Enter');

    await expect.poll(() => proxyRequests).toBe(1);
    expect(directRequests).toBe(0);
  });

  test('should submit CSRF/origin-protected POST bootstrap and redirect cleanly', async ({ page }) => {
    await loginAsNewUser(page);
    await setupMockStream(page);
    await page.route(`${WEB_ORIGIN}/checkout/passengers`, async (route) => {
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<main>Checkout</main>' });
    });
    await page.goto('http://127.0.0.1:3000/search');
    
    await page.fill('input[placeholder="Type a message..."]', 'checkout');
    await page.keyboard.press('Enter');
    
    const submitButton = page.locator('text=Continue to Checkout');
    await submitButton.waitFor();

    await submitButton.click();
    await expect(page).toHaveURL(/\/checkout\/passengers$/);
    expect(page.url()).not.toContain('handoffToken');
  });

  test('should set HttpOnly/Secure/SameSite cookie on bootstrap', async ({ page, context }) => {
    await loginAsNewUser(page);
    const response = await page.request.post(`${WEB_ORIGIN}/checkout/handoff`, {
      form: {
        handoffToken: HANDOFF_TOKEN,
      },
      headers: {
        Origin: WEB_ORIGIN,
      },
      maxRedirects: 0,
    });

    expect(response.status()).toBe(303);
    expect(response.headers().location).toBe(`${WEB_ORIGIN}/checkout/passengers`);
    
    const cookies = await context.cookies();
    const handoffCookie = cookies.find((cookie) => cookie.name === 'chat_handoff_token');
    
    expect(handoffCookie).toBeDefined();
    expect(handoffCookie?.httpOnly).toBe(true);
    expect(handoffCookie?.secure).toBe(true);
    expect(handoffCookie?.sameSite).toBe('Strict');
  });

  test('should enforce browser-storage privacy', async ({ page }) => {
    await setupMockStream(page);
    await page.goto('http://127.0.0.1:3000/search');
    
    await page.fill('input[placeholder="Type a message..."]', 'checkout');
    await page.keyboard.press('Enter');
    await page.locator('text=Continue to Checkout').waitFor();
    
    const localStorage = await page.evaluate(() => window.localStorage.getItem('handoffToken'));
    const sessionStorage = await page.evaluate(() => window.sessionStorage.getItem('handoffToken'));
    
    expect(localStorage).toBeNull();
    expect(sessionStorage).toBeNull();
    await expect(page.locator('input[name="handoffToken"]')).toHaveCount(0);
  });

  test('keeps the handoff credential out of browser URLs, logs, storage, and redirect targets', async ({ page }) => {
    const credential = mockHandoffEvent.handoffToken;
    const observedUrls: string[] = [];
    const browserLogs: string[] = [];
    const bootstrapBodies: Array<string | null> = [];

    await loginAsNewUser(page);
    page.on('request', (request) => observedUrls.push(request.url()));
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/checkout/handoff') {
        bootstrapBodies.push(request.postData());
      }
    });
    page.on('console', (message) => browserLogs.push(message.text()));

    await setupMockStream(page);
    await page.route(`${WEB_ORIGIN}/checkout/passengers`, async (route) => {
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<main>Checkout</main>' });
    });
    await page.goto('http://127.0.0.1:3000/search');
    await page.fill('input[placeholder="Type a message..."]', 'checkout');
    await page.keyboard.press('Enter');
    const continueButton = page.getByRole('button', { name: 'Continue to Checkout' });
    await continueButton.waitFor();
    const renderedDom = await page.locator('html').evaluate((element) => element.outerHTML);
    expect(renderedDom).not.toContain(credential);
    await continueButton.click();
    await expect(page).toHaveURL(/\/checkout\/passengers$/);

    expect(bootstrapBodies).toEqual([`handoffToken=${encodeURIComponent(credential)}`]);
    expect(page.url()).not.toContain(credential);
    expect(observedUrls.every((url) => !url.includes(credential))).toBe(true);
    expect(browserLogs.every((message) => !message.includes(credential))).toBe(true);
    const browserStorage = await page.evaluate(() => ({
      local: JSON.stringify(window.localStorage),
      session: JSON.stringify(window.sessionStorage),
      href: window.location.href,
    }));
    expect(JSON.stringify(browserStorage)).not.toContain(credential);
  });
});
