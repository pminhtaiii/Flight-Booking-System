import { expect, test } from '@playwright/test';

type ActionHandoffFixture = {
  version: 1;
  action: 'begin_checkout';
  handoffToken: string;
  expiresAt: string;
  display: {
    airline: string;
    origin: string;
    destination: string;
    departureAt: string;
    arrivalAt: string;
    price: string;
    currency: string;
  };
  offerId?: string;
};

function buildActionHandoffFixture(handoffToken: string, offerId?: string): ActionHandoffFixture {
  return {
    version: 1,
    action: 'begin_checkout',
    handoffToken,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    display: {
      airline: 'Test Airlines',
      origin: 'JFK',
      destination: 'LHR',
      departureAt: new Date(Date.now() + 86400000).toISOString(),
      arrivalAt: new Date(Date.now() + 90000000).toISOString(),
      price: '150.00',
      currency: 'USD',
    },
    ...(offerId === undefined ? {} : { offerId }),
  };
}

// This verifies the browser client boundary with an intercepted FastAPI response.
// Real FastAPI CORS, JWT, active-user, and revocation behavior is owned by agent integration tests.
test.describe('Chat direct stream browser boundary (mocked FastAPI)', () => {
  test('bypasses the proxy, sends bearer auth to the agent URL, and reuses the done session', async ({ page }) => {
    test.setTimeout(120000);
    const requests: Array<{
      authorization: string | undefined;
      origin: string | undefined;
      traceId: string | undefined;
      correlationId: string | undefined;
      body: { message: string; sessionId?: string };
    }> = [];
    let proxyRequests = 0;
    let preflightRequestHeaders = '';



    await page.route('**/api/auth/session', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { email: 'direct@example.com' },
          expires: '2099-01-01T00:00:00.000Z',
          accessToken: 'browser-jwt',
        }),
      });
    });
    await page.route('**/api/chat/stream', async (route) => {
      proxyRequests += 1;
      await route.abort();
    });
    await page.route(/.*:3002\/chat\/stream/, async (route) => {
      const request = route.request();
      if (request.method() === 'OPTIONS') {
        preflightRequestHeaders = request.headers()['access-control-request-headers'] || '';
        await route.fulfill({
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': 'http://127.0.0.1:3000',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers':
              'Authorization, Content-Type, X-Trace-Id, X-Correlation-Id',
          },
        });
        return;
      }

      requests.push({
        authorization: request.headers().authorization,
        origin: request.headers().origin,
        traceId: request.headers()['x-trace-id'],
        correlationId: request.headers()['x-correlation-id'],
        body: request.postDataJSON(),
      });
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: { 'Access-Control-Allow-Origin': 'http://127.0.0.1:3000' },
        body: 'event: done\ndata: {"sessionId":"continued-session"}\n\n',
      });
    });

    await page.goto('http://127.0.0.1:3000/search');
    await page.waitForResponse('**/api/auth/session');
    const input = page.locator('input[placeholder="Type a message..."]');
    await input.fill('first turn');
    await input.press('Enter');
    await expect.poll(() => requests.length).toBe(1);

    await input.fill('second turn');
    await input.press('Enter');
    await expect.poll(() => requests.length).toBe(2);

    expect(proxyRequests).toBe(0);
    expect(preflightRequestHeaders).toContain('x-trace-id');
    expect(preflightRequestHeaders).toContain('x-correlation-id');
    expect(requests[0]).toMatchObject({
      authorization: 'Bearer browser-jwt',
      origin: 'http://127.0.0.1:3000',
      body: { message: 'first turn' },
    });
    expect(requests[0].body.sessionId).toBeUndefined();
    expect(requests[0].traceId).toMatch(/^chat_[a-f0-9]{32}$/);
    expect(requests[0].correlationId).toMatch(/^chat_[a-f0-9]{32}$/);
    expect(requests[0].traceId).not.toBe(requests[0].correlationId);
    expect(requests[1]).toMatchObject({
      authorization: 'Bearer browser-jwt',
      origin: 'http://127.0.0.1:3000',
      body: { message: 'second turn', sessionId: 'continued-session' },
    });
    expect(requests[1].traceId).toMatch(/^chat_[a-f0-9]{32}$/);
    expect(requests[1].traceId).not.toBe('continued-session');
    expect(requests[1].traceId).not.toBe(requests[1].correlationId);
    expect(requests[1].correlationId).toMatch(/^chat_[a-f0-9]{32}$/);
    expect(requests[1].correlationId).not.toBe('continued-session');
  });

  // User approved aligning this reviewed test with browser-observable stream behavior.
  test('rejects identifier-bearing handoff, then preserves selection and reconnect continuity', async ({ page }) => {
    const handoffToken = `chk_handoff_v1_${'a'.repeat(43)}`;
    const requests: Array<{ body: Record<string, unknown>; url: string }> = [];
    let proxyRequests = 0;
    let streamRequestNumber = 0;

    await page.route('**/api/auth/session', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { email: 'direct@example.com' },
          expires: '2099-01-01T00:00:00.000Z',
          accessToken: 'browser-jwt',
        }),
      });
    });
    await page.route('**/api/chat/stream', async (route) => {
      proxyRequests += 1;
      await route.abort();
    });
    await page.route(/.*:3002\/chat\/stream/, async (route) => {
      if (route.request().method() === 'OPTIONS') {
        await route.fulfill({
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': 'http://127.0.0.1:3000',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Trace-Id, X-Correlation-Id',
          },
        });
        return;
      }

      streamRequestNumber += 1;
      requests.push({ body: route.request().postDataJSON() as Record<string, unknown>, url: route.request().url() });
      const firstTurn = streamRequestNumber === 1;
      const streamBody = firstTurn
        ? [
            'event: flight_results',
            'data: ' + JSON.stringify({
              version: 1,
              results: [{ index: 1, airline: 'Test Airlines', origin: 'JFK', destination: 'LHR' }],
            }),
            '',
            'event: ACTION_HANDOFF',
            'data: ' + JSON.stringify(buildActionHandoffFixture(handoffToken, 'forbidden-offer-id')),
            '',
            'event: done',
            'data: {"sessionId":"continued-session"}',
            '',
          ].join('\n')
        : [
            'event: ACTION_HANDOFF',
            'data: ' + JSON.stringify(buildActionHandoffFixture(handoffToken)),
            '',
          ].join('\n');

      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: { 'Access-Control-Allow-Origin': 'http://127.0.0.1:3000' },
        body: streamBody,
      });
    });

    await page.goto('http://127.0.0.1:3000/search');
    const input = page.locator('input[placeholder="Type a message..."]');
    await input.fill('search flights');
    await input.press('Enter');
    await expect.poll(() => requests.length).toBe(1);
    await expect(page.getByRole('button', { name: 'Continue to Checkout' })).toHaveCount(0);

    await input.fill('select option 1');
    await input.press('Enter');
    await expect.poll(() => requests.length).toBe(2);
    await expect(page.getByRole('button', { name: 'Continue to Checkout' })).toBeVisible();

    expect(proxyRequests).toBe(0);
    expect(requests[0].body).toMatchObject({ message: 'search flights' });
    expect(requests[0].body.sessionId).toBeUndefined();
    expect(requests[1].body).toMatchObject({ message: 'select option 1', sessionId: 'continued-session' });
    expect(requests.every((request) => !request.url.includes(handoffToken))).toBe(true);
    expect(page.url()).not.toContain(handoffToken);
    const browserStorage = await page.evaluate(() => `${window.location.href}\n${JSON.stringify(window.localStorage)}\n${JSON.stringify(window.sessionStorage)}`);
    expect(browserStorage).not.toContain(handoffToken);
  });
});
