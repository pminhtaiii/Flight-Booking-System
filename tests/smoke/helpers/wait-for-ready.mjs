const DEADLINE_REACHED = Symbol('deadline-reached');

const systemClock = {
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (timerId) => clearTimeout(timerId),
};

function assertTimerClock(clock) {
  const requiredMethods = ['now', 'sleep', 'setTimeout', 'clearTimeout'];
  if (!clock || requiredMethods.some((method) => typeof clock[method] !== 'function')) {
    throw new TypeError('clock must provide now, sleep, setTimeout, and clearTimeout functions');
  }
}

function createDeadline(clock, timeoutMs) {
  let timerId;
  const signal = new Promise((resolve) => {
    timerId = clock.setTimeout(resolve, timeoutMs);
  });

  return {
    cancel: () => clock.clearTimeout?.(timerId),
    signal: signal.then(() => DEADLINE_REACHED),
  };
}

function failureReport(services, ready, elapsedMs) {
  return {
    code: 'READINESS_TIMEOUT',
    elapsedMs,
    services: services
      .filter((_, index) => !ready[index])
      .map((service) => ({
        ...service,
        lastError:
          service.lastStatus === null && service.lastError === null
            ? 'deadline_exceeded'
            : service.lastError,
        elapsedMs,
      })),
  };
}

export async function waitForReady({
  probes,
  intervalMs = 2000,
  timeoutMs = 120000,
  fetchImpl = globalThis.fetch,
  clock = systemClock,
}) {
  assertTimerClock(clock);
  const startedAt = clock.now();
  const deadlineAt = startedAt + timeoutMs;
  const services = probes.map((probe) => ({
    service: probe.name,
    attempts: 0,
    lastStatus: null,
    lastError: null,
    elapsedMs: 0,
  }));
  const ready = probes.map(() => false);
  const deadline = createDeadline(clock, timeoutMs);
  let timedOut = false;
  const deadlineSignal = deadline.signal?.then((signal) => {
    timedOut = true;
    return signal;
  });

  const poll = async (probe, index) => {
    const service = services[index];
    while (!timedOut && clock.now() < deadlineAt) {
      service.attempts += 1;
      const attempt = (async () => {
        let response;
        try {
          response = await fetchImpl(probe.url);
        } catch {
          if (!timedOut) {
            service.lastStatus = null;
            service.lastError = 'request_failed';
          }
          return;
        }

        if (timedOut) {
          return;
        }

        service.lastStatus = Number.isInteger(response?.status) ? response.status : null;
        service.lastError = null;

        try {
          if (await probe.validate(response)) {
            ready[index] = true;
            service.elapsedMs = clock.now() - startedAt;
          }
        } catch {
          if (!timedOut) {
            service.lastError = 'validation_failed';
          }
        }
      })();

      const outcome = await Promise.race([attempt, deadlineSignal]);
      if (outcome === DEADLINE_REACHED || ready[index]) {
        return;
      }

      const remainingMs = deadlineAt - clock.now();
      if (remainingMs <= 0) {
        return;
      }

      const pause = clock.sleep(Math.min(intervalMs, remainingMs));
      const pauseOutcome = await Promise.race([pause, deadlineSignal]);
      if (pauseOutcome === DEADLINE_REACHED) {
        return;
      }
    }
    service.elapsedMs = Math.min(clock.now() - startedAt, timeoutMs);
  };

  try {
    const probesComplete = Promise.all(probes.map(poll));
    const outcome = deadlineSignal
      ? await Promise.race([probesComplete, deadlineSignal])
      : await probesComplete;
    const elapsedMs = Math.min(clock.now() - startedAt, timeoutMs);

    if (outcome === DEADLINE_REACHED || ready.some((isReady) => !isReady)) {
      throw failureReport(services, ready, elapsedMs);
    }

    return { ok: true, elapsedMs, services };
  } finally {
    deadline.cancel();
  }
}
