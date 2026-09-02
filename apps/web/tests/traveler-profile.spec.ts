import {
  expect,
  test,
  type Page,
  type APIRequestContext,
  type BrowserContext,
} from '@playwright/test';

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

const savedInternationalProfile = {
  profileId: 'profile-test-2',
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
  travelDocument: {
    documentType: 'passport',
    passportNumber: 'N12345678',
    passportExpiry: '2030-12-31',
    issuingCountry: 'VN',
    nationality: 'VN',
  },
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
  initialReturnTo?: string,
): Promise<void> {
  await request
    .post('http://127.0.0.1:3001/api/auth/test/reset-lockout', {
      data: { clearAll: true },
    })
    .catch(() => {});
  await context.clearCookies();

  const email = `profile-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  await page.goto('/register');
  await page.getByRole('textbox', { name: 'Email' }).fill(email);
  await page.getByRole('textbox', { name: 'Password' }).fill('Password123!');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/127.0.0.1:3000\/$/, { timeout: 30000 });

  const targetUrl = initialReturnTo
    ? `/profile?returnTo=${encodeURIComponent(initialReturnTo)}`
    : '/profile';
  await page.goto(targetUrl);

  // If initial cold-render redirected to login, log in directly and navigate
  if (page.url().includes('/login')) {
    await page.getByRole('textbox', { name: 'Email address' }).fill(email);
    await page.getByRole('textbox', { name: 'Password' }).fill('Password123!');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/127.0.0.1:3000\/$/, { timeout: 30000 });
    await page.goto(targetUrl);
  }

  await expect(
    page.getByRole('heading', { name: 'Keep every detail ready for takeoff.' }),
  ).toBeVisible({ timeout: 30000 });
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

async function fillInternationalDocumentAndPreferences(page: Page): Promise<void> {
  await page.getByLabel('Document type').selectOption('passport');
  await page.getByLabel('Passport number', { exact: true }).fill('N12345678');
  await page.getByLabel('Passport expiry').fill('2030-12-31');
  await page.getByLabel('Issuing country').selectOption('VN');
  await page.getByLabel('Nationality').selectOption('VN');
  await page.getByLabel('Seat preference').selectOption('window');
  await page.getByLabel('Cabin preference').selectOption('economy');
}

test.describe('Secure traveler profile', () => {
  test.setTimeout(90000);

  test('shows every profile section and saves a domestic profile without a document', async ({
    page,
    request,
    context,
  }) => {
    await registerAndOpenProfile(page, request, context);

    await expect(page.getByRole('heading', { name: 'Identity' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Contact details' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Travel document' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Travel preferences' })).toBeVisible();
    await expect(page.getByLabel('Phone country code')).toBeVisible();
    await expect(page.getByLabel('Phone number', { exact: true })).toBeVisible();

    await page.route('**/api/profile', async (route) => {
      if (route.request().method() === 'PATCH') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(savedDomesticProfile),
        });
        return;
      }
      await route.continue();
    });

    await fillDomesticProfile(page);
    await page.getByRole('button', { name: 'Save profile' }).click();
    await expect(page.getByRole('status')).toHaveText('Your traveler profile is saved securely.');
    await expect(page).toHaveURL(/\/profile$/);
    await expect(page).not.toHaveURL(/jane\.doe|901234567/);

    const browserStorageDump = await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    );
    expect(browserStorageDump).not.toContain('Jane');
    expect(browserStorageDump).not.toContain('jane.doe');
    expect(browserStorageDump).not.toContain('901234567');
  });

  test('saves canonical airline preferences', async ({ page, request, context }) => {
    await registerAndOpenProfile(page, request, context);

    await page.route('**/api/profile', async (route) => {
      if (route.request().method() === 'PATCH') {
        const requestBody = route.request().postDataJSON();
        expect(requestBody.preferences).toMatchObject({
          preferredAirlines: ['VN', 'SQ'],
          blacklistedAirlines: ['AA', '9W'],
        });

        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ...savedDomesticProfile,
            revision: 2,
            preferences: {
              ...savedDomesticProfile.preferences,
              preferredAirlines: ['VN', 'SQ'],
              blacklistedAirlines: ['AA', '9W'],
            },
          }),
        });
        return;
      }
      await route.continue();
    });

    await fillDomesticProfile(page);
    await page.getByLabel('Preferred airlines').fill(' vn, SQ, vn ');
    await page.getByLabel('Blacklisted airlines').fill('aa, 9w');
    await page.getByRole('button', { name: 'Save profile' }).click();

    await expect(page.getByRole('status')).toHaveText('Your traveler profile is saved securely.');
    await expect(page.getByLabel('Preferred airlines')).toHaveValue('VN, SQ');
    await expect(page.getByLabel('Blacklisted airlines')).toHaveValue('AA, 9W');
  });

  test('returns to the server-validated handoff target after saving', async ({
    page,
    request,
    context,
  }) => {
    await page.route('**/api/profile', async (route) => {
      if (route.request().method() === 'PATCH') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(savedDomesticProfile),
        });
        return;
      }
      await route.continue();
    });

    await registerAndOpenProfile(page, request, context, '/prototype/chat');
    await fillDomesticProfile(page);
    await page.getByRole('button', { name: 'Save profile' }).click();
    await page.getByRole('link', { name: /Return and continue booking/i }).click();

    await expect(page).toHaveURL(/.*\/prototype\/chat$/, { timeout: 15000 });
    await expect(page).not.toHaveURL(/jane\.doe|901234567/);
  });

  test('recovers from a stale revision without overwriting the latest profile', async ({
    page,
    request,
    context,
  }) => {
    await registerAndOpenProfile(page, request, context);
    await fillDomesticProfile(page);

    let reloadRequested = false;
    await page.route('**/api/profile', async (route) => {
      if (route.request().method() === 'PATCH') {
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'PROFILE_UPDATE_CONFLICT',
            message: 'PROFILE_UPDATE_CONFLICT',
          }),
        });
        return;
      }

      if (route.request().method() === 'GET' && reloadRequested) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(savedDomesticProfile),
        });
        return;
      }

      await route.continue();
    });

    await page.getByRole('button', { name: 'Save profile' }).click();
    await expect(page.getByRole('alert').first()).toContainText(
      'This profile changed in another tab.',
    );

    reloadRequested = true;
    await page.getByRole('button', { name: 'Reload latest profile' }).click();
    await expect(page.getByText('Revision 1')).toBeVisible();
    await expect(page.getByLabel('Given name')).toHaveValue('Jane');
  });

  test('saves an international traveler profile with passport document and asserts zero PII leakage', async ({
    page,
    request,
    context,
  }) => {
    const consoleMessages: string[] = [];
    page.on('console', (msg) => consoleMessages.push(msg.text()));

    await registerAndOpenProfile(page, request, context);

    await page.route('**/api/profile', async (route) => {
      if (route.request().method() === 'PATCH') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(savedInternationalProfile),
        });
        return;
      }
      await route.continue();
    });

    await fillDomesticProfile(page);
    await fillInternationalDocumentAndPreferences(page);

    await page.getByRole('button', { name: 'Save profile' }).click();
    await expect(page.getByRole('status')).toHaveText('Your traveler profile is saved securely.');

    await expect(page.getByText('•••• 5678')).toBeVisible();
    await expect(page.getByRole('strong').filter({ hasText: 'Passport' })).toBeVisible();
    await expect(page.getByRole('strong').filter({ hasText: 'VN' })).toBeVisible();

    await expect(page).toHaveURL(/\/profile$/);
    await expect(page).not.toHaveURL(/N12345678|1995-05-05|jane\.doe|901234567/);

    const browserStorageDump = await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    );
    expect(browserStorageDump).not.toContain('N12345678');
    expect(browserStorageDump).not.toContain('1995-05-05');
    expect(browserStorageDump).not.toContain('jane.doe');
    expect(browserStorageDump).not.toContain('Jane');
    expect(browserStorageDump).not.toContain('Doe');
    expect(browserStorageDump).not.toContain('901234567');

    const consoleDump = consoleMessages.join('\n');
    expect(consoleDump).not.toContain('N12345678');
    expect(consoleDump).not.toContain('1995-05-05');
    expect(consoleDump).not.toContain('jane.doe');
    expect(consoleDump).not.toContain('901234567');
  });

  test('validates required fields and atomic document completion before saving', async ({
    page,
    request,
    context,
  }) => {
    await registerAndOpenProfile(page, request, context);

    // 1. Submit empty form - save blocked with required field errors
    await page.getByRole('button', { name: 'Save profile' }).click();
    await expect(page.getByRole('alert').first()).toContainText(
      'Complete the highlighted fields before saving.',
    );
    await expect(page.getByText('This field is required.').first()).toBeVisible();
    await expect(page.getByRole('status')).not.toBeVisible();

    // 2. Fill required identity + contact, but partially fill travel document
    await fillDomesticProfile(page);
    await page.getByLabel('Passport number', { exact: true }).fill('N12345678');
    await page.getByRole('button', { name: 'Save profile' }).click();
    await expect(page.getByRole('alert').first()).toContainText(
      'Complete the highlighted fields before saving.',
    );
    await expect(
      page.getByText('Complete the travel document or clear the section.').first(),
    ).toBeVisible();

    // 3. Discard changes resets form state cleanly
    await page.getByRole('button', { name: 'Discard changes' }).click();
    await expect(page.getByLabel('Given name')).toHaveValue('');
    await expect(page.getByLabel('Passport number', { exact: true })).toHaveValue('');
    await expect(
      page.getByText('Complete the highlighted fields before saving.'),
    ).not.toBeVisible();
  });
});
