import { expect, test, type Page, type APIRequestContext, type BrowserContext } from '@playwright/test';

const emptyProfile = {
  profileId: null,
  identity: null,
  contact: null,
  travelDocument: null,
  preferences: null,
  revision: 0,
};

const savedDomesticProfile = {
  profileId: 'profile-test-1',
  identity: {
    givenName: 'Jane',
    middleName: null,
    familyName: 'Doe',
    dateOfBirth: '1995-05-05',
    gender: 'female',
    title: 'ms',
  },
  contact: {
    email: 'jane.doe@example.com',
    phoneCountryCode: '+84',
    phoneNumber: '901234567',
  },
  travelDocument: null,
  preferences: {
    seatPreference: 'window',
    classPreference: 'economy',
  },
  revision: 1,
  updatedAt: '2026-08-02T00:00:00.000Z',
};

async function registerAndOpenProfile(
  page: Page,
  request: APIRequestContext,
  context: BrowserContext,
): Promise<void> {
  await request.post('http://127.0.0.1:3001/api/auth/test/reset-lockout', {
    data: { clearAll: true },
  }).catch(() => {});
  await context.clearCookies();

  const email = `profile-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  await page.goto('/register');
  await page.getByRole('textbox', { name: 'Email' }).fill(email);
  await page.getByRole('textbox', { name: 'Password' }).fill('Password123!');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/127.0.0.1:3000\/$/, { timeout: 30000 });
  await page.goto('/profile');
  await expect(page.getByRole('heading', { name: 'Keep every detail ready for takeoff.' })).toBeVisible();
}

async function fillDomesticProfile(page: Page): Promise<void> {
  await page.getByLabel('Title').selectOption('ms');
  await page.getByLabel('Given name').fill('Jane');
  await page.getByLabel('Family name').fill('Doe');
  await page.getByLabel('Date of birth').fill('1995-05-05');
  await page.getByLabel('Gender').selectOption('female');
  await page.getByLabel('Email address').fill('jane.doe@example.com');
  await page.getByLabel('Phone country code').selectOption('+84');
  await page.getByLabel('Phone number', { exact: true }).fill('901234567');
}

test.describe('Secure traveler profile', () => {
  test('shows every profile section and saves a domestic profile without a document', async ({ page, request, context }) => {
    await registerAndOpenProfile(page, request, context);

    await expect(page.getByRole('heading', { name: 'Identity' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Contact details' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Travel document' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Travel preferences' })).toBeVisible();
    await expect(page.getByLabel('Phone country code')).toBeVisible();
    await expect(page.getByLabel('Phone number', { exact: true })).toBeVisible();

    await page.route('**/api/profile', async (route) => {
      if (route.request().method() === 'PATCH') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(savedDomesticProfile) });
        return;
      }
      await route.continue();
    });

    await fillDomesticProfile(page);
    await page.getByRole('button', { name: 'Save profile' }).click();
    await expect(page.getByRole('status')).toHaveText('Your traveler profile is saved securely.');
    await expect(page).toHaveURL(/\/profile$/);
    await expect(page).not.toHaveURL(/jane\.doe|901234567/);

    const browserStorageDump = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
    expect(browserStorageDump).not.toContain('Jane');
    expect(browserStorageDump).not.toContain('jane.doe');
    expect(browserStorageDump).not.toContain('901234567');
  });

  test('returns to the server-validated handoff target after saving', async ({ page, request, context }) => {
    await registerAndOpenProfile(page, request, context);
    await page.goto('/profile?returnTo=%2Fprototype%2Fchat');

    await page.route('**/api/profile', async (route) => {
      if (route.request().method() === 'PATCH') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(savedDomesticProfile) });
        return;
      }
      await route.continue();
    });

    await fillDomesticProfile(page);
    await page.getByRole('button', { name: 'Save profile' }).click();

    await expect(page).toHaveURL(/\/prototype\/chat$/);
    await expect(page).not.toHaveURL(/jane\.doe|901234567/);
  });

  test('recovers from a stale revision without overwriting the latest profile', async ({ page, request, context }) => {
    await registerAndOpenProfile(page, request, context);
    await fillDomesticProfile(page);

    let reloadRequested = false;
    await page.route('**/api/profile', async (route) => {
      if (route.request().method() === 'PATCH') {
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'PROFILE_UPDATE_CONFLICT', message: 'PROFILE_UPDATE_CONFLICT' }),
        });
        return;
      }

      if (route.request().method() === 'GET' && reloadRequested) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(savedDomesticProfile) });
        return;
      }

      await route.continue();
    });

    await page.getByRole('button', { name: 'Save profile' }).click();
    await expect(page.getByRole('alert').first()).toContainText('This profile changed in another tab.');

    reloadRequested = true;
    await page.getByRole('button', { name: 'Reload latest profile' }).click();
    await expect(page.getByText('Revision 1')).toBeVisible();
    await expect(page.getByLabel('Given name')).toHaveValue('Jane');
  });
});
