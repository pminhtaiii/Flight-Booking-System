import { expect, test, type Page, type Route } from '@playwright/test';

const WEB_ORIGIN = 'http://127.0.0.1:3000';

const MOCK_SINGLE_INTERNATIONAL_PAYLOAD = {
  action: 'COMPLETE_PROFILE',
  scope: 'INTERNATIONAL',
  passengers: [
    {
      passengerType: 'ADULT',
      passengerOrdinal: 1,
      sections: [
        {
          name: 'travel_document',
          fields: [
            {
              name: 'passportNumber',
              status: 'missing',
              reason: 'REQUIRED',
            },
            {
              name: 'passportExpiry',
              status: 'invalid',
              reason: 'EXPIRED',
            },
          ],
        },
      ],
    },
  ],
  target: '/profile',
};

const MOCK_SINGLE_DOMESTIC_PAYLOAD = {
  action: 'COMPLETE_PROFILE',
  scope: 'DOMESTIC',
  passengers: [
    {
      passengerType: 'ADULT',
      passengerOrdinal: 1,
      sections: [
        {
          name: 'identity',
          fields: [
            {
              name: 'givenName',
              status: 'missing',
              reason: 'REQUIRED',
            },
          ],
        },
      ],
    },
  ],
  target: '/profile',
};

const MOCK_MULTI_PAYLOAD = {
  action: 'CONTINUE_CHECKOUT',
  scope: 'DOMESTIC',
  passengers: [
    {
      passengerType: 'ADULT',
      passengerOrdinal: 1,
      sections: [
        {
          name: 'identity',
          fields: [
            {
              name: 'givenName',
              status: 'missing',
              reason: 'REQUIRED',
            },
          ],
        },
      ],
    },
    {
      passengerType: 'CHILD',
      passengerOrdinal: 2,
      sections: [
        {
          name: 'identity',
          fields: [
            {
              name: 'familyName',
              status: 'missing',
              reason: 'REQUIRED',
            },
          ],
        },
      ],
    },
  ],
  target: '/checkout/passengers',
  offerId: 'off_test_123',
};

const MOCK_MALICIOUS_ROOT_PII_PAYLOAD = {
  action: 'COMPLETE_PROFILE',
  scope: 'DOMESTIC',
  passengers: [
    {
      passengerType: 'ADULT',
      passengerOrdinal: 1,
      sections: [
        {
          name: 'identity',
          fields: [
            {
              name: 'givenName',
              status: 'missing',
              reason: 'REQUIRED',
            },
          ],
        },
      ],
    },
  ],
  target: '/profile',
  _unsafe_pii: {
    fullName: 'Jane Doe',
    documentNumber: 'P12345',
  },
};

const MOCK_MALICIOUS_NESTED_PII_PAYLOAD = {
  action: 'COMPLETE_PROFILE',
  scope: 'DOMESTIC',
  passengers: [
    {
      passengerType: 'ADULT',
      passengerOrdinal: 1,
      fullName: 'Jane Doe',
      sections: [
        {
          name: 'identity',
          fields: [
            {
              name: 'givenName',
              status: 'missing',
              reason: 'REQUIRED',
              value: 'SecretInjectedValue',
            },
          ],
        },
      ],
    },
  ],
  target: '/profile',
};

const MOCK_MALICIOUS_TARGET_MISMATCH_PAYLOAD = {
  action: 'COMPLETE_PROFILE',
  scope: 'DOMESTIC',
  passengers: [
    {
      passengerType: 'ADULT',
      passengerOrdinal: 1,
      sections: [
        {
          name: 'identity',
          fields: [
            {
              name: 'givenName',
              status: 'missing',
              reason: 'REQUIRED',
            },
          ],
        },
      ],
    },
  ],
  target: '/checkout/passengers',
};

async function loginAsNewUser(page: Page): Promise<string> {
  const unique = Date.now() + Math.floor(Math.random() * 10000);
  const email = `traveler${unique}@example.com`;
  await page.goto(`${WEB_ORIGIN}/register`);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', 'Password123!');
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL(/.*127\.0\.0\.1:3000\/$/, { timeout: 30000 });
  await page.waitForLoadState('networkidle');
  await expect
    .poll(async () => {
      const cookies = await page.context().cookies();
      return cookies.some((c) => c.name.includes('next-auth'));
    })
    .toBe(true);
  return email;
}

test.describe('Booking Readiness Chat Handoff', () => {
  test.setTimeout(90000);

  test('ACTION_REQUIRED SSE event renders BookingActionCard with missing field reasons and passenger groupings', async ({
    page,
  }) => {
    await page.route(/.*:3002\/chat\/stream/, async (route: Route) => {
      if (route.request().method() === 'OPTIONS') {
        return route.fulfill({
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': WEB_ORIGIN,
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers':
              'Authorization, Content-Type, X-Trace-Id, X-Correlation-Id',
          },
        });
      }

      const streamData = `event: ACTION_REQUIRED\ndata: ${JSON.stringify(MOCK_SINGLE_INTERNATIONAL_PAYLOAD)}\n\n`;
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: { 'Access-Control-Allow-Origin': WEB_ORIGIN },
        body: streamData,
      });
    });

    await page.goto(`${WEB_ORIGIN}/?sessionId=sess_readiness_1`);
    const chatInput = page.getByPlaceholder('Type a message...');
    await chatInput.fill('check international flight readiness');
    await chatInput.press('Enter');

    const card = page.getByTestId('booking-action-card');
    await expect(card).toBeVisible();

    // Verify title and explanation for international scope with travel doc issues
    await expect(card).toContainText('Passport Required for International Flight');
    await expect(card).toContainText(
      'International flights require verified passport details before booking can be confirmed.',
    );

    // Verify passenger grouping
    await expect(card).toContainText('Passenger 1 (Adult)');

    // Verify missing field reasons
    await expect(card).toContainText('Missing travel document passport number');
    await expect(card).toContainText('Expired travel document passport expiry');

    // Verify action button
    const actionButton = page.getByTestId('booking-action-button');
    await expect(actionButton).toBeVisible();
    await expect(actionButton).toHaveText('Complete profile');
  });

  test('"Complete profile" navigates to /profile with validated returnTo parameter', async ({
    page,
  }) => {
    await page.route(/.*:3002\/chat\/stream/, async (route: Route) => {
      if (route.request().method() === 'OPTIONS') {
        return route.fulfill({
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': WEB_ORIGIN,
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers':
              'Authorization, Content-Type, X-Trace-Id, X-Correlation-Id',
          },
        });
      }

      const streamData = `event: ACTION_REQUIRED\ndata: ${JSON.stringify(MOCK_SINGLE_DOMESTIC_PAYLOAD)}\n\n`;
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: { 'Access-Control-Allow-Origin': WEB_ORIGIN },
        body: streamData,
      });
    });

    await page.route(`${WEB_ORIGIN}/profile*`, async (route: Route) => {
      return route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<main>Profile</main>',
      });
    });

    await page.goto(`${WEB_ORIGIN}/?sessionId=sess_return_test`);
    const chatInput = page.getByPlaceholder('Type a message...');
    await chatInput.fill('check domestic readiness');
    await chatInput.press('Enter');

    const card = page.getByTestId('booking-action-card');
    await expect(card).toBeVisible();

    const completeButton = card.getByRole('button', { name: /Complete profile/i });
    await expect(completeButton).toBeVisible();
    await completeButton.click();

    // Verify URL navigated to /profile with validated returnTo containing sessionId and autoResume=true
    await expect(page).toHaveURL(
      /\/profile\?returnTo=%2F%3FsessionId%3Dsess_return_test%26autoResume%3Dtrue/,
    );
  });

  test('multi-passenger action card navigates directly to /checkout/passengers with offerId and returnTo', async ({
    page,
  }) => {
    await page.route(/.*:3002\/chat\/stream/, async (route: Route) => {
      if (route.request().method() === 'OPTIONS') {
        return route.fulfill({
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': WEB_ORIGIN,
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers':
              'Authorization, Content-Type, X-Trace-Id, X-Correlation-Id',
          },
        });
      }

      const streamData = `event: ACTION_REQUIRED\ndata: ${JSON.stringify(MOCK_MULTI_PAYLOAD)}\n\n`;
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: { 'Access-Control-Allow-Origin': WEB_ORIGIN },
        body: streamData,
      });
    });

    await page.route(`${WEB_ORIGIN}/checkout/passengers*`, async (route: Route) => {
      return route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<main>Checkout Passengers</main>',
      });
    });

    await page.goto(`${WEB_ORIGIN}/?offerId=off_test_123&sessionId=sess_multi_123`);
    const chatInput = page.getByPlaceholder('Type a message...');
    await chatInput.fill('check multi passenger readiness');
    await chatInput.press('Enter');

    const card = page.getByTestId('booking-action-card');
    await expect(card).toBeVisible();

    // Verify multiple passenger groups rendered
    await expect(card).toContainText('Passenger 1 (Adult)');
    await expect(card).toContainText('Passenger 2 (Child)');
    await expect(card).toContainText('Missing Given Name');
    await expect(card).toContainText('Missing Family Name');

    // Multi-passenger should direct to checkout
    const checkoutButton = card.getByRole('button', { name: /Complete passenger details/i });
    await expect(checkoutButton).toBeVisible();
    await checkoutButton.click();

    // Verify it navigated to checkout with offerId and safe returnTo
    await expect(page).toHaveURL(
      /\/checkout\/passengers\?offerId=off_test_123&returnTo=%2F%3FofferId%3Doff_test_123%26sessionId%3Dsess_multi_123%26autoResume%3Dtrue/,
    );
  });

  test('negative privacy assertion - zero passenger PII in chat DOM, storage, or console logs', async ({
    page,
  }) => {
    const logs: string[] = [];
    page.on('console', (msg) => logs.push(msg.text()));

    const CANARY_VALUES = [
      'Jane Doe',
      'P12345',
      'sensitive-token-secret',
      'N12345678',
      '901234567',
    ];

    await page.route(/.*:3002\/chat\/stream/, async (route: Route) => {
      if (route.request().method() === 'OPTIONS') {
        return route.fulfill({
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': WEB_ORIGIN,
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers':
              'Authorization, Content-Type, X-Trace-Id, X-Correlation-Id',
          },
        });
      }

      const streamData = `event: ACTION_REQUIRED\ndata: ${JSON.stringify(MOCK_SINGLE_DOMESTIC_PAYLOAD)}\n\n`;
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: { 'Access-Control-Allow-Origin': WEB_ORIGIN },
        body: streamData,
      });
    });

    await page.goto(`${WEB_ORIGIN}/`);
    const chatInput = page.getByPlaceholder('Type a message...');
    await chatInput.fill('check readiness');
    await chatInput.press('Enter');

    await expect(page.getByTestId('booking-action-card')).toBeVisible();

    // 1. Assert DOM contains zero PII canary values
    const domContent = await page.locator('body').innerHTML();
    for (const canary of CANARY_VALUES) {
      expect(domContent).not.toContain(canary);
    }

    // 2. Assert localStorage and sessionStorage contain zero PII canary values
    const storageData = await page.evaluate(() =>
      JSON.stringify({
        localStorage: { ...window.localStorage },
        sessionStorage: { ...window.sessionStorage },
      }),
    );
    for (const canary of CANARY_VALUES) {
      expect(storageData).not.toContain(canary);
    }

    // 3. Assert console logs contain zero PII canary values
    const joinedLogs = logs.join('\n');
    for (const canary of CANARY_VALUES) {
      expect(joinedLogs).not.toContain(canary);
    }
  });

  test('fail-closed security assertion - malicious value-bearing payloads are rejected with 0 cards rendered', async ({
    page,
  }) => {
    await page.route(/.*:3002\/chat\/stream/, async (route: Route) => {
      if (route.request().method() === 'OPTIONS') {
        return route.fulfill({
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': WEB_ORIGIN,
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers':
              'Authorization, Content-Type, X-Trace-Id, X-Correlation-Id',
          },
        });
      }

      const reqBody = JSON.parse(route.request().postData() || '{}');
      let payload: unknown = null;

      if (reqBody.message === 'trigger-root-pii') {
        payload = MOCK_MALICIOUS_ROOT_PII_PAYLOAD;
      } else if (reqBody.message === 'trigger-nested-pii') {
        payload = MOCK_MALICIOUS_NESTED_PII_PAYLOAD;
      } else if (reqBody.message === 'trigger-target-mismatch') {
        payload = MOCK_MALICIOUS_TARGET_MISMATCH_PAYLOAD;
      }

      const streamData = `event: ACTION_REQUIRED\ndata: ${JSON.stringify(payload)}\n\n`;
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: { 'Access-Control-Allow-Origin': WEB_ORIGIN },
        body: streamData,
      });
    });

    await page.goto(`${WEB_ORIGIN}/`);

    const triggers = ['trigger-root-pii', 'trigger-nested-pii', 'trigger-target-mismatch'];
    for (const trigger of triggers) {
      const chatInput = page.getByPlaceholder('Type a message...');
      await chatInput.fill(trigger);
      await chatInput.press('Enter');

      // Allow stream parse & React render cycle to complete
      await page.waitForTimeout(200);

      // Must fail closed: zero cards rendered
      await expect(page.getByTestId('booking-action-card')).toHaveCount(0);

      // Verify no injected PII leaked into DOM
      const domContent = await page.locator('body').innerHTML();
      expect(domContent).not.toContain('Jane Doe');
      expect(domContent).not.toContain('P12345');
      expect(domContent).not.toContain('SecretInjectedValue');
    }
  });

  test('profile correction and safe return-and-retry flow', async ({ page, request, context }) => {
    // Clear lockout before registering new user
    await request
      .post('http://127.0.0.1:3001/api/auth/test/reset-lockout', {
        data: { clearAll: true },
      })
      .catch(() => {});
    await context.clearCookies();

    // Register user
    const email = `flow-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    await page.goto(`${WEB_ORIGIN}/register`);
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', 'Password123!');
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/.*127\.0\.0\.1:3000\/$/, { timeout: 30000 });
    await page.waitForLoadState('networkidle');

    const streamRequests: Array<{ message: string; sessionId?: string }> = [];

    await page.route(/.*:3002\/chat\/stream/, async (route: Route) => {
      if (route.request().method() === 'OPTIONS') {
        return route.fulfill({
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': WEB_ORIGIN,
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers':
              'Authorization, Content-Type, X-Trace-Id, X-Correlation-Id',
          },
        });
      }

      const reqBody = JSON.parse(route.request().postData() || '{}');
      streamRequests.push(reqBody);

      if (reqBody.message === 'resume') {
        // Stream re-check on autoResume
        return route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          headers: { 'Access-Control-Allow-Origin': WEB_ORIGIN },
          body: 'event: message\ndata: "Traveler profile verified. Ready to proceed with booking."\n\n',
        });
      }

      // Initial chat request triggers ACTION_REQUIRED
      const streamData = `event: ACTION_REQUIRED\ndata: ${JSON.stringify(MOCK_SINGLE_DOMESTIC_PAYLOAD)}\n\n`;
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: { 'Access-Control-Allow-Origin': WEB_ORIGIN },
        body: streamData,
      });
    });

    // Mock /api/profile PATCH to simulate successful update
    await page.route('**/api/profile', async (route: Route) => {
      if (route.request().method() === 'PATCH') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            profileId: 'prof_test_123',
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
            preferences: null,
            revision: 2,
            updatedAt: new Date().toISOString(),
          }),
        });
      }
      return route.continue();
    });

    // 1. User starts on chat page with active session
    const activeSessionId = 'sess_flow_test_101';
    await page.goto(`${WEB_ORIGIN}/?sessionId=${activeSessionId}`);

    const chatInput = page.getByPlaceholder('Type a message...');
    await chatInput.fill('Book flight to SGN');
    await chatInput.press('Enter');

    // 2. Action card appears
    const card = page.getByTestId('booking-action-card');
    await expect(card).toBeVisible();

    // 3. User clicks "Complete profile" button
    const completeButton = card.getByRole('button', { name: /Complete profile/i });
    await completeButton.click();

    // 4. Browser navigates to /profile with validated returnTo
    await expect(page).toHaveURL(
      new RegExp(`/profile\\?returnTo=%2F%3FsessionId%3D${activeSessionId}%26autoResume%3Dtrue`),
      { timeout: 15000 },
    );
    await expect(
      page.getByRole('heading', { name: 'Keep every detail ready for takeoff.' }),
    ).toBeVisible({ timeout: 15000 });

    // 5. Verify back link exists with safe return target
    const backLink = page.getByRole('link', { name: /Back to previous workspace/i });
    await expect(backLink).toBeVisible();
    await expect(backLink).toHaveAttribute(
      'href',
      `/?sessionId=${activeSessionId}&autoResume=true`,
    );

    // 6. User fills required profile fields on /profile
    await page.getByLabel('Title').selectOption('ms');
    await page.getByLabel('Given name').fill('Jane');
    await page.getByLabel('Family name').fill('Doe');
    await page.getByLabel('Date of birth').fill('1995-05-05');
    await page.getByLabel('Gender').selectOption('female');
    await page.getByLabel('Email address').fill('jane.doe@example.com');
    await page.getByLabel('Phone country code').selectOption('+84');
    await page.getByLabel('Phone number', { exact: true }).fill('901234567');

    // 7. User clicks Save profile
    await page.getByRole('button', { name: 'Save profile' }).click();

    // 8. User returns back to chat via return link
    await page.getByRole('link', { name: /Return and continue booking/i }).click();
    await expect(page).toHaveURL(
      new RegExp(`.*\\/\\?sessionId=${activeSessionId}&autoResume=true`),
      { timeout: 15000 },
    );

    // 9. Verify stream re-check occurred automatically on chat widget mount with autoResume=true
    await expect
      .poll(() =>
        streamRequests.some((req) => req.message === 'resume' && req.sessionId === activeSessionId),
      )
      .toBe(true);
  });
});
