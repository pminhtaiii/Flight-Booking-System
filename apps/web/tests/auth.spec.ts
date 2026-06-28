import { test, expect } from '@playwright/test';

test.describe('User Authentication Flows', () => {
  const testEmail = `newuser-${Date.now()}@example.com`;
  const duplicateEmail = 'duplicate@example.com';
  const password = 'Password123!';

  test.beforeEach(async ({ request, context }) => {
    // Reset databases and lockouts before each test via API test-only reset
    const res = await request.post('http://localhost:3001/api/auth/test/reset-lockout', {
      data: { clearAll: true },
    });
    expect(res.status()).toBe(200);
    await context.clearCookies();
  });

  test.describe('Registration', () => {
    test('should successfully register a user and redirect to dashboard', async ({ page }) => {
      await page.goto('/register');
      await page.fill('input[name="email"]', testEmail);
      await page.fill('input[name="password"]', password);
      await page.click('button[type="submit"]');

      // Verify redirection to /dashboard
      await expect(page).toHaveURL(/\/dashboard/);

      // Verify session cookie populated and user email rendered
      const cookies = await page.context().cookies();
      const sessionCookie = cookies.find((c) => c.name.includes('session'));
      expect(sessionCookie).toBeDefined();

      await expect(page.locator('text=' + testEmail.toLowerCase())).toBeVisible();
    });

    test('should display inline validation warning for weak password', async ({ page }) => {
      await page.goto('/register');
      await page.fill('input[name="email"]', 'weak@example.com');
      await page.fill('input[name="password"]', '123'); // weak
      await page.click('button[type="submit"]');

      // Page remains on /register and shows password strength warning
      await expect(page).toHaveURL(/\/register/);
      const errorMsg = page.locator('.error-message');
      await expect(errorMsg).toBeVisible();
    });

    test('should display safe error for duplicate email registration', async ({ page }) => {
      // Register duplicate email first
      await page.goto('/register');
      await page.fill('input[name="email"]', duplicateEmail);
      await page.fill('input[name="password"]', password);
      await page.click('button[type="submit"]');
      await expect(page).toHaveURL(/\/dashboard/);

      // Log out
      await page.click('text=/sign out|log out|logout/i');
      await expect(page).toHaveURL(/\/login/);

      // Attempt second registration with same email
      await page.goto('/register');
      await page.fill('input[name="email"]', duplicateEmail);
      await page.fill('input[name="password"]', password);
      await page.click('button[type="submit"]');

      // Verify safe generic error and that we remain on the registration page
      await expect(page).toHaveURL(/\/register/);
      const errorMsg = page.locator('text=/failed|conflict|error|already/i');
      await expect(errorMsg).toBeVisible();
      // Ensure it doesn't leak specific detail about account existence
      await expect(page.locator('text=/enumeration|exists/i')).not.toBeVisible();
    });
  });

  test.describe('Login & Navigation redirects', () => {
    test.beforeEach(async ({ page }) => {
      // Ensure test user is registered
      await page.goto('/register');
      await page.fill('input[name="email"]', 'registered@example.com');
      await page.fill('input[name="password"]', password);
      await page.click('button[type="submit"]');
      await expect(page).toHaveURL(/\/dashboard/);
      await page.click('text=/sign out|log out|logout/i');
      await expect(page).toHaveURL(/\/login/);
    });

    test('should successfully log in returning user and redirect to dashboard', async ({
      page,
    }) => {
      await page.goto('/login');
      await page.fill('input[name="email"]', 'registered@example.com');
      await page.fill('input[name="password"]', password);
      await page.click('button[type="submit"]');

      await expect(page).toHaveURL(/\/dashboard/);
    });

    test('should display generic UI error message for invalid credentials', async ({ page }) => {
      await page.goto('/login');
      await page.fill('input[name="email"]', 'registered@example.com');
      await page.fill('input[name="password"]', 'WrongPassword!');
      await page.click('button[type="submit"]');

      await expect(page).toHaveURL(/\/login/);
      const errorAlert = page.locator('text=Invalid email or password');
      await expect(errorAlert).toBeVisible();
    });

    test('should automatically redirect authenticated user visiting login or register to dashboard', async ({
      page,
    }) => {
      // Log in
      await page.goto('/login');
      await page.fill('input[name="email"]', 'registered@example.com');
      await page.fill('input[name="password"]', password);
      await page.click('button[type="submit"]');
      await expect(page).toHaveURL(/\/dashboard/);

      // Visit /login
      await page.goto('/login');
      await expect(page).toHaveURL(/\/dashboard/);

      // Visit /register
      await page.goto('/register');
      await expect(page).toHaveURL(/\/dashboard/);
    });
  });

  test.describe('Logout & History Checks', () => {
    test('should log out user, clear cookies, and prevent browser back button navigation to protected page', async ({
      page,
    }) => {
      // Register & log in
      await page.goto('/register');
      await page.fill('input[name="email"]', 'logout-flow@example.com');
      await page.fill('input[name="password"]', password);
      await page.click('button[type="submit"]');
      await expect(page).toHaveURL(/\/dashboard/);

      // Perform logout
      await page.click('text=/sign out|log out|logout/i');
      await expect(page).toHaveURL(/\/login/);

      // Verify cookies are cleared
      const cookies = await page.context().cookies();
      const sessionCookie = cookies.find((c) => c.name.includes('session'));
      expect(sessionCookie).toBeUndefined();

      // Click browser back button
      await page.goBack();

      // Should be redirected back to /login because dashboard session check detects no token
      await expect(page).toHaveURL(/\/login/);
    });
  });
});
