import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { HANDOFF_CREDENTIAL_PATTERN } from '@shared/types';

const WEB_ORIGIN = process.env.T093_REAL_FLOW === 'true'
  ? 'http://localhost:3000'
  : 'http://127.0.0.1:3000';
const API_ORIGIN = 'http://127.0.0.1:3001';
const AGENT_ORIGIN = 'http://127.0.0.1:3002';
const timeoutFromEnv = (name: string, fallback: number): number => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
const T093_TEST_TIMEOUT_MS = timeoutFromEnv('T093_TEST_TIMEOUT_MS', 180000);
const T093_STREAM_TIMEOUT_MS = timeoutFromEnv('T093_STREAM_TIMEOUT_MS', 120000);
const T093_BROWSER_TIMEOUT_MS = timeoutFromEnv('T093_BROWSER_TIMEOUT_MS', 30000);
const FORBIDDEN_EVENT_KEYS = new Set([
  'selectionAttestation',
  'selectionAttestationHash',
  'flightOfferId',
  'duffelOfferId',
  'offerId',
  'duffelOfferIdHash',
]);

type JsonObject = Record<string, unknown>;

// JSON/DOM assertions in this opaque-box test occur only after explicit runtime shape checks;
// the casts preserve unknown at external boundaries without weakening production types.

type SseEvent = {
  event: string;
  data: unknown;
};

type BrowserJsonResponse = {
  status: number;
  body: unknown;
};

function utcDateAfterDays(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/test_db',
    },
  },
});

function parseSse(body: string): SseEvent[] {
  return body
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const event = block.match(/^event:\s*(.+)$/m)?.[1]?.trim();
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim())
        .join('\n');

      if (!event || !data) return null;

      try {
        return { event, data: JSON.parse(data) };
      } catch {
        return { event, data };
      }
    })
    .filter((value): value is SseEvent => value !== null);
}

function collectForbiddenKeys(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectForbiddenKeys(item, `${path}[${index}]`));
  }

  if (typeof value !== 'object' || value === null) return [];

  return Object.entries(value).flatMap(([key, child]) => [
    ...(FORBIDDEN_EVENT_KEYS.has(key) ? [`${path}.${key}`] : []),
    ...collectForbiddenKeys(child, `${path}.${key}`),
  ]);
}

async function registerAndLogin(
  page: Page,
  request: APIRequestContext,
): Promise<{ email: string; accessToken: string }> {
  await request
    .post(`${API_ORIGIN}/api/auth/test/reset-lockout`, {
      data: { clearAll: true },
    })
    .catch(() => undefined);

  const email = `t093-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = 'Password123!';

  const registrationResponse = await request.post(`${API_ORIGIN}/api/auth/register`, {
    data: { email, password },
  });
  expect(registrationResponse.ok()).toBe(true);

  const csrfResponse = await page.request.get(`${WEB_ORIGIN}/api/auth/csrf`, {
    timeout: T093_BROWSER_TIMEOUT_MS,
  });
  expect(csrfResponse.ok()).toBe(true);
  const csrf = (await csrfResponse.json()) as { csrfToken?: unknown };
  expect(typeof csrf.csrfToken).toBe('string');

  const callbackResponse = await page.request.post(`${WEB_ORIGIN}/api/auth/callback/credentials`, {
    form: {
      csrfToken: csrf.csrfToken as string,
      email,
      password,
      callbackUrl: `${WEB_ORIGIN}/`,
      json: 'true',
    },
    timeout: T093_BROWSER_TIMEOUT_MS,
  });
  expect(callbackResponse.ok()).toBe(true);
  await page.goto(`${WEB_ORIGIN}/`);
  await expect(page).toHaveURL(`${WEB_ORIGIN}/`, { timeout: T093_BROWSER_TIMEOUT_MS });

  const sessionResponse = await page.request.get(`${WEB_ORIGIN}/api/auth/session`);
  expect(sessionResponse.ok()).toBe(true);
  const session = (await sessionResponse.json()) as { accessToken?: unknown };
  expect(typeof session.accessToken).toBe('string');

  return { email, accessToken: session.accessToken as string };
}

async function postJsonFromBrowser(
  page: Page,
  accessToken: string,
  pathname: string,
  body: JsonObject,
): Promise<BrowserJsonResponse> {
  return page.evaluate(
    async ({ accessToken: token, apiOrigin, pathname: path, body: requestBody }) => {
      const response = await fetch(`${apiOrigin}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }

      return { status: response.status, body: parsed };
    },
    { accessToken, apiOrigin: API_ORIGIN, pathname, body },
  );
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

test.describe('T093 real direct-stream checkout flow', () => {
  test('completes signed search through one token-only consumed intent', async ({
    page,
    request,
  }) => {
    test.setTimeout(T093_TEST_TIMEOUT_MS);

    const observedRequestUrls: string[] = [];
    const browserPostBodies: Array<{ url: string; body: string | null }> = [];
    const browserConsole: string[] = [];
    const streamResponses: Array<Awaited<ReturnType<Page['waitForResponse']>>> = [];

    page.on('request', (requestEvent) => {
      observedRequestUrls.push(requestEvent.url());
      if (requestEvent.method() === 'POST') {
        browserPostBodies.push({ url: requestEvent.url(), body: requestEvent.postData() });
      }
    });
    page.on('console', (message) => browserConsole.push(message.text()));
    page.on('response', (response) => {
      if (
        response.request().method() === 'POST' &&
        response.url() === `${AGENT_ORIGIN}/chat/stream`
      ) {
        streamResponses.push(response);
      }
    });

    const { email, accessToken } = await registerAndLogin(page, request);

    await page.addInitScript((agentOrigin: string) => {
      const streamBodies: string[] = [];
      const originalFetch = window.fetch.bind(window);
      Object.defineProperty(window, '__t093StreamBodies', {
        configurable: true,
        value: streamBodies,
      });
      window.fetch = async (input, init) => {
        const response = await originalFetch(input, init);
        const requestUrl =
          typeof input === 'string' ? input : input instanceof Request ? input.url : '';
        if (requestUrl === `${agentOrigin}/chat/stream`) {
          void response
            .clone()
            .text()
            .then((body) => streamBodies.push(body));
        }
        return response;
      };
    }, AGENT_ORIGIN);

    const clientSessionResponse = page.waitForResponse(
      (response) =>
        response.url() === `${WEB_ORIGIN}/api/auth/session` &&
        response.request().method() === 'GET',
      { timeout: T093_BROWSER_TIMEOUT_MS },
    );
    await page.goto(`${WEB_ORIGIN}/search`);
    expect((await clientSessionResponse).ok()).toBe(true);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
    const chatInput = page.locator('input[placeholder="Type a message..."]');

    const departureDate = utcDateAfterDays(90);
    const searchMessage = `Find one domestic flight from SGN to HAN on ${departureDate} for one adult.`;
    await chatInput.fill(searchMessage);
    await chatInput.press('Enter');
    await expect.poll(() => streamResponses.length, { timeout: T093_STREAM_TIMEOUT_MS }).toBe(1);
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as Window & { __t093StreamBodies?: string[] }).__t093StreamBodies?.length ??
              0,
          ),
        { timeout: T093_STREAM_TIMEOUT_MS },
      )
      .toBe(1);

    const firstStream = streamResponses[0];
    expect(firstStream.url()).toBe(`${AGENT_ORIGIN}/chat/stream`);
    const firstRequestBody = firstStream.request().postDataJSON() as JsonObject;
    const firstStreamBody = await page.evaluate(
      () => (window as Window & { __t093StreamBodies?: string[] }).__t093StreamBodies?.[0] ?? '',
    );
    const firstEvents = parseSse(firstStreamBody);
    const firstResults = firstEvents.filter((event) => event.event === 'flight_results');
    const firstDone = firstEvents.filter((event) => event.event === 'done');

    expect(firstRequestBody).toMatchObject({
      message: searchMessage,
    });
    expect(firstRequestBody.sessionId).toBeUndefined();
    expect(firstStream.status()).toBe(200);
    expect(firstResults).toHaveLength(1);
    expect((firstResults[0].data as JsonObject).results).toEqual(expect.any(Array));
    expect(firstDone).toHaveLength(1);
    const sessionId = (firstDone[0].data as JsonObject).sessionId;
    expect(typeof sessionId).toBe('string');
    expect((sessionId as string).length).toBeGreaterThan(0);
    expect(firstEvents.filter((event) => event.event === 'ACTION_HANDOFF')).toHaveLength(0);

    await chatInput.fill('I explicitly select flight 1 and want to continue to checkout.');
    await chatInput.press('Enter');
    await expect.poll(() => streamResponses.length, { timeout: T093_STREAM_TIMEOUT_MS }).toBe(2);
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as Window & { __t093StreamBodies?: string[] }).__t093StreamBodies?.length ??
              0,
          ),
        { timeout: T093_STREAM_TIMEOUT_MS },
      )
      .toBe(2);

    const secondStream = streamResponses[1];
    const secondRequestBody = secondStream.request().postDataJSON() as JsonObject;
    const secondStreamBody = await page.evaluate(
      () => (window as Window & { __t093StreamBodies?: string[] }).__t093StreamBodies?.[1] ?? '',
    );
    const secondEvents = parseSse(secondStreamBody);
    expect(secondStream.status()).toBe(200);
    const secondDone = secondEvents.filter((event) => event.event === 'done');
    const handoffEvents = secondEvents.filter((event) => event.event === 'ACTION_HANDOFF');

    expect(secondRequestBody).toMatchObject({
      message: 'I explicitly select flight 1 and want to continue to checkout.',
      sessionId,
    });
    expect(secondDone).toHaveLength(1);
    expect((secondDone[0].data as JsonObject).sessionId).toBe(sessionId);
    expect(handoffEvents).toHaveLength(1);

    const handoff = handoffEvents[0].data as JsonObject;
    expect(Object.keys(handoff).sort()).toEqual([
      'action',
      'display',
      'expiresAt',
      'handoffToken',
      'version',
    ]);
    expect(handoff.version).toBe(1);
    expect(handoff.action).toBe('begin_checkout');
    expect(typeof handoff.handoffToken).toBe('string');
    expect(handoff.handoffToken as string).toMatch(/^chk_handoff_v1_[A-Za-z0-9_-]{43}$/);
    const handoffToken = handoff.handoffToken as string;
    expect(new Date(handoff.expiresAt as string).getTime()).toBeGreaterThan(Date.now());
    expect(Object.keys(handoff.display as JsonObject).sort()).toEqual([
      'airline',
      'arrivalAt',
      'currency',
      'departureAt',
      'destination',
      'origin',
      'price',
    ]);
    expect(handoff.display).toEqual(
      expect.objectContaining({
        airline: expect.any(String),
        origin: expect.any(String),
        destination: expect.any(String),
        departureAt: expect.any(String),
        arrivalAt: expect.any(String),
        price: expect.any(String),
        currency: expect.any(String),
      }),
    );

    const allEvents = [...firstEvents, ...secondEvents];
    expect(allEvents.flatMap((event) => collectForbiddenKeys(event.data))).toEqual([]);
    expect(
      allEvents
        .filter((event) => event.event !== 'ACTION_HANDOFF')
        .map((event) => JSON.stringify(event.data))
        .join('\n'),
    ).not.toContain(handoffToken);

    await expect(page.getByRole('button', { name: 'Continue to Checkout' })).toBeVisible();
    const renderedChatDom = await page.locator('html').evaluate((element) => element.outerHTML);
    expect(renderedChatDom).not.toContain(handoffToken);

    const bootstrapRequest = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        request.url() === `${WEB_ORIGIN}/checkout/handoff`,
      { timeout: T093_BROWSER_TIMEOUT_MS },
    );
    await page.getByRole('button', { name: 'Continue to Checkout' }).click({ noWaitAfter: true });
    const bootstrap = await bootstrapRequest;

    expect(bootstrap.postData()).toBe(`handoffToken=${encodeURIComponent(handoffToken)}`);
    await expect(page).toHaveURL(/\/checkout\/passengers(?:\?.*)?$/, {
      timeout: T093_BROWSER_TIMEOUT_MS,
    });

    const passenger = {
      offerPassengerId: 'pas_001',
      passengerType: 'ADULT',
      type: 'ADULT',
      source: {
        type: 'inline',
        givenName: 'T093',
        familyName: 'Browser',
        dateOfBirth: '1990-01-01',
        gender: 'male',
        nationality: 'US',
        title: 'Mr',
        email,
        phoneCountryCode: '+1',
        phoneNumber: '5551234567',
      },
    };

    const readinessBody = {
      handoffToken,
      passengers: [
        {
          offerPassengerId: passenger.offerPassengerId,
          passengerType: passenger.passengerType,
          source: passenger.source,
        },
      ],
    };
    const readiness = await postJsonFromBrowser(
      page,
      accessToken,
      '/api/bookings/intents/readiness',
      readinessBody,
    );
    expect(readiness.status).toBe(200);
    expect(readiness.body).toMatchObject({ ready: true });

    const intentBody = {
      handoffToken,
      readinessScope: (readiness.body as JsonObject).scope,
      passengers: [
        {
          offerPassengerId: passenger.offerPassengerId,
          type: passenger.type,
          source: passenger.source,
        },
      ],
    };
    const intentAttempts = await page.evaluate(
      async ({ apiOrigin, accessToken: token, requestBody }) => {
        const attempts = await Promise.all(
          Array.from({ length: 16 }, async () => {
            const response = await fetch(`${apiOrigin}/api/bookings/intents`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(requestBody),
            });
            return {
              status: response.status,
              body: await response.json().catch(() => null),
            };
          }),
        );

        return attempts;
      },
      { apiOrigin: API_ORIGIN, accessToken, requestBody: intentBody },
    );

    const winners = intentAttempts.filter((attempt) => attempt.status === 201);
    const losers = intentAttempts.filter((attempt) => attempt.status === 409);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(intentAttempts.length - 1);
    const winningIntentId = (winners[0].body as JsonObject).intentId;
    expect(typeof winningIntentId).toBe('string');

    const stableLosers = await page.evaluate(
      async ({ apiOrigin, accessToken: token, requestBody }) => {
        const attempts = await Promise.all(
          Array.from({ length: 3 }, async () => {
            const response = await fetch(`${apiOrigin}/api/bookings/intents`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(requestBody),
            });
            return { status: response.status, body: await response.json().catch(() => null) };
          }),
        );
        return attempts;
      },
      { apiOrigin: API_ORIGIN, accessToken, requestBody: intentBody },
    );
    expect(stableLosers.every((attempt) => attempt.status === 409)).toBe(true);

    const databaseUser = await prisma.user.findUnique({ where: { email } });
    expect(databaseUser).toBeDefined();
    const sessions = await prisma.chatSession.findMany({ where: { userId: databaseUser!.id } });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(sessionId);

    const messages = await prisma.chatMessage.findMany({ where: { sessionId } });
    expect(messages.length).toBeGreaterThanOrEqual(4);
    expect(
      messages.every(
        (message) => message.contentCiphertext && message.contentNonce && message.contentAuthTag,
      ),
    ).toBe(true);

    const intents = await prisma.bookingIntent.findMany({ where: { userId: databaseUser!.id } });
    expect(intents).toHaveLength(1);
    expect(intents[0].id).toBe(winningIntentId);

    const handoffs = await prisma.chatHandoff.findMany({ where: { userId: databaseUser!.id } });
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].consumedAt).not.toBeNull();
    expect(handoffs[0].consumedByBookingIntentId).toBe(winningIntentId);
    expect(
      await prisma.payment.count({ where: { bookingIntent: { userId: databaseUser!.id } } }),
    ).toBe(0);

    const evidenceResponse = await request.get(`${API_ORIGIN}/test/t093/evidence`);
    expect(evidenceResponse.ok()).toBe(true);
    const evidence = (await evidenceResponse.json()) as JsonObject;
    expect(evidence).toMatchObject({
      supplierCalls: 2,
      paymentCalls: 0,
      bookingIntentCount: 1,
      consumedHandoffCount: 1,
      plaintextFreeEncryptedCount: expect.any(Number),
    });
    expect(evidence.encryptedChatMessageCount).toEqual(expect.any(Number));
    expect(evidence.encryptedChatMessageCount as number).toBeGreaterThanOrEqual(4);
    expect(evidence.plaintextFreeEncryptedCount as number).toBeGreaterThanOrEqual(4);

    const privacySnapshot = await page.evaluate(() => ({
      href: window.location.href,
      dom: document.documentElement.outerHTML,
      localStorage: JSON.stringify(window.localStorage),
      sessionStorage: JSON.stringify(window.sessionStorage),
      cookies: document.cookie,
    }));
    expect(privacySnapshot.href).toMatch(new RegExp(`${WEB_ORIGIN}/checkout/passengers(?:\\?.*)?$`));
    expect(JSON.stringify(privacySnapshot)).not.toContain(handoffToken);
    expect(observedRequestUrls.every((url) => !url.includes(handoffToken))).toBe(true);
    expect(
      observedRequestUrls.some((url) =>
        /(?:selectionAttestation|flightOfferId|duffelOfferId)=/i.test(url),
      ),
    ).toBe(false);
    expect(browserConsole.join('\n')).not.toContain(handoffToken);
    expect(
      browserPostBodies
        .filter(({ url }) => url.includes('/api/bookings/intents'))
        .every(({ url, body }) => {
          if (!body) return false;
          const parsed = JSON.parse(body) as JsonObject;
          return (
            !url.includes('offerId') && 'handoffToken' in parsed && !('flightOfferId' in parsed)
          );
        }),
    ).toBe(true);
  });
});
