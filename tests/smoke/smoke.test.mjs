import assert from 'node:assert/strict';
import test, { after, describe } from 'node:test';

import {
  authBearer,
  createUniqueTestActor,
  redactSensitive,
  requestJson as baseRequestJson,
} from './helpers/test-utils.mjs';

const API_BASE = (process.env.SMOKE_API_URL || 'http://127.0.0.1:3001/api').replace(/\/+$/, '');
const WEB_BASE = (process.env.SMOKE_WEB_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const AGENT_BASE = (process.env.SMOKE_AGENT_URL || 'http://127.0.0.1:3002').replace(/\/+$/, '');

const SUITE_TIMEOUT_MS = 15000;
const suiteStartTime = Date.now();

function getRemainingTimeoutMs(maxRequestMs = 5000) {
  const remaining = SUITE_TIMEOUT_MS - (Date.now() - suiteStartTime);
  return Math.max(0, Math.min(maxRequestMs, remaining));
}

let currentTestSignal = null;

function requestJson(url, options = {}) {
  const timeoutMs = getRemainingTimeoutMs(options.timeoutMs ?? 5000);
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
  }
  return err;
}

async function runSafeCheck(t, checkName, fn) {
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
      `[smoke] ${checkName} finished in ${checkElapsed}ms (suite elapsed: ${totalElapsed}ms)`,
    );
    if (checkError) {
      throw checkError;
    }
    assert.ok(
      totalElapsed < SUITE_TIMEOUT_MS,
      `Smoke suite exceeded 15-second budget: ${totalElapsed}ms >= ${SUITE_TIMEOUT_MS}ms`,
    );
  }
}

describe('whole-stack smoke suite', { timeout: SUITE_TIMEOUT_MS }, () => {
  after(() => {
    const totalElapsed = Date.now() - suiteStartTime;
    assert.ok(
      totalElapsed < SUITE_TIMEOUT_MS,
      `Smoke suite exceeded 15-second budget: ${totalElapsed}ms >= ${SUITE_TIMEOUT_MS}ms`,
    );
  });

  // Check 1: API health and dependency shape
  test('API health and dependency shape', { timeout: SUITE_TIMEOUT_MS }, async (t) => {
    await runSafeCheck(t, 'API health and dependency shape', async () => {
      const data = await requestJson(`${API_BASE}/health`);
      assert.equal(data?.status, 'ok', 'API health status must be "ok"');
      assert.equal(typeof data?.dependencies, 'object', 'dependencies must be an object');
      assert.ok(data.dependencies !== null, 'dependencies must not be null');
      assert.ok('database' in data.dependencies, 'dependencies must include database');
      assert.ok('redis' in data.dependencies, 'dependencies must include redis');
    });
  });

  // Check 2: Next.js homepage HTML
  test('Next.js homepage HTML', { timeout: SUITE_TIMEOUT_MS }, async (t) => {
    await runSafeCheck(t, 'Next.js homepage HTML', async (checkContext) => {
      const controller = new AbortController();
      const timeoutMs = getRemainingTimeoutMs(5000);
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onAbort = () => controller.abort();
      if (checkContext?.signal) {
        if (checkContext.signal.aborted) {
          controller.abort();
        } else {
          checkContext.signal.addEventListener('abort', onAbort, { once: true });
        }
      }
      try {
        const res = await fetch(`${WEB_BASE}/`, {
          headers: { Accept: 'text/html' },
          signal: controller.signal,
        });
        assert.equal(res.status, 200, `Homepage returned status ${res.status}`);
        const html = await res.text();
        const hasLandingMarker =
          html.toLowerCase().includes('wayfinder') || html.toLowerCase().includes('landing-title');
        assert.ok(
          hasLandingMarker,
          'Homepage HTML must contain landing marker (wayfinder or landing-title)',
        );
      } finally {
        clearTimeout(timer);
        if (onAbort && checkContext?.signal) {
          checkContext.signal.removeEventListener('abort', onAbort);
        }
      }
    });
  });

  // Check 3: Agent health HTTP reachability
  test('Agent health HTTP reachability', { timeout: SUITE_TIMEOUT_MS }, async (t) => {
    await runSafeCheck(t, 'Agent health HTTP reachability', async (checkContext) => {
      const controller = new AbortController();
      const timeoutMs = getRemainingTimeoutMs(5000);
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onAbort = () => controller.abort();
      if (checkContext?.signal) {
        if (checkContext.signal.aborted) {
          controller.abort();
        } else {
          checkContext.signal.addEventListener('abort', onAbort, { once: true });
        }
      }
      try {
        const res = await fetch(`${AGENT_BASE}/health`, {
          signal: controller.signal,
        });
        assert.equal(res.status, 200, `Agent health returned status ${res.status}`);
        const data = await res.json();
        assert.ok(
          data?.status === 'ok' || data?.status === 'degraded',
          `Agent status must be "ok" or "degraded", observed: ${data?.status}`,
        );
      } finally {
        clearTimeout(timer);
        if (onAbort && checkContext?.signal) {
          checkContext.signal.removeEventListener('abort', onAbort);
        }
      }
    });
  });

  // Check 4: PostgreSQL readiness
  test('PostgreSQL readiness', { timeout: SUITE_TIMEOUT_MS }, async (t) => {
    await runSafeCheck(t, 'PostgreSQL readiness', async () => {
      const data = await requestJson(`${API_BASE}/health`);
      assert.equal(data?.dependencies?.database, 'up', 'PostgreSQL dependency must be "up"');
    });
  });

  // Check 5: Redis readiness
  test('Redis readiness', { timeout: SUITE_TIMEOUT_MS }, async (t) => {
    await runSafeCheck(t, 'Redis readiness', async () => {
      const data = await requestJson(`${API_BASE}/health`);
      assert.equal(data?.dependencies?.redis, 'up', 'Redis dependency must be "up"');
    });
  });

  // Check 6: Web upstream reachability
  test('Web upstream reachability', { timeout: SUITE_TIMEOUT_MS }, async (t) => {
    await runSafeCheck(t, 'Web upstream reachability', async () => {
      const data = await requestJson(`${WEB_BASE}/health/upstream`);
      assert.equal(data?.status, 'ok', 'Web upstream status must be "ok"');
      assert.equal(data?.upstream, 'up', 'Web upstream value must be "up"');
    });
  });

  // Check 7: API-to-Agent reachability
  test('API-to-Agent reachability', { timeout: SUITE_TIMEOUT_MS }, async (t) => {
    await runSafeCheck(t, 'API-to-Agent reachability', async () => {
      const data = await requestJson(`${API_BASE}/health/agent`);
      assert.equal(data?.status, 'ok', 'API-to-Agent status must be "ok"');
    });
  });

  // Check 8: Authentication round-trip
  test('Authentication round-trip', { timeout: SUITE_TIMEOUT_MS }, async (t) => {
    await runSafeCheck(t, 'Authentication round-trip', async () => {
      const actor = createUniqueTestActor();

      // Step 1: Register
      const registerData = await requestJson(`${API_BASE}/auth/register`, {
        method: 'POST',
        body: {
          email: actor.email,
          password: actor.password,
        },
      });

      assert.ok(registerData, 'Register response must not be null');
      assert.equal(
        typeof registerData.token,
        'string',
        'Register response must contain token string',
      );
      assert.ok(registerData.token.length > 0, 'Register token must not be empty');
      assert.ok(registerData.user?.id, 'Register response must contain user.id');
      assert.equal(
        registerData.user?.email,
        actor.email,
        'Register response user.email must match actor email',
      );

      actor.userId = registerData.user.id;
      actor.token = registerData.token;

      // Step 2: Login
      const loginData = await requestJson(`${API_BASE}/auth/login`, {
        method: 'POST',
        body: {
          email: actor.email,
          password: actor.password,
        },
      });

      assert.ok(loginData, 'Login response must not be null');
      assert.equal(typeof loginData.token, 'string', 'Login response must contain token string');
      assert.ok(loginData.token.length > 0, 'Login token must not be empty');
      assert.equal(
        loginData.user?.id,
        actor.userId,
        'Login response user.id must match registered user.id',
      );
      assert.equal(
        loginData.user?.email,
        actor.email,
        'Login response user.email must match actor email',
      );

      // Step 3: GET /auth/me with Bearer token
      const meData = await requestJson(`${API_BASE}/auth/me`, {
        method: 'GET',
        headers: authBearer(loginData.token),
      });

      assert.ok(meData, 'GET /auth/me response must not be null');
      assert.equal(meData.id, actor.userId, 'GET /auth/me id must match registered user.id');
      assert.equal(meData.email, actor.email, 'GET /auth/me email must match actor email');
    });
  });
});
