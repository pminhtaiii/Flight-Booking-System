import assert from 'node:assert/strict';
import test, { after, describe } from 'node:test';

import {
  assertResponseShape,
  buildSearchQuery,
  createUniqueTestActor,
  getFutureDate,
  getMockRequests,
  normalizeCacheEnvelope,
  redactSensitive,
  requestJson as baseRequestJson,
  resetMockServer,
} from './helpers/test-utils.mjs';

const API_BASE = (process.env.SMOKE_API_URL || 'http://127.0.0.1:3001/api').replace(/\/+$/, '');
const MOCK_BASE = (process.env.SMOKE_MOCK_URL || 'http://127.0.0.1:4010').replace(/\/+$/, '');

const SUITE_TIMEOUT_MS = 60000;
const suiteStartTime = Date.now();

export const sharedContext = {
  offerId: null,
  offerPassengerId: null,
  searchOffer: null,
  testActor: null,
};

function getRemainingTimeoutMs(maxRequestMs = 10000) {
  const remaining = SUITE_TIMEOUT_MS - (Date.now() - suiteStartTime);
  return Math.max(0, Math.min(maxRequestMs, remaining));
}

let currentTestSignal = null;

function requestJson(url, options = {}) {
  const timeoutMs = getRemainingTimeoutMs(options.timeoutMs ?? 10000);
  return baseRequestJson(url, {
    ...options,
    timeoutMs,
    signal: options.signal || currentTestSignal,
  });
}

function sanitizeError(err) {
  if (err instanceof Error) {
    err.message = redactSensitive(err.message);
    if (err.stack) {
      err.stack = redactSensitive(err.stack);
    }
    if (err.cause instanceof Error) {
      sanitizeError(err.cause);
    }
    return err;
  }
  return new Error(redactSensitive(String(err)));
}

async function runSafeCheck(t, fn) {
  const checkName = t?.name || 'anonymous check';
  const checkStartTime = Date.now();
  let checkError = null;
  currentTestSignal = t?.signal || null;
  try {
    await fn(t);
  } catch (err) {
    checkError = sanitizeError(err);
  } finally {
    currentTestSignal = null;
    const checkElapsed = Date.now() - checkStartTime;
    const totalElapsed = Date.now() - suiteStartTime;
    t.diagnostic(
      `[sanity] ${checkName} finished in ${checkElapsed}ms (suite elapsed: ${totalElapsed}ms)`,
    );
    assert.ok(
      totalElapsed < SUITE_TIMEOUT_MS,
      `Sanity suite exceeded 60-second budget: ${totalElapsed}ms >= ${SUITE_TIMEOUT_MS}ms`,
    );
  }
  if (checkError) {
    throw checkError;
  }
}

describe('whole-stack sanity suite: flight search & cache', { timeout: SUITE_TIMEOUT_MS }, () => {
  let searchQuery = null;
  let firstResponse = null;

  after(() => {
    const totalElapsed = Date.now() - suiteStartTime;
    assert.ok(
      totalElapsed < SUITE_TIMEOUT_MS,
      `Sanity suite exceeded 60-second budget: ${totalElapsed}ms >= ${SUITE_TIMEOUT_MS}ms`,
    );
  });

  test(
    'setup: register and authenticate unique test actor',
    { timeout: SUITE_TIMEOUT_MS },
    async (t) => {
      await runSafeCheck(t, async () => {
        const actor = createUniqueTestActor();
        await requestJson(`${API_BASE}/auth/register`, {
          method: 'POST',
          body: { email: actor.email, password: actor.password },
        });

        const loginData = await requestJson(`${API_BASE}/auth/login`, {
          method: 'POST',
          body: { email: actor.email, password: actor.password },
        });

        assert.ok(loginData?.token, 'login must return an authentication token');
        const userId = loginData?.user?.id || loginData?.userId;
        assert.ok(userId, 'login must return user id');

        actor.token = loginData.token;
        actor.userId = userId;
        sharedContext.testActor = actor;
      });
    },
  );

  test(
    'T029: authenticated flight search contract assertion',
    { timeout: SUITE_TIMEOUT_MS },
    async (t) => {
      await runSafeCheck(t, async () => {
        assert.ok(
          sharedContext.testActor?.token,
          'Test actor must be authenticated before flight search',
        );

        await resetMockServer(MOCK_BASE);

        const runOffsetDays =
          14 + ((Math.floor(Date.now() / 1000) + Math.floor(Math.random() * 500)) % 2500) + 1;
        searchQuery = buildSearchQuery({
          origin: 'SGN',
          destination: 'HAN',
          departureDate: getFutureDate(runOffsetDays),
          adults: 1,
          cabinClass: 'economy',
        });

        const searchResponse = await requestJson(`${API_BASE}/flights/search`, {
          method: 'POST',
          token: sharedContext.testActor.token,
          body: searchQuery,
        });

        assert.ok(searchResponse, 'Search response must not be null or undefined');
        assert.ok(Array.isArray(searchResponse.results), 'results must be an array');
        assert.ok(
          searchResponse.results.length >= 1,
          `results must contain at least 1 flight offer (observed: ${searchResponse.results.length})`,
        );

        const firstOffer = searchResponse.results[0];
        const requiredOfferFields = [
          'id',
          'airline',
          'flightNumber',
          'departureAirport',
          'arrivalAirport',
          'departureTime',
          'arrivalTime',
          'duration',
          'price',
          'currency',
          'segments',
        ];
        assertResponseShape(firstOffer, requiredOfferFields);

        assert.ok(searchResponse.meta, 'meta object must be present in search response');
        assert.equal(
          typeof searchResponse.meta.searchHash,
          'string',
          'meta.searchHash must be a string',
        );
        assert.ok(
          searchResponse.meta.searchHash.trim().length > 0,
          'meta.searchHash must be a non-empty string',
        );
        assert.equal(
          searchResponse.meta.cached,
          false,
          'meta.cached must be false on initial search',
        );

        const count = searchResponse.meta.totalResults ?? searchResponse.meta.count;
        assert.equal(typeof count, 'number', 'meta.totalResults or meta.count must be a number');
        assert.ok(count >= 1, `meta result count must be >= 1 (observed: ${count})`);

        firstResponse = searchResponse;
      });
    },
  );

  test(
    'T030: redis cache suppression and search hash parity',
    { timeout: SUITE_TIMEOUT_MS },
    async (t) => {
      await runSafeCheck(t, async () => {
        assert.ok(firstResponse, 'firstResponse from T029 must exist before cache check');
        assert.ok(searchQuery, 'searchQuery from T029 must exist before cache check');
        assert.ok(
          sharedContext.testActor?.token,
          'Test actor must be authenticated before cached search',
        );

        const initialMockRequests = await getMockRequests(MOCK_BASE);
        const initialOfferRequestCount =
          initialMockRequests?.counts?.['POST /air/offer_requests'] ?? 0;
        assert.equal(
          initialOfferRequestCount,
          1,
          `Mock server should have recorded exactly 1 POST /air/offer_requests call, observed: ${initialOfferRequestCount}`,
        );

        const cachedResponse = await requestJson(`${API_BASE}/flights/search`, {
          method: 'POST',
          token: sharedContext.testActor.token,
          body: searchQuery,
        });

        assert.ok(cachedResponse, 'Cached response must not be null or undefined');
        assert.equal(
          cachedResponse.meta?.cached,
          true,
          'cachedResponse.meta.cached must be true on repeated search',
        );

        const firstNormalized = normalizeCacheEnvelope(firstResponse);
        const cachedNormalized = normalizeCacheEnvelope(cachedResponse);

        assert.deepEqual(
          cachedNormalized.comparable,
          firstNormalized.comparable,
          'Cached normalized comparable payload must match first response',
        );
        assert.equal(
          cachedResponse.results.length,
          firstResponse.results.length,
          'Cached response results length must equal first response results length',
        );
        assert.equal(
          cachedResponse.results[0].id,
          firstResponse.results[0].id,
          'Cached response first offer ID must equal first response first offer ID',
        );

        const subsequentMockRequests = await getMockRequests(MOCK_BASE);
        const subsequentOfferRequestCount =
          subsequentMockRequests?.counts?.['POST /air/offer_requests'] ?? 0;
        assert.equal(
          subsequentOfferRequestCount,
          1,
          `Mock server POST /air/offer_requests count must remain 1 (proving 0 additional supplier calls), observed: ${subsequentOfferRequestCount}`,
        );
      });
    },
  );

  test(
    'T031: capture authoritative offer passenger identifier',
    { timeout: SUITE_TIMEOUT_MS },
    async (t) => {
      await runSafeCheck(t, async () => {
        assert.ok(
          firstResponse?.results?.[0]?.id,
          'firstResponse.results[0].id from T029 must exist before offer detail check',
        );
        assert.ok(
          sharedContext.testActor?.token,
          'Test actor must be authenticated before querying offer detail',
        );

        const firstOfferId = firstResponse.results[0].id;
        const pollDeadline = Date.now() + 5000;
        let detail = null;
        let lastError = null;

        while (Date.now() < pollDeadline) {
          try {
            detail = await requestJson(`${API_BASE}/flights/${firstOfferId}`, {
              method: 'GET',
              token: sharedContext.testActor.token,
              timeoutMs: Math.min(2000, getRemainingTimeoutMs(2000)),
            });
            if (detail) {
              break;
            }
          } catch (err) {
            if (err?.status === 404) {
              lastError = err;
              await new Promise((resolve) => setTimeout(resolve, 100));
              continue;
            }
            throw err;
          }
        }

        if (!detail) {
          throw (
            lastError ||
            new Error(`Offer ${firstOfferId} detail not found within 5s polling window`)
          );
        }

        assert.ok(
          Array.isArray(detail.passengers),
          'detail.passengers must be an array in flight detail response',
        );
        assert.ok(
          detail.passengers.length >= 1,
          `detail.passengers must contain at least 1 passenger (observed: ${detail.passengers.length})`,
        );

        const firstPassenger = detail.passengers[0];
        assert.equal(typeof firstPassenger?.id, 'string', 'passengers[0].id must be a string');
        assert.ok(
          firstPassenger.id.trim().length > 0,
          'passengers[0].id must be a non-empty string',
        );

        const supplierOfferId = firstResponse.results[0].duffelOfferId || 'off_mock_123';
        const mockRequests = await getMockRequests(MOCK_BASE);
        const detailCallCount =
          mockRequests?.counts?.[`GET /air/offers/${supplierOfferId}`] ??
          mockRequests?.requests?.filter(
            (r) => r.method === 'GET' && r.pathname === `/air/offers/${supplierOfferId}`,
          ).length ??
          0;
        assert.ok(
          detailCallCount >= 1,
          `Mock server should have recorded at least 1 GET /air/offers/${supplierOfferId} call, observed: ${detailCallCount}`,
        );

        sharedContext.offerId = firstOfferId;
        sharedContext.offerPassengerId = firstPassenger.id;
        sharedContext.searchOffer = firstResponse.results[0];
      });
    },
  );
});
