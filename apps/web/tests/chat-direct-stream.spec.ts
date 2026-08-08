import { expect, test } from '@playwright/test';

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

    await page.context().addCookies([
      {
        name: 'next-auth.session-token',
        value: 'mock-token',
        domain: '127.0.0.1',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      },
      {
        name: 'next-auth.session-token',
        value: 'mock-token',
        domain: 'localhost',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);

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
    await page.route('http://127.0.0.1:3002/chat/stream', async (route) => {
      const request = route.request();
      if (request.method() === 'OPTIONS') {
        await route.fulfill({
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': 'http://127.0.0.1:3000',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type',
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
    const input = page.locator('input[placeholder="Type a message..."]');
    await input.fill('first turn');
    await input.press('Enter');
    await expect.poll(() => requests.length).toBe(1);

    await input.fill('second turn');
    await input.press('Enter');
    await expect.poll(() => requests.length).toBe(2);

    expect(proxyRequests).toBe(0);
    expect(requests[0]).toMatchObject({
      authorization: 'Bearer browser-jwt',
      origin: 'http://127.0.0.1:3000',
      body: { message: 'first turn' },
    });
    expect(requests[0].body.sessionId).toBeUndefined();
    expect(requests[0].traceId).toBeUndefined();
    expect(requests[0].correlationId).toMatch(/^chat_[a-f0-9]{32}$/);
    expect(requests[1]).toMatchObject({
      authorization: 'Bearer browser-jwt',
      origin: 'http://127.0.0.1:3000',
      body: { message: 'second turn', sessionId: 'continued-session' },
    });
    expect(requests[1].traceId).not.toBe('continued-session');
    expect(requests[1].correlationId).toMatch(/^chat_[a-f0-9]{32}$/);
    expect(requests[1].correlationId).not.toBe('continued-session');
  });
});
