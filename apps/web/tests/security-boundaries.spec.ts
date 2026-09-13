import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { expect, test, type Page } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { getAuthCookieConfig } from '../lib/auth';

const TEST_SECRET = process.env.NEXTAUTH_SECRET || randomBytes(32).toString('base64url');
const AUDIT_EMAIL =
  process.env.TEST_AUDIT_EMAIL ||
  `security-audit-${Date.now()}-${randomBytes(4).toString('hex')}@example.test`;
const AUDIT_PASSWORD = 'AuditPassword123!';
let mockAuthBackend: http.Server | undefined;

test.beforeAll(async () => {
  let isRealApiRunning = false;
  try {
    const healthRes = await fetch('http://127.0.0.1:3001/health', {
      signal: AbortSignal.timeout(2000),
    });
    if (healthRes.ok) {
      isRealApiRunning = true;
    }
  } catch {
    isRealApiRunning = false;
  }

  if (isRealApiRunning) {
    let provisioned = false;
    for (const url of [
      'http://127.0.0.1:3001/api/auth/test/provision-user',
      'http://127.0.0.1:3001/auth/test/provision-user',
    ]) {
      try {
        const provisionRes = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: AUDIT_EMAIL,
            password: AUDIT_PASSWORD,
            role: 'USER',
          }),
        });
        if (provisionRes.status === 200) {
          provisioned = true;
          break;
        }
      } catch {
        // continue
      }
    }

    if (!provisioned) {
      const regRes = await fetch('http://127.0.0.1:3001/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: AUDIT_EMAIL,
          password: AUDIT_PASSWORD,
        }),
      });

      if (regRes.status !== 201 && regRes.status !== 200) {
        const text = await regRes.text().catch(() => '');
        throw new Error(
          `Failed to provision security audit user: HTTP ${regRes.status} ${text}`,
        );
      }
    }

    const verifyRes = await fetch('http://127.0.0.1:3001/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: AUDIT_EMAIL,
        password: AUDIT_PASSWORD,
      }),
    });

    if (!verifyRes.ok) {
      const text = await verifyRes.text().catch(() => '');
      throw new Error(
        `Failed to verify security audit user credentials on real API: HTTP ${verifyRes.status} ${text}`,
      );
    }
  } else {
    await new Promise<void>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        if (req.url?.includes('/auth/login') && req.method === 'POST') {
          let body = '';
          req.on('data', (chunk) => {
            body += chunk;
          });
          req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                token: 'sec-auth-token-real',
                user: {
                  id: 'sec-user-456',
                  email: AUDIT_EMAIL,
                },
              }),
            );
          });
          return;
        }
        res.writeHead(404);
        res.end();
      });

      server.once('error', (err) => {
        reject(err);
      });

      server.listen(3001, () => {
        mockAuthBackend = server;
        resolve();
      });
    });
  }
});

test.afterAll(async () => {
  if (mockAuthBackend) {
    await new Promise<void>((resolve, reject) => {
      mockAuthBackend?.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }
});

async function authenticateSession(
  page: Page,
  scenarioToken = 'token-security-test',
): Promise<void> {
  const sessionToken = await encode({
    secret: TEST_SECRET,
    token: {
      sub: 'sec-user-456',
      id: 'sec-user-456',
      accessToken: scenarioToken,
      email: AUDIT_EMAIL,
      name: 'Security Audit User',
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
        user: {
          id: 'sec-user-456',
          email: AUDIT_EMAIL,
          name: 'Security Audit User',
        },
        accessToken: scenarioToken,
        expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      }),
    });
  });
}

async function setMockScenario(page: Page, scenario: string): Promise<void> {
  await page.context().addCookies([
    {
      name: 'mock-scenario',
      value: scenario,
      url: 'http://127.0.0.1:3000',
    },
  ]);
}

test.describe('Web Browser Security Boundaries', () => {
  // ---------------------------------------------------------------------------
  // a. Reflected & DOM XSS Resistance
  // ---------------------------------------------------------------------------
  test.describe('Reflected & DOM XSS Resistance', () => {
    test('flight search URL query parameters with attack payloads are escaped with zero script execution', async ({
      page,
    }) => {
      test.slow();
      let dialogFired = false;
      let dialogMessage = '';
      page.on('dialog', async (dialog) => {
        dialogFired = true;
        dialogMessage = dialog.message();
        await dialog.dismiss();
      });

      await authenticateSession(page);

      // Attack payloads across search query params: q, origin, destination, offerId
      const xssScript = "<script>window.__xss_fired=true;alert('xss-reflected')</script>";
      const xssImg = '"><img src=x onerror="window.__xss_fired=true;alert(1)">';
      const xssJsUri = 'javascript:window.__xss_fired=true;alert(1)';

      const searchUrl =
        `/search?origin=${encodeURIComponent(xssScript)}` +
        `&destination=${encodeURIComponent(xssImg)}` +
        `&q=${encodeURIComponent(xssJsUri)}` +
        `&offerId=${encodeURIComponent(xssScript)}`;

      await page.goto(searchUrl);

      // Verify page is rendered
      await expect(page.getByRole('heading', { name: 'Search Flights' })).toBeVisible();

      // Ensure no alert dialog fired
      expect(dialogFired).toBe(false);
      expect(dialogMessage).toBe('');

      // Verify zero unescaped execution occurred in page context
      const xssFired = await page.evaluate(() => {
        return (window as unknown as { __xss_fired?: boolean }).__xss_fired;
      });
      expect(xssFired).toBeUndefined();

      // Verify no unescaped attack scripts or onerror attributes exist in the rendered main UI
      const unescapedTagsCount = await page.evaluate(() => {
        return document.querySelectorAll('main script, main img[onerror], main svg[onload]').length;
      });
      expect(unescapedTagsCount).toBe(0);
    });

    test('checkout passengers page renders offerId payload as safe text without dialog execution', async ({
      page,
    }) => {
      test.slow();
      let dialogFired = false;
      page.on('dialog', async (dialog) => {
        dialogFired = true;
        await dialog.dismiss();
      });

      await authenticateSession(page);
      await setMockScenario(page, 'international-offer');

      const attackPayload = '<script>window.__xss_offer=true;alert("xss-offerId")</script>';
      await page.goto(`/checkout/passengers?offerId=${encodeURIComponent(attackPayload)}`);

      // Verify passenger page rendered safely
      await expect(page.getByRole('heading', { name: 'Passenger Details' })).toBeVisible();

      // Zero alert dialogs
      expect(dialogFired).toBe(false);

      // Zero unescaped execution in window context
      const xssOfferFired = await page.evaluate(() => {
        return (window as unknown as { __xss_offer?: boolean }).__xss_offer;
      });
      expect(xssOfferFired).toBeUndefined();

      // Verify no unescaped script tag or onerror exists in main UI DOM tree
      const unescapedNodes = await page.evaluate(() => {
        return document.querySelectorAll('main script, main img[onerror]').length;
      });
      expect(unescapedNodes).toBe(0);
    });

    test('form input fields resist DOM XSS when typing attack payloads', async ({ page }) => {
      let dialogFired = false;
      page.on('dialog', async (dialog) => {
        dialogFired = true;
        await dialog.dismiss();
      });

      await authenticateSession(page);
      await page.goto('/search');

      await expect(page.getByRole('heading', { name: 'Search Flights' })).toBeVisible();

      // Type attack payloads into DOM input fields
      const originInput = page.locator('#origin');
      const destInput = page.locator('#destination');

      // Fill with XSS payloads using standard DOM interactions
      await originInput.fill('<script>alert(1)</script>');
      await destInput.fill('"><img src=x onerror="alert(1)">');

      // Check input elements hold safe text value without executing
      expect(dialogFired).toBe(false);

      // Verify DOM structure is intact and inputs have not broken out into executable HTML
      const brokenOutElements = await page.evaluate(() => {
        return document.querySelectorAll('img[src="x"]').length;
      });
      expect(brokenOutElements).toBe(0);
      expect(dialogFired).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // b. Safe Return Target & Open Redirect Prevention
  // ---------------------------------------------------------------------------
  test.describe('Safe Return Target & Open Redirect Prevention', () => {

    test('browser profile navigation with open redirect returnTo parameter stays bounded to internal route', async ({
      page,
    }) => {
      await authenticateSession(page);

      // Attempt open redirect via returnTo query parameter on /profile
      await page.goto('/profile?returnTo=https://evil.com');

      // Ensure browser origin stays bounded to local origin and never navigates to external host
      expect(new URL(page.url()).origin).toBe('http://127.0.0.1:3000');
      expect(page.url()).not.toContain('evil.com/');

      // Verify no outbound link pointing to evil.com was rendered
      const evilLinks = page.locator('a[href*="evil.com"]');
      await expect(evilLinks).toHaveCount(0);
    });

    test('browser checkout page ignores malicious returnTo links preventing outbound redirect', async ({
      page,
    }) => {
      await authenticateSession(page);
      await setMockScenario(page, 'international-offer');

      // Attempt protocol-relative open redirect via returnTo on checkout
      await page.goto('/checkout/passengers?offerId=off_test123&returnTo=//evil.com');

      // Verify no anchor link points to evil.com
      const evilLinks = page.locator('a[href*="evil.com"]');
      await expect(evilLinks).toHaveCount(0);

      // When given valid return target, back link specifically renders to internal route
      await page.goto('/checkout/passengers?offerId=off_test123&returnTo=/bookings');
      const backLink = page.getByRole('link', { name: /back to previous workspace/i }).first();
      await expect(backLink).toBeVisible();
      await expect(backLink).toHaveAttribute('href', '/bookings');
    });
  });

  // ---------------------------------------------------------------------------
  // c. Authentication Boundaries & Route Protection
  // ---------------------------------------------------------------------------
  test.describe('Authentication Boundaries & Route Protection', () => {
    test('unauthenticated visit to /dashboard redirects cleanly to login with zero data leakage', async ({
      page,
      context,
    }) => {
      test.setTimeout(90_000);
      await context.clearCookies();

      await page.goto('/dashboard');

      // Verify redirection to login
      await expect(page).toHaveURL(/.*\/login(\?callbackUrl=.*dashboard)?/, { timeout: 60_000 });
      await expect(page.getByRole('heading', { name: 'Plan the next move.' })).toBeVisible({ timeout: 60_000 });

      // Verify zero private user data leaked in HTML/DOM
      const content = await page.content();
      expect(content).not.toContain('Total Bookings');
      expect(content).not.toContain('Upcoming Bookings');
      expect(content).not.toContain('Completed Bookings');
      expect(content).not.toContain('Recent Bookings');
      expect(content).not.toContain(AUDIT_EMAIL);
    });

    test('unauthenticated visit to /bookings redirects cleanly to login with zero booking leakage', async ({
      page,
      context,
    }) => {
      test.setTimeout(90_000);
      await context.clearCookies();

      await page.goto('/bookings', { timeout: 60_000 });

      // Verify redirection to login
      await expect(page).toHaveURL(/.*\/login/, { timeout: 60_000 });
      await expect(page.getByRole('heading', { name: 'Plan the next move.' })).toBeVisible({ timeout: 60_000 });

      // Verify no booking reservation numbers or private itinerary content leaked
      const content = await page.content();
      expect(content).not.toContain('Upcoming flights');
      expect(content).not.toContain('Past bookings');
      expect(content).not.toContain('Booking Reference');
    });

    test('unauthenticated visit to /profile redirects cleanly to login with zero PII leakage', async ({
      page,
      context,
    }) => {
      await context.clearCookies();

      await page.goto('/profile');

      // Verify redirection to login
      await expect(page).toHaveURL(/.*\/login/);
      await expect(page.getByRole('heading', { name: 'Plan the next move.' })).toBeVisible();

      // Verify zero traveler profile PII fields leaked
      const content = await page.content();
      expect(content).not.toContain('Passport Number');
      expect(content).not.toContain('Traveler profile');
      expect(content).not.toContain('Date of birth');
    });

    test('unauthenticated visit to /checkout/passengers redirects cleanly to login', async ({
      page,
      context,
    }) => {
      await context.clearCookies();

      await page.goto('/checkout/passengers?offerId=off_test123');

      // Verify redirection to login
      await expect(page).toHaveURL(/.*\/login/);
      await expect(page.getByRole('heading', { name: 'Plan the next move.' })).toBeVisible();

      // Verify no passenger form rendered
      const content = await page.content();
      expect(content).not.toContain('Passenger Details');
    });
  });

async function authenticateViaNextAuthCallback(page: Page): Promise<{
  sessionCookieHeader: string;
}> {
  const csrfRes = await page.request.get('/api/auth/csrf');
  expect(csrfRes.ok()).toBe(true);
  const csrfData = (await csrfRes.json()) as { csrfToken?: string };
  const csrfToken = csrfData.csrfToken;
  expect(csrfToken).toBeTruthy();

  const callbackRes = await page.request.post('/api/auth/callback/credentials', {
    form: {
      csrfToken: csrfToken || '',
      email: AUDIT_EMAIL,
      password: AUDIT_PASSWORD,
      callbackUrl: 'http://127.0.0.1:3000/',
      json: 'true',
    },
  });
  expect(callbackRes.ok()).toBe(true);

  const rawHeaders = callbackRes.headersArray();
  const sessionCookieHeader = rawHeaders.find(
    (h) => h.name.toLowerCase() === 'set-cookie' && h.value.includes('next-auth.session-token'),
  )?.value;

  return { sessionCookieHeader: sessionCookieHeader || '' };
}

  // ---------------------------------------------------------------------------
  // d. Cookie Security & Header Configuration
  // ---------------------------------------------------------------------------
  test.describe('Cookie Security & Header Configuration', () => {
    test('session cookies have HttpOnly and SameSite attributes strictly configured', async ({
      page,
      context,
    }) => {
      const { sessionCookieHeader } = await authenticateViaNextAuthCallback(page);

      // Authenticate through real NextAuth callback and inspect application-issued set-cookie header on response
      expect(sessionCookieHeader).toBeTruthy();
      expect(sessionCookieHeader).toMatch(/HttpOnly/i);
      expect(sessionCookieHeader).toMatch(/SameSite=Lax/i);
      expect(sessionCookieHeader).toMatch(/Path=\//i);

      // Verify browser context reflects application-issued session cookie attributes
      const cookies = await context.cookies();
      const sessionCookie = cookies.find((c) => c.name === 'next-auth.session-token');

      expect(sessionCookie).toBeDefined();
      expect(sessionCookie?.httpOnly).toBe(true);
      expect(sessionCookie?.sameSite.toLowerCase()).toBe('lax');
      expect(sessionCookie?.path).toBe('/');
    });

    test('production NextAuth options contract enforces Secure cookie policy and __Secure- prefix', () => {
      const prodConfig = getAuthCookieConfig({ NODE_ENV: 'production' });
      expect(prodConfig.useSecureCookies).toBe(true);
      expect(prodConfig.sessionToken.name).toBe('__Secure-next-auth.session-token');
      expect(prodConfig.sessionToken.options.secure).toBe(true);
      expect(prodConfig.sessionToken.options.httpOnly).toBe(true);
      expect(prodConfig.sessionToken.options.sameSite).toBe('lax');
      expect(prodConfig.sessionToken.options.path).toBe('/');

      const httpsConfig = getAuthCookieConfig({
        NODE_ENV: 'development',
        NEXTAUTH_URL: 'https://staging.example.com',
      });
      expect(httpsConfig.useSecureCookies).toBe(true);
      expect(httpsConfig.sessionToken.name).toBe('__Secure-next-auth.session-token');
      expect(httpsConfig.sessionToken.options.secure).toBe(true);
    });

    test('client-side JavaScript cannot access HttpOnly session tokens via document.cookie', async ({
      page,
    }) => {
      await authenticateViaNextAuthCallback(page);
      await page.goto('/search');

      // Evaluate document.cookie from browser execution context
      const accessibleCookies = await page.evaluate(() => document.cookie);

      // HttpOnly session token must NOT be visible to client script
      expect(accessibleCookies).not.toContain('next-auth.session-token');
    });

    test('web responses deliver correct Content-Type and secure headers without stack traces', async ({
      page,
    }) => {
      const response = await page.goto('/login');
      expect(response).not.toBeNull();
      expect(response?.status()).toBe(200);

      const headers = response?.headers() || {};
      // Verify HTML content type is properly delivered
      expect(headers['content-type']).toContain('text/html');

      // Security headers configured via next.config.mjs
      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['x-frame-options']?.toUpperCase()).toBe('SAMEORIGIN');
      expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');

      // Response body contains HTML without server stack traces or unhandled error dumps
      const body = await page.content();
      expect(body).not.toContain('Unhandled Runtime Error');
      expect(body).not.toContain('Internal Server Error');
      expect(body).not.toContain('Call Stack');
      expect(body).not.toContain('Traceback');
    });
  });
});
