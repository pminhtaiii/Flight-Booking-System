import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { closeSync, createWriteStream, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

import { waitForReady as defaultWaitForReady } from '../../tests/smoke/helpers/wait-for-ready.mjs';

const PREFIX = '[run-smoke-sanity]';
const DEFAULT_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_GRACE_PERIOD_MS = 5000;
const MODULE_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(MODULE_PATH), '..', '..');
const terminationRuns = new WeakMap();

const systemClock = {
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

function createCancelableReadinessClock() {
  let cancelled = false;
  const handles = new Map();
  const schedule = (settle, milliseconds) => {
    if (cancelled) {
      queueMicrotask(settle);
      return null;
    }
    const handle = setTimeout(() => {
      handles.delete(handle);
      settle();
    }, milliseconds);
    handles.set(handle, settle);
    return handle;
  };

  return {
    clock: {
      now: () => (cancelled ? Number.POSITIVE_INFINITY : Date.now()),
      sleep: (milliseconds) => new Promise((resolve) => schedule(resolve, milliseconds)),
      setTimeout: (callback, milliseconds) => schedule(callback, milliseconds),
      clearTimeout: (handle) => {
        if (handle === null || !handles.has(handle)) return;
        clearTimeout(handle);
        handles.delete(handle);
      },
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      const pending = [...handles.entries()];
      handles.clear();
      for (const [handle, settle] of pending) {
        clearTimeout(handle);
        settle();
      }
    },
  };
}

function safeLabel(value, fallback = 'process') {
  const normalized = String(value ?? '')
    .replace(/[\r\n\t\0]/g, ' ')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 64);
  return normalized || fallback;
}

function joinFromRoot(rootDir, ...segments) {
  return rootDir.startsWith('/')
    ? path.posix.join(rootDir, ...segments)
    : path.join(rootDir, ...segments);
}

function defaultPort(parsedUrl) {
  return parsedUrl.port || (parsedUrl.protocol === 'https:' ? '443' : '80');
}

function stripTrailingSlashes(value) {
  return value.replace(/\/+$/, '');
}

function urlFromEnvironment(env, name, fallback, { required = false } = {}) {
  const value = env[name];
  if (required && !value) {
    throw new Error(`${PREFIX} Error: ${name} is required.`);
  }
  return requireLoopbackUrl(name, value || fallback);
}

export function parseCliArgs(argv) {
  let mode;
  let resetDb = false;

  for (const argument of argv) {
    if (argument.startsWith('--mode=')) {
      if (mode !== undefined) {
        throw new Error(`${PREFIX} Error: Duplicate --mode option.`);
      }
      mode = argument.slice('--mode='.length);
      if (mode !== 'local' && mode !== 'ci') {
        throw new Error(`${PREFIX} Error: --mode must be "local" or "ci".`);
      }
      continue;
    }

    if (argument === '--reset-db') {
      if (resetDb) {
        throw new Error(`${PREFIX} Error: Duplicate --reset-db option.`);
      }
      resetDb = true;
      continue;
    }

    throw new Error(`${PREFIX} Error: Unknown option.`);
  }

  if (mode === undefined) {
    throw new Error(`${PREFIX} Error: Exactly one --mode=local|ci option is required.`);
  }
  if (resetDb && mode !== 'local') {
    throw new Error(`${PREFIX} Error: --reset-db is permitted only in local mode.`);
  }

  return { mode, resetDb };
}

export function requireLoopbackUrl(label, value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${PREFIX} Error: ${safeLabel(label, 'URL')} must be a valid HTTP(S) URL.`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${PREFIX} Error: ${safeLabel(label, 'URL')} must be an HTTP(S) URL.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${PREFIX} Error: ${safeLabel(label, 'URL')} must not contain credentials.`);
  }

  const hostname = parsed.hostname.toLowerCase();
  const ipv4Parts = hostname.split('.');
  const isIpv4Loopback =
    ipv4Parts.length === 4 &&
    ipv4Parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255) &&
    Number(ipv4Parts[0]) === 127;
  const isIpv6Loopback = hostname === '[::1]' || hostname === '::1' || hostname === '[0:0:0:0:0:0:0:1]';

  if (hostname !== 'localhost' && !isIpv4Loopback && !isIpv6Loopback) {
    throw new Error(`${PREFIX} Error: ${safeLabel(label, 'URL')} must use an explicit loopback host.`);
  }

  return parsed;
}

export function databaseNameFromUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${PREFIX} Error: DATABASE_URL must be a valid PostgreSQL URL.`);
  }

  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error(`${PREFIX} Error: DATABASE_URL must be a PostgreSQL URL.`);
  }

  const encodedName = parsed.pathname.startsWith('/') ? parsed.pathname.slice(1) : parsed.pathname;
  try {
    return decodeURIComponent(encodedName);
  } catch {
    throw new Error(`${PREFIX} Error: DATABASE_URL contains an invalid encoded database name.`);
  }
}

export function assertSafeLocalReset(databaseUrl) {
  let name = '';
  try {
    name = databaseNameFromUrl(databaseUrl);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(PREFIX)) throw error;
    throw new Error(`${PREFIX} Error: DATABASE_URL must be a valid PostgreSQL URL.`);
  }

  if (name !== 'smoke_test') {
    const displayName = String(name).replace(/[\r\n\t\0]/g, ' ').slice(0, 128);
    throw new Error(
      `${PREFIX} Error: Refusing to reset database "${displayName}". Local reset is restricted strictly to "smoke_test".`,
    );
  }

  return name;
}

function createRunId() {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
}

export function createProcessDefinitions({
  rootDir = REPOSITORY_ROOT,
  env = process.env,
  mode = 'local',
  runId = createRunId(),
} = {}) {
  const mockUrl = urlFromEnvironment(env, 'SMOKE_MOCK_URL', 'http://127.0.0.1:4010', {
    required: mode === 'ci',
  });
  const apiUrl = urlFromEnvironment(env, 'SMOKE_API_URL', 'http://127.0.0.1:3001/api');
  const agentUrl = urlFromEnvironment(env, 'SMOKE_AGENT_URL', 'http://127.0.0.1:3002');
  const webUrl = urlFromEnvironment(env, 'SMOKE_WEB_URL', 'http://127.0.0.1:3000');
  const diagnosticsDir = joinFromRoot(rootDir, '.smoke-diagnostics', runId);
  const common = {
    shell: false,
    detached: true,
  };

  const withLogs = (definition) => ({
    ...common,
    ...definition,
    stdoutPath: joinFromRoot(diagnosticsDir, `${definition.name}.stdout.log`),
    stderrPath: joinFromRoot(diagnosticsDir, `${definition.name}.stderr.log`),
  });

  return [
    withLogs({
      name: 'mock',
      command: process.execPath,
      args: [joinFromRoot(rootDir, 'tests', 'smoke', 'mocks', 'mock-server.mjs')],
      cwd: rootDir,
      env: { ...env, MOCK_PORT: defaultPort(mockUrl) },
    }),
    withLogs({
      name: 'api',
      command: process.execPath,
      args: [joinFromRoot(rootDir, 'apps', 'api', 'dist', 'main.js')],
      cwd: rootDir,
      env: {
        ...env,
        AGENT_SERVICE_URL: stripTrailingSlashes(agentUrl.href),
        DUFFEL_API_URL: stripTrailingSlashes(mockUrl.href),
        STRIPE_API_URL: stripTrailingSlashes(mockUrl.href),
      },
    }),
    withLogs({
      name: 'agent',
      command: 'uv',
      args: [
        'run',
        'uvicorn',
        'agent.main:app',
        '--host',
        '127.0.0.1',
        '--port',
        defaultPort(agentUrl),
        '--app-dir',
        'src',
      ],
      cwd: joinFromRoot(rootDir, 'apps', 'agent'),
      env: { ...env, NESTJS_API_URL: stripTrailingSlashes(apiUrl.href) },
    }),
    withLogs({
      name: 'web',
      command: process.execPath,
      args: [
        joinFromRoot(rootDir, 'apps', 'web', 'node_modules', 'next', 'dist', 'bin', 'next'),
        'start',
        '--hostname',
        '127.0.0.1',
        '--port',
        defaultPort(webUrl),
      ],
      cwd: joinFromRoot(rootDir, 'apps', 'web'),
      env: { ...env, API_URL: stripTrailingSlashes(apiUrl.href) },
    }),
  ];
}

function jsonValidator(predicate) {
  return async (response) => {
    if (response?.status !== 200) return false;
    try {
      return Boolean(predicate(await response.json()));
    } catch {
      return false;
    }
  };
}

function createReadinessProbes(env) {
  const api = stripTrailingSlashes(
    urlFromEnvironment(env, 'SMOKE_API_URL', 'http://127.0.0.1:3001/api').href,
  );
  const web = stripTrailingSlashes(
    urlFromEnvironment(env, 'SMOKE_WEB_URL', 'http://127.0.0.1:3000').href,
  );
  const agent = stripTrailingSlashes(
    urlFromEnvironment(env, 'SMOKE_AGENT_URL', 'http://127.0.0.1:3002').href,
  );
  const mock = stripTrailingSlashes(
    urlFromEnvironment(env, 'SMOKE_MOCK_URL', 'http://127.0.0.1:4010').href,
  );

  return [
    {
      name: 'api',
      url: `${api}/health`,
      validate: jsonValidator(
        (body) =>
          body?.status === 'ok' &&
          body?.dependencies?.database === 'up' &&
          body?.dependencies?.redis === 'up',
      ),
    },
    {
      name: 'web',
      url: `${web}/`,
      validate: async (response) => {
        if (response?.status !== 200) return false;
        try {
          const html = (await response.text()).toLowerCase();
          return html.includes('wayfinder') || html.includes('landing-title');
        } catch {
          return false;
        }
      },
    },
    {
      name: 'web-upstream',
      url: `${web}/health/upstream`,
      validate: jsonValidator((body) => body?.status === 'ok' && body?.upstream === 'up'),
    },
    {
      name: 'agent',
      url: `${agent}/health`,
      validate: async (response) => response?.status === 200,
    },
    {
      name: 'api-agent',
      url: `${api}/health/agent`,
      validate: jsonValidator((body) => body?.status === 'ok'),
    },
    {
      name: 'mock',
      url: `${mock}/__mock/health`,
      validate: async (response) => response?.status === 200,
    },
  ];
}

function childExitDescription(name, code, signal, stderrPath) {
  const safeName = safeLabel(name, 'child');
  let description;
  if (Number.isInteger(code)) description = `${safeName} exited with code ${code}`;
  else if (signal) description = `${safeName} exited from signal ${safeLabel(signal, 'unknown')}`;
  else description = `${safeName} exited unexpectedly`;
  return stderrPath ? `${description}; diagnostics: ${stderrPath}` : description;
}

function monitorServiceExits(ownedChildren) {
  let active = true;
  let rejectExit;
  let observedFailure;
  const listeners = [];
  const subscribers = new Set();
  const failure = new Promise((_, reject) => {
    rejectExit = reject;
  });

  const fail = (error) => {
    if (!active || observedFailure) return;
    observedFailure = error;
    rejectExit(error);
    for (const subscriber of subscribers) subscriber(error);
    subscribers.clear();
  };

  for (const entry of ownedChildren) {
    const onExit = (code, signal) => {
      fail(
        new Error(
          `${PREFIX} Error: ${childExitDescription(entry.name, code, signal, entry.stderrPath)}.`,
        ),
      );
    };
    const onError = () => {
      fail(
        new Error(
          `${PREFIX} Error: ${safeLabel(entry.name)} failed to start${entry.stderrPath ? `; diagnostics: ${entry.stderrPath}` : ''}.`,
        ),
      );
    };
    entry.child.once('exit', onExit);
    entry.child.once('error', onError);
    listeners.push([entry.child, onExit, onError]);
    if (entry.child.exitCode !== null && entry.child.exitCode !== undefined) {
      onExit(entry.child.exitCode, entry.child.signalCode ?? null);
    } else if (entry.child.signalCode !== null && entry.child.signalCode !== undefined) {
      onExit(null, entry.child.signalCode);
    }
  }

  return {
    failure,
    throwIfFailed() {
      if (observedFailure) throw observedFailure;
    },
    subscribe(subscriber) {
      if (observedFailure) {
        subscriber(observedFailure);
        return () => {};
      }
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
    dispose() {
      active = false;
      subscribers.clear();
      for (const [child, onExit, onError] of listeners) {
        child.removeListener('exit', onExit);
        child.removeListener('error', onError);
      }
    },
  };
}

function waitForChild(child, name, serviceMonitor) {
  if (child.exitCode !== null && child.exitCode !== undefined) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode ?? null });
  }

  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const onExit = (code, signal) => {
      child.removeListener('error', onError);
      unsubscribe();
      resolve({ code, signal });
    };
    const onError = () => {
      child.removeListener('exit', onExit);
      unsubscribe();
      reject(new Error(`${PREFIX} Error: ${safeLabel(name)} failed to start.`));
    };
    const onServiceFailure = (error) => {
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      reject(error);
    };
    child.once('exit', onExit);
    child.once('error', onError);
    if (serviceMonitor) unsubscribe = serviceMonitor.subscribe(onServiceFailure);
  });
}

function openDiagnosticFiles(definition) {
  mkdirSync(path.dirname(definition.stdoutPath), { recursive: true });
  const stdout = openSync(definition.stdoutPath, 'a');
  try {
    const stderr = openSync(definition.stderrPath, 'a');
    return { stdout, stderr };
  } catch (error) {
    closeSync(stdout);
    throw error;
  }
}

function createTransientDiagnostics(serviceDefinitions) {
  const diagnosticsDir = path.dirname(serviceDefinitions[0].stdoutPath);
  return {
    createTransientLogStreams(name) {
      const safeName = safeLabel(name);
      const stdoutPath = path.join(diagnosticsDir, `${safeName}.stdout.log`);
      const stderrPath = path.join(diagnosticsDir, `${safeName}.stderr.log`);
      mkdirSync(diagnosticsDir, { recursive: true });
      const stdoutLog = createWriteStream(stdoutPath, { flags: 'a' });
      const stderrLog = createWriteStream(stderrPath, { flags: 'a' });
      return {
        stdoutPath,
        stderrPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        attach(child) {
          child.stdout?.pipe(stdoutLog);
          child.stdout?.pipe(process.stdout, { end: false });
          child.stderr?.pipe(stderrLog);
          child.stderr?.pipe(process.stderr, { end: false });
        },
        dispose() {
          stdoutLog.destroy();
          stderrLog.destroy();
        },
      };
    },
  };
}

function spawnDefinition(spawnImpl, definition, manageDiagnostics) {
  let logFiles;
  try {
    if (manageDiagnostics) logFiles = openDiagnosticFiles(definition);
    return spawnImpl(definition.command, definition.args, {
      cwd: definition.cwd,
      env: definition.env,
      shell: false,
      detached: definition.detached,
      stdio: logFiles ? ['ignore', logFiles.stdout, logFiles.stderr] : 'ignore',
    });
  } finally {
    if (logFiles) {
      closeSync(logFiles.stdout);
      closeSync(logFiles.stderr);
    }
  }
}

function removeOwnedEntry(ownedChildren, entry) {
  const index = ownedChildren.indexOf(entry);
  if (index !== -1) ownedChildren.splice(index, 1);
}

function startTransientChild({
  name,
  command,
  args,
  cwd,
  env,
  spawnImpl,
  ownedChildren,
  serviceMonitor,
  diagnostics,
}) {
  const logStreams = diagnostics?.createTransientLogStreams(name);
  let child;
  try {
    child = spawnImpl(command, args, {
      cwd,
      env,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: logStreams?.stdio ?? 'inherit',
    });
  } catch (error) {
    logStreams?.dispose?.();
    throw error;
  }
  logStreams?.attach?.(child);
  const entry = {
    name,
    pid: child.pid,
    child,
    stdoutPath: logStreams?.stdoutPath,
    stderrPath: logStreams?.stderrPath,
  };
  ownedChildren.push(entry);
  return { entry, completion: waitForChild(child, name, serviceMonitor) };
}

function assertRunOptions(mode, resetDb) {
  if (mode !== 'local' && mode !== 'ci') {
    throw new Error(`${PREFIX} Error: mode must be "local" or "ci".`);
  }
  if (resetDb && mode !== 'local') {
    throw new Error(`${PREFIX} Error: database reset is permitted only in local mode.`);
  }
}

function sanitizeCleanupOutcome(outcome) {
  const sanitizeEntries = (entries) =>
    Array.isArray(entries)
      ? entries.map((entry) => ({
          name: safeLabel(entry?.name),
          pid: Number.isInteger(entry?.pid) ? entry.pid : null,
        }))
      : [];
  return {
    graceful: sanitizeEntries(outcome?.graceful),
    forced: sanitizeEntries(outcome?.forced),
  };
}

function sanitizeRunFailure(failure) {
  if (!failure || typeof failure !== 'object' || failure.code !== 'READINESS_TIMEOUT') {
    return failure;
  }
  return {
    code: 'READINESS_TIMEOUT',
    elapsedMs: Number.isFinite(failure.elapsedMs) ? failure.elapsedMs : DEFAULT_TIMEOUT_MS,
    services: Array.isArray(failure.services)
      ? failure.services.map((service) => ({
          service: safeLabel(service?.service, 'service'),
          attempts: Number.isInteger(service?.attempts) ? service.attempts : 0,
          lastStatus: Number.isInteger(service?.lastStatus) ? service.lastStatus : null,
          lastError: service?.lastError ? safeLabel(service.lastError, 'request_failed') : null,
          elapsedMs: Number.isFinite(service?.elapsedMs) ? service.elapsedMs : 0,
        }))
      : [],
  };
}

export async function runSmokeSanity({
  mode,
  resetDb = false,
  rootDir = REPOSITORY_ROOT,
  env = process.env,
  definitions,
  spawn: spawnImpl = nodeSpawn,
  waitForReady = defaultWaitForReady,
  terminateOwnedChildren: terminate = terminateOwnedChildren,
  ownedChildren = [],
  probes,
  diagnostics,
} = {}) {
  let exitMonitor;
  let cancelReadiness;
  let runFailure;

  try {
    assertRunOptions(mode, resetDb);
    const serviceDefinitions = definitions ?? createProcessDefinitions({ rootDir, env, mode });
    const transientDiagnostics =
      diagnostics ?? (spawnImpl === nodeSpawn ? createTransientDiagnostics(serviceDefinitions) : undefined);
    if (resetDb) {
      assertSafeLocalReset(env.DATABASE_URL);
      const reset = startTransientChild({
        name: 'database-reset',
        command: process.execPath,
        args: [
          joinFromRoot(rootDir, 'node_modules', 'prisma', 'build', 'index.js'),
          'migrate',
          'reset',
          '--force',
        ],
        cwd: rootDir,
        env,
        spawnImpl,
        ownedChildren,
        diagnostics: transientDiagnostics,
      });
      let resetResult;
      try {
        resetResult = await reset.completion;
      } finally {
        removeOwnedEntry(ownedChildren, reset.entry);
      }
      if (resetResult.code !== 0) {
        throw new Error(`${PREFIX} Error: database reset exited with code ${resetResult.code}.`);
      }
    }

    const manageDiagnostics = spawnImpl === nodeSpawn;
    for (const definition of serviceDefinitions) {
      const child = spawnDefinition(spawnImpl, definition, manageDiagnostics);
      ownedChildren.push({
        name: definition.name,
        pid: child.pid,
        child,
        stdoutPath: definition.stdoutPath,
        stderrPath: definition.stderrPath,
      });
    }

    exitMonitor = monitorServiceExits(ownedChildren);
    // The service monitor also notifies active suite waits directly. This handler
    // prevents a later service exit from becoming an unhandled rejection.
    void exitMonitor.failure.catch(() => {});
    exitMonitor.throwIfFailed();
    const readinessController = createCancelableReadinessClock();
    const readiness = Promise.resolve(
      waitForReady({
        probes: probes ?? createReadinessProbes(env),
        intervalMs: DEFAULT_INTERVAL_MS,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        clock: readinessController.clock,
      }),
    );
    cancelReadiness = () => {
      readiness.cancel?.();
      readinessController.cancel();
    };
    let readinessSettled = false;
    let readinessFailure;
    readiness.then(
      () => {
        readinessSettled = true;
      },
      (error) => {
        readinessSettled = true;
        readinessFailure = error;
      },
    );

    // If an injected readiness adapter is already settled, keep direct-await
    // scheduling. Otherwise, race the real probe wait against service exit.
    await Promise.resolve();
    if (readinessSettled) {
      if (readinessFailure !== undefined) throw readinessFailure;
    } else {
      await Promise.race([readiness, exitMonitor.failure]);
    }

    const smoke = startTransientChild({
      name: 'smoke',
      command: process.execPath,
      args: [
        '--test',
        '--test-reporter=spec',
        joinFromRoot(rootDir, 'tests', 'smoke', 'smoke.test.mjs'),
      ],
      cwd: rootDir,
      env,
      spawnImpl,
      ownedChildren,
      serviceMonitor: exitMonitor,
      diagnostics: transientDiagnostics,
    });
    let smokeResult;
    let smokeCompleted = false;
    try {
      smokeResult = await smoke.completion;
      smokeCompleted = true;
    } finally {
      if (smokeCompleted) removeOwnedEntry(ownedChildren, smoke.entry);
    }
    if (smokeResult.code !== 0) {
      throw new Error(`${PREFIX} Error: smoke suite exited with code ${smokeResult.code}.`);
    }

    const sanity = startTransientChild({
      name: 'sanity',
      command: process.execPath,
      args: [
        '--test',
        '--test-reporter=spec',
        joinFromRoot(rootDir, 'tests', 'smoke', 'sanity.test.mjs'),
      ],
      cwd: rootDir,
      env,
      spawnImpl,
      ownedChildren,
      serviceMonitor: exitMonitor,
      diagnostics: transientDiagnostics,
    });
    let sanityResult;
    let sanityCompleted = false;
    try {
      sanityResult = await sanity.completion;
      sanityCompleted = true;
    } finally {
      if (sanityCompleted) removeOwnedEntry(ownedChildren, sanity.entry);
    }
    if (sanityResult.code !== 0) {
      throw new Error(`${PREFIX} Error: sanity suite exited with code ${sanityResult.code}.`);
    }

    return { smokeExitCode: smokeResult.code, sanityExitCode: sanityResult.code };
  } catch (error) {
    runFailure = sanitizeRunFailure(error);
    throw runFailure;
  } finally {
    cancelReadiness?.();
    exitMonitor?.dispose();
    const cleanupOutcome = sanitizeCleanupOutcome(await terminate(ownedChildren));
    if (runFailure && typeof runFailure === 'object') runFailure.cleanup = cleanupOutcome;
  }
}

function defaultIsChildAlive(child) {
  return child.exitCode === null && child.signalCode === null;
}

function defaultTerminateProcessGroup(processGroupId, signal) {
  try {
    process.kill(processGroupId, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

function defaultIsProcessGroupAlive(entry) {
  try {
    process.kill(-entry.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

function defaultRequestGracefulTermination(child) {
  child.kill('SIGTERM');
}

function defaultTaskkillPidTree(pid) {
  return new Promise((resolve, reject) => {
    execFile(
      'taskkill',
      ['/PID', String(pid), '/T', '/F'],
      { windowsHide: true },
      (error) => (error ? reject(new Error(`${PREFIX} Error: Windows process cleanup failed.`)) : resolve()),
    );
  });
}

export function terminateOwnedChildren(
  ownedChildren,
  {
    platform = process.platform,
    gracePeriodMs = DEFAULT_GRACE_PERIOD_MS,
    clock = systemClock,
    isChildAlive = defaultIsChildAlive,
    isRecordedTreeAlive,
    terminateProcessGroup = defaultTerminateProcessGroup,
    requestGracefulTermination = defaultRequestGracefulTermination,
    taskkillPidTree = defaultTaskkillPidTree,
  } = {},
) {
  if (!Array.isArray(ownedChildren)) {
    return Promise.reject(new TypeError('ownedChildren must be an array'));
  }
  if (terminationRuns.has(ownedChildren)) return terminationRuns.get(ownedChildren);

  const cleanup = (async () => {
    const graceful = [];
    const forced = [];
    const recordedTreeIsAlive =
      isRecordedTreeAlive ??
      (platform !== 'win32' && isChildAlive === defaultIsChildAlive
        ? defaultIsProcessGroupAlive
        : (entry) => isChildAlive(entry.child));
    const liveEntries = ownedChildren.filter(
      (entry) => Number.isInteger(entry.pid) && entry.pid > 0 && recordedTreeIsAlive(entry),
    );

    for (const entry of liveEntries) {
      if (platform === 'win32') {
        await requestGracefulTermination(entry.child);
      } else {
        await terminateProcessGroup(-entry.pid, 'SIGTERM');
      }
      graceful.push({ name: entry.name, pid: entry.pid });
    }

    if (liveEntries.length > 0) await clock.sleep(gracePeriodMs);

    for (const entry of liveEntries) {
      if (!recordedTreeIsAlive(entry)) continue;
      if (platform === 'win32') {
        await taskkillPidTree(entry.pid);
      } else {
        await terminateProcessGroup(-entry.pid, 'SIGKILL');
      }
      forced.push({ name: entry.name, pid: entry.pid });
    }

    return { graceful, forced };
  })();

  terminationRuns.set(ownedChildren, cleanup);
  return cleanup;
}

export function installShutdownHandlers({ processRef = process, cleanup }) {
  if (typeof cleanup !== 'function') throw new TypeError('cleanup must be a function');

  let shutdownPromise;
  const shutdown = (reason) => {
    if (!shutdownPromise) {
      shutdownPromise = Promise.resolve()
        .then(() => cleanup(reason))
        .then(() => {
          processRef.exitCode = 1;
        })
        .catch(() => {
          processRef.exitCode = 1;
        });
    }
    return shutdownPromise;
  };

  const handlers = new Map(
    ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'].map((eventName) => [
      eventName,
      () => void shutdown(eventName),
    ]),
  );
  for (const [eventName, handler] of handlers) processRef.on(eventName, handler);

  const dispose = () => {
    for (const [eventName, handler] of handlers) processRef.removeListener(eventName, handler);
  };
  dispose.shutdown = shutdown;
  dispose.whenSettled = () => shutdownPromise ?? Promise.resolve();
  return dispose;
}

function safeCliMessage(error) {
  if (error instanceof Error && error.message.startsWith(PREFIX)) return error.message;
  if (error?.code === 'READINESS_TIMEOUT') {
    return `${PREFIX} Error: ${JSON.stringify(error)}`;
  }
  return `${PREFIX} Error: Smoke/sanity orchestration failed; inspect the diagnostics directory.`;
}

async function runCli() {
  const cli = parseCliArgs(process.argv.slice(2));
  const ownedChildren = [];
  const definitions = createProcessDefinitions({ rootDir: REPOSITORY_ROOT, env: process.env, mode: cli.mode });
  const diagnosticsDir = path.dirname(definitions[0].stdoutPath);
  const disposeHandlers = installShutdownHandlers({
    processRef: process,
    cleanup: () => terminateOwnedChildren(ownedChildren),
  });

  try {
    console.error(`${PREFIX} Diagnostics: ${diagnosticsDir}`);
    await runSmokeSanity({
      ...cli,
      rootDir: REPOSITORY_ROOT,
      env: process.env,
      definitions,
      ownedChildren,
    });
  } finally {
    disposeHandlers();
  }
}

const isDirectExecution =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === pathToFileURL(MODULE_PATH).href;

if (isDirectExecution) {
  runCli().catch((error) => {
    console.error(safeCliMessage(error));
    process.exitCode = 1;
  });
}
