import { expect, test } from '@playwright/test';
import { encode } from 'next-auth/jwt';

async function authenticateAncillaryScenario(context: Parameters<typeof test>[0]['context']): Promise<void> {
  const sessionToken = await encode({
    secret: 'test_secret',
    token: {
      sub: 'phase4-user',
      id: 'phase4-user',
      accessToken: 'phase4-access-token',
      name: 'Phase Four Traveller',
      email: 'phase4@example.com',
    },
  });
  await context.addCookies([
    { name: 'next-auth.session-token', value: sessionToken, url: 'http://localhost:3000', httpOnly: true, sameSite: 'Lax' },
    { name: 'mock-scenario', value: 'mock-ancillary-phase4', url: 'http://localhost:3000', sameSite: 'Lax' },
  ]);
}

test.describe('Phase 4 ancillary checkout', () => {
  test('keeps seat choices isolated across eligible travellers and segments with exact instant totals', async ({ page, context }) => {
    await authenticateAncillaryScenario(context);
    const repricingRequests: string[] = [];
    page.on('request', (request) => {
      if (/reprice|payment|orders/.test(request.url())) repricingRequests.push(request.url());
    });

    await page.goto('/checkout/mock-intent-id/ancillaries');

    await expect(page.getByRole('tablist', { name: 'Flight segments' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Lap Infant' })).toHaveCount(0);
    await expect(page.getByText(/Lap infants are omitted/)).toBeVisible();

    await page.getByRole('gridcell', { name: /1A.*available/ }).click();
    await expect(page.getByText('$110.15').first()).toBeVisible();

    const travellerOne = page.getByRole('tab', { name: 'Alex' });
    await travellerOne.focus();
    await travellerOne.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Blair' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('gridcell', { name: /1A.*selected by traveller 1/ })).toBeDisabled();

    await page.getByRole('tab', { name: 'SGN → NRT' }).click();
    await page.getByRole('gridcell', { name: /2A.*available/ }).click();
    await expect(page.getByText('$122.35').first()).toBeVisible();
    expect(repricingRequests).toEqual([]);
  });
});
