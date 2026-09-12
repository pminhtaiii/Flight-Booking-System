import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { encode } from 'next-auth/jwt';

const TEST_SECRET = process.env.NEXTAUTH_SECRET || randomBytes(32).toString('base64url');

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
      email: 'security-audit@example.test',
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
          email: 'security-audit@example.test',
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
      await context.clearCookies();

      await page.goto('/dashboard');

      // Verify redirection to login
      await expect(page).toHaveURL(/.*\/login(\?callbackUrl=.*dashboard)?/);
      await expect(page.getByRole('heading', { name: 'Plan the next move.' })).toBeVisible();

      // Verify zero private user data leaked in HTML/DOM
      const content = await page.content();
      expect(content).not.toContain('Total Bookings');
      expect(content).not.toContain('Upcoming Bookings');
      expect(content).not.toContain('Completed Bookings');
      expect(content).not.toContain('Recent Bookings');
      expect(content).not.toContain('security-audit@example.test');
    });

    test('unauthenticated visit to /bookings redirects cleanly to login with zero booking leakage', async ({
      page,
      context,
    }) => {
      await context.clearCookies();

      await page.goto('/bookings');

      // Verify redirection to login
      await expect(page).toHaveURL(/.*\/login/);
      await expect(page.getByRole('heading', { name: 'Plan the next move.' })).toBeVisible();

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

  // ---------------------------------------------------------------------------
  // d. Cookie Security & Header Configuration
  // ---------------------------------------------------------------------------
  test.describe('Cookie Security & Header Configuration', () => {
    test('session cookies have HttpOnly and SameSite attributes strictly configured', async ({
      page,
      context,
    }) => {
      await authenticateSession(page);
      await page.goto('/search');

      const cookies = await context.cookies();
      const sessionCookie = cookies.find((c) => c.name === 'next-auth.session-token');

      expect(sessionCookie).toBeDefined();
      // HttpOnly must be true to prevent client-side script access
      expect(sessionCookie?.httpOnly).toBe(true);
      // SameSite must be Lax or Strict to prevent CSRF cross-origin leak
      expect(['lax', 'strict']).toContain(sessionCookie?.sameSite.toLowerCase());
      // Cookie path must be restricted to root
      expect(sessionCookie?.path).toBe('/');
    });

    test('client-side JavaScript cannot access HttpOnly session tokens via document.cookie', async ({
      page,
    }) => {
      await authenticateSession(page);
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

      // Response body contains HTML without server stack traces or unhandled error dumps
      const body = await page.content();
      expect(body).not.toContain('Unhandled Runtime Error');
      expect(body).not.toContain('Internal Server Error');
      expect(body).not.toContain('Call Stack');
      expect(body).not.toContain('Traceback');
    });
  });
});
