import { expect, test } from '@playwright/test';

test('revokes the API bearer token when the public API URL is not configured', async ({ page, request, context }) => {
  await request.post('http://127.0.0.1:3001/api/auth/test/reset-lockout', {
    data: { clearAll: true },
  });
  await context.clearCookies();

  const email = `logout-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  await page.goto('http://localhost:3000/register');
  await page.getByRole('textbox', { name: 'Email' }).fill(email);
  await page.getByRole('textbox', { name: 'Password' }).fill('Password123!');
  await page.getByRole('button', { name: 'Create account' }).click();

  await page.goto('http://localhost:3000/bookings');
  const logoutRequest = page.waitForRequest('http://localhost:3001/api/auth/logout');
  await page.getByRole('button', { name: 'Sign Out' }).click();

  const requestToLogout = await logoutRequest;
  const authorization = requestToLogout.headers().authorization;
  expect(authorization).toMatch(/^Bearer .+/);
  await expect(page).toHaveURL(/\/login$/);

  await expect.poll(async () => {
    const response = await request.get('http://127.0.0.1:3001/api/auth/me', {
      headers: { Authorization: authorization },
    });
    return response.status();
  }).toBe(401);
});
