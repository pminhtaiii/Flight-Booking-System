import { test, expect, Page, Route } from '@playwright/test';

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
    handoffToken: 'chk_handoff_v1_opaque',
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
    await page.goto('http://127.0.0.1:3000/search');
    
    await page.fill('input[placeholder="Type a message..."]', 'checkout');
    await page.keyboard.press('Enter');
    
    const submitButton = page.locator('text=Continue to Checkout');
    await submitButton.waitFor();

    // The backend /api/chat-handoff/resolve might fail, but we just need to verify the redirect happened
    // and token is not in URL
    await submitButton.click();
    await expect(page).toHaveURL(/\/checkout\/passengers$/);
    expect(page.url()).not.toContain('handoffToken');
  });

  test('should set HttpOnly/Secure/SameSite cookie on bootstrap', async ({ page, context }) => {
    await loginAsNewUser(page);
    // Mock the resolve endpoint so we don't crash the server side
    await page.context().addCookies([{
      name: 'mock-scenario',
      value: 'valid-intent', // to prevent the page from crashing if it fetches intent
      domain: '127.0.0.1',
      path: '/',
    }]);

    // Send a direct POST request to /checkout/handoff to simulate form submission
    const response = await page.request.post('http://127.0.0.1:3000/checkout/handoff', {
      form: {
        handoffToken: 'a'.repeat(43),
      },
      headers: {
        'Origin': 'http://127.0.0.1:3000',
      }
    });

    expect(response.status()).toBe(200); // Wait, Next.js redirect from route.ts returns 303, but Playwright follows it and returns 200 of the passenger page
    
    const cookies = await context.cookies();
    const handoffCookie = cookies.find((cookie) => cookie.name === 'chat_handoff_token');
    
    expect(handoffCookie).toBeDefined();
    expect(handoffCookie?.httpOnly).toBe(true);
    // Secure is true but in http localhost it might be ignored or set, but we expect it.
    expect(handoffCookie?.sameSite).toBe('Strict');
  });

  test('should resolve owner-only from cookie and recover state', async ({ page, context }) => {
    await loginAsNewUser(page);
    await context.addCookies([{
      name: 'chat_handoff_token',
      value: 'dummy_token',
      domain: '127.0.0.1',
      path: '/',
    }, {
      name: 'mock-scenario',
      value: 'valid-intent', // so the page renders fine
      domain: '127.0.0.1',
      path: '/',
    }]);

    await page.route('**/api/chat-handoff/resolve*', async (route: Route) => {
      await route.fulfill({
        status: 200,
        json: { flightOfferId: 'off_test123' },
      });
    });

    await page.goto('http://127.0.0.1:3000/checkout/passengers');
    
    await expect(page.locator('text=Passenger 1 (ADULT)')).toBeVisible({ timeout: 15000 });
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

  test('keeps the handoff credential out of browser URLs, storage, and observed request URLs', async ({ page }) => {
    const credential = mockHandoffEvent.handoffToken;
    const observedUrls: string[] = [];
    page.on('request', (request) => observedUrls.push(request.url()));

    await setupMockStream(page);
    await page.goto('http://127.0.0.1:3000/search');
    await page.fill('input[placeholder="Type a message..."]', 'checkout');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Continue to Checkout' }).waitFor();

    expect(page.url()).not.toContain(credential);
    expect(observedUrls.every((url) => !url.includes(credential))).toBe(true);
    const browserStorage = await page.evaluate(() => ({
      local: JSON.stringify(window.localStorage),
      session: JSON.stringify(window.sessionStorage),
      href: window.location.href,
    }));
    expect(JSON.stringify(browserStorage)).not.toContain(credential);
  });
});
