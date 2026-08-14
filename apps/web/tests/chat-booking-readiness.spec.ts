import { expect, test } from '@playwright/test';

const MOCK_SINGLE_PAYLOAD = {
  action: 'COMPLETE_PROFILE',
  scope: 'DOMESTIC',
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
      passengerType: 'ADULT',
      passengerOrdinal: 2,
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

const MOCK_MALICIOUS_PAYLOAD = {
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

test.describe('Booking Readiness Chat Handoff', () => {
  test.beforeEach(async ({ context, page }) => {
    // Fix auth cookie domain to match playwright host
    await context.addCookies([
      {
        name: 'next-auth.session-token',
        value: 'mock-token',
        domain: '127.0.0.1', // Playwright runs on 127.0.0.1 by default in next.js playwright.config.ts
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      },
      {
        name: 'next-auth.session-token',
        value: 'mock-token',
        domain: 'localhost',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);

    // Intercept direct chat stream
    await page.route(/.*:3002\/chat\/stream/, async (route) => {
      const request = route.request();
      if (request.method() === 'OPTIONS') {
        return route.fulfill({
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': 'http://127.0.0.1:3000',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Trace-Id, X-Correlation-Id',
          },
        });
      }

      const body = JSON.parse(request.postData() || '{}');
      let payload;
      
      if (body.message === 'action-required-single') {
        payload = MOCK_SINGLE_PAYLOAD;
      } else if (body.message === 'action-required-multi') {
        payload = MOCK_MULTI_PAYLOAD;
      } else if (body.message === 'action-required-malicious') {
        payload = MOCK_MALICIOUS_PAYLOAD;
      } else {
        // Fallback or normal stream
        return route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          headers: { 'Access-Control-Allow-Origin': 'http://127.0.0.1:3000' },
          body: 'event: message\ndata: "Hello"\n\n'
        });
      }

      const streamData = `event: ACTION_REQUIRED\ndata: ${JSON.stringify(payload)}\n\n`;
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: { 'Access-Control-Allow-Origin': 'http://127.0.0.1:3000' },
        body: streamData
      });
    });
  });

  test('single-profile action card renders safely and routes to profile correction', async ({ page }) => {
    // Navigate to a realistic path where widget is mounted
    await page.goto('/?sessionId=test_sess_1');
    const chatInput = page.getByPlaceholder('Type a message...');
    await chatInput.fill('action-required-single');
    await chatInput.press('Enter');

    // Action card should be visible
    const card = page.getByTestId('booking-action-card');
    await expect(card).toBeVisible();

    // Verify metadata renders safely (no PII)
    await expect(card).toContainText('Missing travel document');
    await expect(card).toContainText('Passenger 1 (Adult)');

    // Ensure no PII is visible (e.g. Jane Doe or passport values)
    await expect(card).not.toContainText('Jane Doe');
    await expect(card).not.toContainText('P12345');

    // Click complete profile button
    const completeButton = card.getByRole('button', { name: /Complete profile/i });
    await expect(completeButton).toBeVisible();
    await completeButton.click();

    // Verify it navigated to the profile page with safe return target
    await expect(page).toHaveURL(/\/profile\?returnTo=%2F%3FsessionId%3Dtest_sess_1%26autoResume%3Dtrue/);
  });

  test('inline or multi-passenger action card routes to checkout', async ({ page }) => {
    await page.goto('/?offerId=off_test_123');
    const chatInput = page.getByPlaceholder('Type a message...');
    await chatInput.fill('action-required-multi');
    await chatInput.press('Enter');

    const card = page.getByTestId('booking-action-card');
    await expect(card).toBeVisible();

    // Multi-passenger should direct to checkout
    const completeButton = card.getByRole('button', { name: /Complete passenger details/i });
    await expect(completeButton).toBeVisible();
    await completeButton.click();

    await expect(page).toHaveURL(/\/checkout\/passengers\?offerId=off_test_123/);
  });

  test('browser privacy - no PII is logged or stored in storage', async ({ page }) => {
    const logs: string[] = [];
    page.on('console', (msg) => logs.push(msg.text()));

    await page.goto('/');
    const chatInput = page.getByPlaceholder('Type a message...');
    await chatInput.fill('action-required-single');
    await chatInput.press('Enter');
    await expect(page.getByTestId('booking-action-card')).toBeVisible();

    const localStorageData = await page.evaluate(() => JSON.stringify(window.localStorage));
    const sessionStorageData = await page.evaluate(() => JSON.stringify(window.sessionStorage));

    expect(localStorageData).not.toContain('Jane Doe');
    expect(localStorageData).not.toContain('P12345');
    expect(sessionStorageData).not.toContain('Jane Doe');
    expect(sessionStorageData).not.toContain('P12345');

    const logOutput = logs.join(' ');
    expect(logOutput).not.toContain('Jane Doe');
    expect(logOutput).not.toContain('P12345');
  });

  test('rejects a value-bearing ACTION_REQUIRED payload without rendering it', async ({ page }) => {
    await page.goto('/');
    const chatInput = page.getByPlaceholder('Type a message...');
    await chatInput.fill('action-required-malicious');
    await chatInput.press('Enter');

    await page.waitForTimeout(500);

    await expect(page.getByTestId('booking-action-card')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('Jane Doe');
    await expect(page.locator('body')).not.toContainText('P12345');
  });

  test('profile correction and retry flow', async ({ page }) => {
    // Setup mock profile data or login route to avoid redirect loop
    await page.route('/api/profile', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        userId: '123',
        firstName: 'John',
        lastName: 'Doe',
        dateOfBirth: '1990-01-01',
        gender: 'MALE',
        travelDocuments: []
      })
    }));

    await page.goto('/profile?returnTo=/?sessionId=test_sess_1%26autoResume=true');
    
    // We are on profile page
    await expect(page.getByRole('heading', { name: /Traveler profile/i })).toBeVisible();
    
    // Test the back link
    const backLink = page.getByRole('link', { name: /Back to previous workspace/i });
    await expect(backLink).toBeVisible();
    await expect(backLink).toHaveAttribute('href', '/?sessionId=test_sess_1&autoResume=true');

    await backLink.click();
    await expect(page).toHaveURL(/\/\?sessionId=test_sess_1&autoResume=true/);
  });
});
