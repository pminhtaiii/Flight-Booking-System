/* eslint-disable no-console */
import { test, expect } from '@playwright/test';

test.describe('Dashboard and Session Flows', () => {
  const email = 'dashboard-test@example.com';
  const password = 'Password123!';

  test.beforeEach(async ({ request, context }) => {
    const res = await request.post('http://localhost:3001/api/auth/test/reset-lockout', {
      data: { clearAll: true },
    });
    expect(res.status()).toBe(200);
    await context.clearCookies();
  });

  test('should redirect unauthenticated user visiting dashboard to login page', async ({
    page,
  }) => {
    // Navigate to dashboard unauthenticated
    await page.goto('/dashboard');

    // Verify redirection to /login
    await expect(page).toHaveURL(/\/login/);
  });

  test('should render user email on dashboard when authenticated', async ({ page }) => {
    // Register and automatically log in
    await page.goto('/register');
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await page.click('button[type="submit"]');

    await expect(page).toHaveURL(/\/dashboard/);

    // Verify /auth/me resolves and email is printed
    await expect(page.locator('text=' + email)).toBeVisible();
  });

  test('should handle token expiration by clearing session and redirecting to login with message', async ({
    page,
  }) => {
    page.on('console', (msg) => console.log('PAGE LOG:', msg.text()));
    page.on('pageerror', (err) => console.log('PAGE ERROR:', err.message));

    // Log in
    await page.goto('/register');
    await page.fill('input[name="email"]', 'expiry@example.com');
    await page.fill('input[name="password"]', password);
    await page.click('button[type="submit"]');

    try {
      await expect(page).toHaveURL(/\/dashboard/, { timeout: 5000 });
    } catch (e) {
      const errorMsg = await page
        .locator('.error-message')
        .textContent()
        .catch(() => 'no error message');
      console.log('REGISTRATION ERROR ON PAGE:', errorMsg);
      await page.screenshot({ path: 'registration_failure.png' });
      throw e;
    }

    // Simulate token expiry by injecting an expired session cookie
    const cookies = await page.context().cookies();
    const sessionCookie = cookies.find((c) => c.name.includes('session'));

    if (sessionCookie) {
      // Overwrite the session cookie with a dummy expired one or remove it to force 401
      await page.context().addCookies([
        {
          name: sessionCookie.name,
          value: 'expired-jwt-token',
          domain: sessionCookie.domain,
          path: sessionCookie.path,
          expires: Math.floor(Date.now() / 1000) - 3600, // expired 1 hour ago
        },
      ]);
    }

    // Refresh page or trigger control to trigger backend API call (GET /auth/me) which returns 401
    await page.reload();

    // Verify client redirects to /login?message=session_expired (or has expired query param)
    await expect(page).toHaveURL(/.*login.*message=session_expired.*/);

    // Verify warning banner
    const warning = page.locator('text=/expired|log in again/i');
    await expect(warning).toBeVisible();
  });

  test('should synchronize logout across multiple tabs', async ({ context, page: page1 }) => {
    // Register and log in on Tab 1
    await page1.goto('/register');
    await page1.fill('input[name="email"]', 'multitab@example.com');
    await page1.fill('input[name="password"]', password);
    await page1.click('button[type="submit"]');
    await expect(page1).toHaveURL(/\/dashboard/);

    // Open Tab 2 within the same authenticated browser context
    const page2 = await context.newPage();
    await page2.goto('/dashboard');
    await expect(page2).toHaveURL(/\/dashboard/);
    await expect(page2.locator('text=multitab@example.com')).toBeVisible();

    // Log out on Tab 1
    await page1.locator('button:has-text("Sign Out")').click();
    await expect(page1).toHaveURL(/\/login/);

    // Try to perform action or reload Tab 2
    await page2.reload();

    // Tab 2 should be redirected to login because session was cleared
    await expect(page2).toHaveURL(/\/login/);
  });
});
