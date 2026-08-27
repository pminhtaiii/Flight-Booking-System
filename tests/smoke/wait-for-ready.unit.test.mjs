import assert from 'node:assert/strict';
import test from 'node:test';

import { waitForReady } from './helpers/wait-for-ready.mjs';

function createAdvancingClock() {
  let now = 0;

  return {
    now: () => now,
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
  };
}

function createDeadlineClock(limitMs) {
  let now = 0;

  return {
    now: () => now,
    sleep: async (milliseconds) => {
      now += milliseconds;
      if (now > limitMs) {
        throw new Error(`test clock advanced beyond ${limitMs}ms`);
      }
    },
  };
}

function createManualTimerClock() {
  let now = 0;
  let nextTimerId = 1;
  const timers = new Map();

  return {
    now: () => now,
    setTimeout: (callback, milliseconds) => {
      const timerId = nextTimerId;
      nextTimerId += 1;
      timers.set(timerId, { callback, dueAt: now + milliseconds });
      return timerId;
    },
    clearTimeout: (timerId) => timers.delete(timerId),
    advance: (milliseconds) => {
      now += milliseconds;
      for (const [timerId, timer] of timers) {
        if (timer.dueAt <= now) {
          timers.delete(timerId);
          timer.callback();
        }
      }
    },
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test('starts every readiness probe before any pending probe resolves', async () => {
  // Catches a production mutation that awaits each probe before starting the next one.
  const pending = new Map();
  const calls = [];
  const fetchImpl = (url) => {
    calls.push(url);
    return new Promise((resolve) => pending.set(url, resolve));
  };

  const ready = waitForReady({
    probes: [
      { name: 'api', url: 'http://api.test/health', validate: (response) => response.status === 200 },
      { name: 'web', url: 'http://web.test/health', validate: (response) => response.status === 200 },
    ],
    intervalMs: 10,
    timeoutMs: 100,
    fetchImpl,
  });

  await Promise.resolve();
  assert.deepEqual(calls, ['http://api.test/health', 'http://web.test/health']);

  pending.get('http://api.test/health')({ status: 200 });
  pending.get('http://web.test/health')({ status: 200 });

  const report = await ready;
  assert.equal(report.ok, true);
  assert.equal(typeof report.elapsedMs, 'number');
  assert.deepEqual(report.services.map(({ elapsedMs, ...service }) => service), [
    { service: 'api', attempts: 1, lastStatus: 200, lastError: null },
    { service: 'web', attempts: 1, lastStatus: 200, lastError: null },
  ]);
  assert.ok(report.services.every((service) => typeof service.elapsedMs === 'number'));
});

test('keeps polling a staggered probe until every service is ready', async () => {
  // Catches a production mutation that gives up after one non-ready response.
  const clock = createAdvancingClock();
  const attemptsByUrl = new Map();
  const fetchImpl = async (url) => {
    const attempts = (attemptsByUrl.get(url) ?? 0) + 1;
    attemptsByUrl.set(url, attempts);

    if (url.includes('api')) {
      return { status: attempts === 3 ? 200 : 503 };
    }

    return { status: attempts === 2 ? 200 : 503 };
  };

  const report = await waitForReady({
    probes: [
      { name: 'api', url: 'http://api.test/health', validate: (response) => response.status === 200 },
      { name: 'web', url: 'http://web.test/health', validate: (response) => response.status === 200 },
    ],
    intervalMs: 10,
    timeoutMs: 100,
    fetchImpl,
    clock,
  });

  assert.equal(report.ok, true);
  assert.deepEqual(report.services.map(({ service, attempts, lastStatus }) => ({ service, attempts, lastStatus })), [
    { service: 'api', attempts: 3, lastStatus: 200 },
    { service: 'web', attempts: 2, lastStatus: 200 },
  ]);
});

test('stops every unready probe at one shared deadline', async () => {
  // Catches a production mutation that lets retries continue beyond the shared deadline.
  const clock = createDeadlineClock(25);

  await assert.rejects(
    waitForReady({
      probes: [
        { name: 'api', url: 'http://api.test/health', validate: (response) => response.status === 200 },
        { name: 'web', url: 'http://web.test/health', validate: (response) => response.status === 200 },
      ],
      intervalMs: 10,
      timeoutMs: 25,
      fetchImpl: async () => ({ status: 503 }),
      clock,
    }),
    (failure) => {
      assert.equal(failure.code, 'READINESS_TIMEOUT');
      assert.equal(failure.elapsedMs, 25);
      assert.deepEqual(failure.services.map(({ service, lastStatus, elapsedMs }) => ({ service, lastStatus, elapsedMs })), [
        { service: 'api', lastStatus: 503, elapsedMs: 25 },
        { service: 'web', lastStatus: 503, elapsedMs: 25 },
      ]);
      return true;
    },
  );
});

test('reports every unready service with sanitized diagnostics', async () => {
  // Catches a production mutation that leaks a raw probe error or omits another unready service.
  const clock = createDeadlineClock(25);

  await assert.rejects(
    waitForReady({
      probes: [
        { name: 'api', url: 'http://api.test/health', validate: (response) => response.status === 200 },
        { name: 'web', url: 'http://web.test/health', validate: (response) => response.status === 200 },
      ],
      intervalMs: 10,
      timeoutMs: 25,
      fetchImpl: async (url) => {
        if (url.includes('api')) {
          throw new Error('Bearer top-secret-token password=not-for-diagnostics');
        }
        return { status: 503, body: 'response-body-must-not-appear' };
      },
      clock,
    }),
    (failure) => {
      assert.equal(failure.code, 'READINESS_TIMEOUT');
      assert.equal('stack' in failure, false);
      assert.deepEqual(failure.services.map(({ service, lastStatus, lastError, elapsedMs }) => ({
        service,
        lastStatus,
        lastError,
        elapsedMs,
      })), [
        { service: 'api', lastStatus: null, lastError: 'request_failed', elapsedMs: 25 },
        { service: 'web', lastStatus: 503, lastError: null, elapsedMs: 25 },
      ]);
      assert.ok(failure.services.every((service) => service.attempts > 0));
      assert.doesNotMatch(JSON.stringify(failure), /top-secret-token|password|response-body/i);
      return true;
    },
  );
});

test('uses the shared deadline when a probe fetch never settles', async () => {
  // Catches a production mutation that awaits a hung fetch instead of racing it with the deadline.
  const clock = createManualTimerClock();
  const readiness = waitForReady({
    probes: [
      { name: 'api', url: 'http://api.test/health', validate: (response) => response.status === 200 },
      { name: 'web', url: 'http://web.test/health', validate: (response) => response.status === 200 },
    ],
    intervalMs: 10,
    timeoutMs: 25,
    fetchImpl: async (url) => (
      url.includes('api') ? new Promise(() => {}) : { status: 200 }
    ),
    clock,
  });

  await flushMicrotasks();
  clock.advance(25);
  await flushMicrotasks();

  const outcome = await Promise.race([
    readiness.then(
      () => ({ kind: 'resolved' }),
      (failure) => ({ kind: 'rejected', failure }),
    ),
    flushMicrotasks().then(() => ({ kind: 'not-settled' })),
  ]);

  assert.equal(outcome.kind, 'rejected');
  assert.equal(outcome.failure.code, 'READINESS_TIMEOUT');
  assert.deepEqual(outcome.failure.services, [
    { service: 'api', attempts: 1, lastStatus: null, lastError: 'deadline_exceeded', elapsedMs: 25 },
  ]);
});
