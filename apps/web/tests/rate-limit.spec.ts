import { test, expect } from '@playwright/test';

test.describe('Rate Limiting and Lockout UI', () => {
  const email = 'lockout-ui@example.com';
  const password = 'Password123!';

  test.beforeEach(async ({ page, request }) => {
    // Reset database and lockout state
    const res = await request.post('http://localhost:3001/api/auth/test/reset-lockout', {
      data: { clearAll: true }
    });
    expect(res.status()).toBe(200);
    await page.context().clearCookies();

    // Register a valid user
    await page.goto('/register');
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/dashboard/);
    
    // Log out to return to login screen
    await page.click('text=/sign out|log out|logout/i');
    await expect(page).toHaveURL(/\/login/);
  });

  test('should display lockout message, disable submit button, and allow login after reset', async ({ page, request }) => {
    await page.goto('/login');
    await page.fill('input[name="email"]', email);

    // 1. Submit 5 failed logins on /login form
    for (let i = 0; i < 5; i++) {
      await page.fill('input[name="password"]', 'WrongPassword!');
      await page.click('button[type="submit"]');
      
      // Wait for UI to render invalid credentials error
      await expect(page.locator('text=Invalid email or password')).toBeVisible();
    }

    // 2. 6th submit should trigger lockout message
    await page.fill('input[name="password"]', 'WrongPassword!');
    await page.click('button[type="submit"]');

    const lockoutMessage = page.locator('.error-message');
    await expect(lockoutMessage).toBeVisible();

    // 3. Verify the form submit button is disabled and displays the remaining wait time
    const submitButton = page.locator('button[type="submit"]');
    await expect(submitButton).toBeDisabled();
    await expect(submitButton).toHaveText(/wait|minute|second|60/i);

    // 4. Call test-only reset endpoint to clear lockout
    const res2 = await request.post('http://localhost:3001/api/auth/test/reset-lockout', {
      data: { clearAll: true }
    });
    expect(res2.status()).toBe(200);

    // Reload or wait for state refresh, let's reload to reset page state
    await page.goto('/login');
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);

    // Verify submit button is enabled again
    await expect(submitButton).toBeEnabled();

    // Submit correct credentials
    await page.click('button[type="submit"]');

    // Verify login succeeds
    await expect(page).toHaveURL(/\/dashboard/);
  });
});
