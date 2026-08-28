import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  assertSafeLocalReset,
  createProcessDefinitions,
  databaseNameFromUrl,
  installShutdownHandlers,
  parseCliArgs,
  requireLoopbackUrl,
  runSmokeSanity,
  terminateOwnedChildren,
} from '../../scripts/ci/run-smoke-sanity.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;
  return child;
}

function serviceDefinitions() {
  return ['mock', 'api', 'agent', 'web'].map((name, index) => ({
    name,
    command: process.execPath,
    args: [`${name}.mjs`],
    shell: false,
    stdoutPath: `/diagnostics/${name}.stdout.log`,
    stderrPath: `/diagnostics/${name}.stderr.log`,
    pid: index + 1,
  }));
}

function suiteName(args) {
  if (args.some((argument) => argument.includes('smoke.test.mjs'))) return 'smoke';
  if (args.some((argument) => argument.includes('sanity.test.mjs'))) return 'sanity';
  return null;
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test('parses one explicit mode and permits database reset only for local runs', () => {
  // Catches a mutation that accepts reset in CI or silently defaults a missing mode.
  assert.deepEqual(parseCliArgs(['--mode=local']), { mode: 'local', resetDb: false });
  assert.deepEqual(parseCliArgs(['--mode=local', '--reset-db']), { mode: 'local', resetDb: true });
  assert.deepEqual(parseCliArgs(['--mode=ci']), { mode: 'ci', resetDb: false });

  for (const argv of [
    [],
    ['--reset-db'],
    ['--mode=ci', '--reset-db'],
    ['--mode=preview'],
    ['--mode=local', '--mode=ci'],
    ['--unknown'],
  ]) {
    assert.throws(() => parseCliArgs(argv), /mode|reset|unknown|duplicate/i);
  }
});

test('allows service URLs only on an explicit loopback host', () => {
  // Catches a mutation that permits a remote or wildcard service endpoint.
  for (const value of ['http://localhost:3000', 'http://127.0.0.1:3001/api', 'http://[::1]:3002']) {
    const parsed = requireLoopbackUrl('service URL', value);
    assert.ok(parsed instanceof URL);
  }

  for (const value of [
    'https://example.com',
    'http://192.0.2.10:3000',
    'http://0.0.0.0:3000',
    'http://[::]:3000',
    'http://user:password@127.0.0.1:3000',
    'not a URL',
  ]) {
    assert.throws(() => requireLoopbackUrl('service URL', value), /loopback|URL|credential/i);
  }
});

test('derives the exact decoded database name without query parameters', () => {
  // Catches a mutation that treats a schema query, encoding, or path separator as part of the name.
  assert.equal(
    databaseNameFromUrl('postgresql://postgres:postgres@127.0.0.1:5432/smoke_test?schema=public'),
    'smoke_test',
  );
  assert.equal(
    databaseNameFromUrl('postgresql://postgres@localhost:5432/%73moke_test'),
    'smoke_test',
  );
  assert.equal(
    databaseNameFromUrl('postgresql://postgres@localhost:5432/smoke_test%2Farchive'),
    'smoke_test/archive',
  );
});

test('permits reset only for the dedicated smoke_test database', () => {
  // Catches a mutation that resets a default, empty, lookalike, or encoded-separator database.
  assert.equal(
    assertSafeLocalReset('postgresql://postgres@localhost:5432/smoke_test?schema=public'),
    'smoke_test',
  );

  for (const [value, name] of [
    ['postgresql://postgres@localhost:5432/flight_booking', 'flight_booking'],
    ['postgresql://postgres@localhost:5432/test_db', 'test_db'],
    ['postgresql://postgres@localhost:5432/postgres', 'postgres'],
    ['postgresql://postgres@localhost:5432/', ''],
    ['postgresql://postgres@localhost:5432/%2Fsmoke_test', '/smoke_test'],
    ['postgresql://postgres@localhost:5432/%5Csmoke_test', '\\smoke_test'],
    ['postgresql://postgres@localhost:5432/smoke_test%2Farchive', 'smoke_test/archive'],
    ['postgresql://postgres@localhost:5432/smoke_test%5Carchive', 'smoke_test\\archive'],
    ['postgresql://postgres@localhost:5432/smoke_test_backup', 'smoke_test_backup'],
  ]) {
    assert.throws(
      () => assertSafeLocalReset(value),
      (error) => {
        assert.equal(
          error.message,
          `[run-smoke-sanity] Error: Refusing to reset database "${name}". Local reset is restricted strictly to "smoke_test".`,
        );
        return true;
      },
    );
  }
});

test('builds owned mock, API, agent, and web definitions with isolated diagnostics', () => {
  // Catches a mutation that uses a shell, wrapper Node binary, shared output, or omits a service.
  const definitions = createProcessDefinitions({
    rootDir: '/workspace',
    env: {
      SMOKE_MOCK_URL: 'http://127.0.0.1:4010',
      SMOKE_API_URL: 'http://127.0.0.1:3001/api',
      SMOKE_AGENT_URL: 'http://127.0.0.1:3002',
      SMOKE_WEB_URL: 'http://127.0.0.1:3000',
    },
  });

  assert.deepEqual(
    definitions.map((definition) => definition.name),
    ['mock', 'api', 'agent', 'web'],
  );
  assert.ok(definitions.every((definition) => definition.shell === false));
  assert.ok(definitions.every((definition) => definition.detached === true));
  assert.ok(
    definitions
      .filter((definition) => definition.name !== 'agent')
      .every((definition) => definition.command === process.execPath),
  );
  assert.equal(new Set(definitions.map((definition) => definition.stdoutPath)).size, 4);
  assert.equal(new Set(definitions.map((definition) => definition.stderrPath)).size, 4);
  assert.equal(
    new Set(definitions.flatMap((definition) => [definition.stdoutPath, definition.stderrPath])).size,
    8,
  );

  const byName = Object.fromEntries(definitions.map((definition) => [definition.name, definition]));
  assert.equal(byName.mock.command, process.execPath);
  assert.deepEqual(byName.mock.args, ['/workspace/tests/smoke/mocks/mock-server.mjs']);
  assert.equal(byName.mock.cwd, '/workspace');
  assert.equal(byName.mock.env.MOCK_PORT, '4010');
  assert.equal(byName.api.command, process.execPath);
  assert.deepEqual(byName.api.args, ['/workspace/apps/api/dist/main.js']);
  assert.equal(byName.api.cwd, '/workspace');
  assert.equal(byName.agent.command, 'uv');
  assert.deepEqual(byName.agent.args, [
    'run',
    'uvicorn',
    'agent.main:app',
    '--host',
    '127.0.0.1',
    '--port',
    '3002',
    '--app-dir',
    'src',
  ]);
  assert.equal(byName.agent.cwd, '/workspace/apps/agent');
  assert.equal(byName.web.command, process.execPath);
  assert.deepEqual(byName.web.args, [
    '/workspace/apps/web/node_modules/next/dist/bin/next',
    'start',
    '--hostname',
    '127.0.0.1',
    '--port',
    '3000',
  ]);
  assert.equal(byName.web.cwd, '/workspace/apps/web');
});

test('rejects immediately when a recorded service exits during readiness without starting a suite', async () => {
  // Catches a mutation that waits for the readiness deadline after a child exit or starts a suite anyway.
  const readiness = deferred();
  const children = new Map(serviceDefinitions().map((definition) => [definition.name, createChild(definition.pid)]));
  const spawned = [];
  const cleanupCalls = [];

  const run = runSmokeSanity({
    mode: 'ci',
    resetDb: false,
    definitions: serviceDefinitions(),
    spawn: (command, args) => {
      const name = suiteName(args);
      spawned.push(name ?? args[0]);
      return name ? createChild(name === 'smoke' ? 91 : 92) : children.get(args[0].replace('.mjs', ''));
    },
    waitForReady: () => readiness.promise,
    terminateOwnedChildren: async (ownedChildren) => {
      cleanupCalls.push(ownedChildren);
      return { graceful: [], forced: [] };
    },
  });

  await Promise.resolve();
  children.get('api').emit('exit', 17, null);

  await assert.rejects(run, /api.*17|17.*api/i);
  assert.deepEqual(spawned, ['mock.mjs', 'api.mjs', 'agent.mjs', 'web.mjs']);
  assert.equal(cleanupCalls.length, 1);
  assert.deepEqual(cleanupCalls[0].map((entry) => entry.name), ['mock', 'api', 'agent', 'web']);
});

test('runs smoke after readiness and never starts sanity when smoke exits non-zero', async () => {
  // Catches a mutation that starts sanity despite a failed smoke suite.
  const spawned = [];
  const children = new Map(serviceDefinitions().map((definition) => [definition.name, createChild(definition.pid)]));
  const smoke = createChild(91);
  const cleanupCalls = [];

  const run = runSmokeSanity({
    mode: 'ci',
    resetDb: false,
    definitions: serviceDefinitions(),
    spawn: (_command, args) => {
      const name = suiteName(args);
      spawned.push(name ?? args[0]);
      return name === 'smoke' ? smoke : children.get(args[0].replace('.mjs', ''));
    },
    waitForReady: async () => ({ ok: true, services: [] }),
    terminateOwnedChildren: async (ownedChildren) => {
      cleanupCalls.push(ownedChildren);
      return { graceful: [], forced: [] };
    },
  });

  await Promise.resolve();
  smoke.emit('exit', 1, null);

  await assert.rejects(run, /smoke.*1|1.*smoke/i);
  assert.ok(spawned.includes('smoke'));
  assert.equal(spawned.includes('sanity'), false);
  assert.equal(cleanupCalls.length, 1);
  assert.deepEqual(cleanupCalls[0].map((entry) => entry.name), ['mock', 'api', 'agent', 'web']);
});

test('runs sanity only after a successful smoke suite and reports both successful exits', async () => {
  // Catches a mutation that starts suites concurrently or reports success before sanity completes.
  const spawned = [];
  const children = new Map(serviceDefinitions().map((definition) => [definition.name, createChild(definition.pid)]));
  const smoke = createChild(91);
  const sanity = createChild(92);

  const run = runSmokeSanity({
    mode: 'ci',
    resetDb: false,
    definitions: serviceDefinitions(),
    spawn: (_command, args) => {
      const name = suiteName(args);
      spawned.push(name ?? args[0]);
      if (name === 'smoke') return smoke;
      if (name === 'sanity') return sanity;
      return children.get(args[0].replace('.mjs', ''));
    },
    waitForReady: async () => ({ ok: true, services: [] }),
    terminateOwnedChildren: async () => ({ graceful: [], forced: [] }),
  });

  await Promise.resolve();
  assert.deepEqual(spawned.slice(-1), ['smoke']);
  smoke.emit('exit', 0, null);
  await Promise.resolve();
  assert.deepEqual(spawned.slice(-2), ['smoke', 'sanity']);
  sanity.emit('exit', 0, null);

  assert.deepEqual(await run, { smokeExitCode: 0, sanityExitCode: 0 });
});

test('converges SIGINT, SIGTERM, uncaught exceptions, and rejected promises on one asynchronous cleanup', async () => {
  // Catches a mutation that installs separate shutdown paths or starts cleanup more than once.
  const processRef = new EventEmitter();
  const cleanupFinished = deferred();
  const cleanupReasons = [];
  const removeHandlers = installShutdownHandlers({
    processRef,
    cleanup: async (reason) => {
      cleanupReasons.push(reason);
      await cleanupFinished.promise;
    },
  });

  processRef.emit('SIGINT');
  processRef.emit('SIGTERM');
  processRef.emit('uncaughtException', new Error('expected test exception'));
  processRef.emit('unhandledRejection', new Error('expected test rejection'));
  await flushMicrotasks();

  assert.deepEqual(cleanupReasons, ['SIGINT']);
  cleanupFinished.resolve();
  await flushMicrotasks();
  removeHandlers();
  assert.equal(processRef.listenerCount('SIGINT'), 0);
  assert.equal(processRef.listenerCount('SIGTERM'), 0);
  assert.equal(processRef.listenerCount('uncaughtException'), 0);
  assert.equal(processRef.listenerCount('unhandledRejection'), 0);
});

test('terminates only recorded POSIX process groups, waits exactly five seconds, and force-escalates survivors once', async () => {
  // Catches a mutation that pattern-kills ambient processes, force-kills before grace, or cleans twice.
  const api = createChild(601);
  const alreadyExited = createChild(602);
  alreadyExited.exitCode = 0;
  const exitsDuringGrace = createChild(603);
  const ambient = createChild(699);
  const signals = [];
  const gracePeriods = [];
  const options = {
    platform: 'linux',
    gracePeriodMs: 5000,
    clock: { sleep: async (milliseconds) => gracePeriods.push(milliseconds) },
    isChildAlive: (child) => child.exitCode === null,
    terminateProcessGroup: (processGroupId, signal) => {
      signals.push([processGroupId, signal]);
      if (processGroupId === -603 && signal === 'SIGTERM') exitsDuringGrace.exitCode = 0;
      if (signal === 'SIGKILL') api.exitCode = 137;
    },
  };

  const children = [
    { name: 'api', pid: api.pid, child: api },
    { name: 'web', pid: alreadyExited.pid, child: alreadyExited },
    { name: 'mock', pid: exitsDuringGrace.pid, child: exitsDuringGrace },
  ];
  const first = await terminateOwnedChildren(children, options);
  const second = await terminateOwnedChildren(children, options);

  assert.deepEqual(signals, [
    [-601, 'SIGTERM'],
    [-603, 'SIGTERM'],
    [-601, 'SIGKILL'],
  ]);
  assert.equal(signals.some(([pid]) => pid === -ambient.pid), false);
  assert.deepEqual(gracePeriods, [5000]);
  assert.deepEqual(first, {
    graceful: [
      { name: 'api', pid: 601 },
      { name: 'mock', pid: 603 },
    ],
    forced: [{ name: 'api', pid: 601 }],
  });
  assert.deepEqual(second, first);
});

test('uses only recorded Windows PIDs, waits exactly five seconds, and never force-kills a child that exits gracefully', async () => {
  // Catches a mutation that skips graceful termination or taskkills a non-owned PID tree.
  const agent = createChild(701);
  const exited = createChild(702);
  exited.exitCode = 0;
  const exitsDuringGrace = createChild(703);
  const ambient = createChild(799);
  const graceful = [];
  const force = [];
  const gracePeriods = [];
  const options = {
    platform: 'win32',
    gracePeriodMs: 5000,
    clock: { sleep: async (milliseconds) => gracePeriods.push(milliseconds) },
    isChildAlive: (child) => child.exitCode === null,
    requestGracefulTermination: (child) => {
      graceful.push(child.pid);
      if (child.pid === 703) exitsDuringGrace.exitCode = 0;
    },
    taskkillPidTree: (pid) => {
      force.push(pid);
      agent.exitCode = 1;
    },
  };

  const children = [
    { name: 'agent', pid: agent.pid, child: agent },
    { name: 'web', pid: exited.pid, child: exited },
    { name: 'mock', pid: exitsDuringGrace.pid, child: exitsDuringGrace },
  ];
  const report = await terminateOwnedChildren(children, options);
  const repeatedReport = await terminateOwnedChildren(children, options);

  assert.deepEqual(graceful, [701, 703]);
  assert.deepEqual(force, [701]);
  assert.equal([...graceful, ...force].includes(ambient.pid), false);
  assert.deepEqual(gracePeriods, [5000]);
  assert.deepEqual(report, {
    graceful: [
      { name: 'agent', pid: 701 },
      { name: 'mock', pid: 703 },
    ],
    forced: [{ name: 'agent', pid: 701 }],
  });
  assert.deepEqual(repeatedReport, report);
});

test('rejects an already-exited or synchronously exited service before readiness can start either suite', async () => {
  // Catches a mutation that installs exit monitoring after spawn without checking an already-observed exit.
  for (const exitTiming of ['already-exited', 'synchronous-before-monitor']) {
    const children = new Map(
      serviceDefinitions().map((definition) => [definition.name, createChild(definition.pid)]),
    );
    const api = children.get('api');
    if (exitTiming === 'already-exited') api.exitCode = 17;
    const suites = [];

    const run = runSmokeSanity({
      mode: 'ci',
      definitions: serviceDefinitions(),
      spawn: (_command, args) => {
        const suite = suiteName(args);
        if (suite) {
          suites.push(suite);
          throw new Error('a suite must not start after a service has exited');
        }
        const child = children.get(args[0].replace('.mjs', ''));
        if (exitTiming === 'synchronous-before-monitor' && child === api) {
          child.exitCode = 17;
          child.emit('exit', 17, null);
        }
        return child;
      },
      waitForReady: async () => ({ ok: true, services: [] }),
      terminateOwnedChildren: async () => ({ graceful: [], forced: [] }),
    });

    await assert.rejects(run, /api.*17|17.*api/i, exitTiming);
    assert.deepEqual(suites, [], exitTiming);
  }
});

test('cancels the pending readiness deadline when a service exit wins the readiness race', async () => {
  // Catches a mutation that leaves the 120-second readiness timer referenced after a premature exit.
  const children = new Map(
    serviceDefinitions().map((definition) => [definition.name, createChild(definition.pid)]),
  );
  const outstandingTimerHandles = new Set(['readiness-deadline']);
  const readiness = deferred();
  readiness.promise.cancel = () => outstandingTimerHandles.clear();

  const run = runSmokeSanity({
    mode: 'ci',
    definitions: serviceDefinitions(),
    spawn: (_command, args) => children.get(args[0].replace('.mjs', '')),
    waitForReady: () => readiness.promise,
    terminateOwnedChildren: async () => ({ graceful: [], forced: [] }),
  });

  await flushMicrotasks();
  children.get('api').emit('exit', 17, null);

  await assert.rejects(run, /api.*17|17.*api/i);
  assert.deepEqual([...outstandingTimerHandles], []);
});

test('sets the shutdown exit code only after asynchronous cleanup settles', async () => {
  // Catches a mutation that signals failure before owned-child cleanup has completed.
  const processRef = new EventEmitter();
  const cleanupFinished = deferred();
  const removeHandlers = installShutdownHandlers({
    processRef,
    cleanup: () => cleanupFinished.promise,
  });

  processRef.emit('SIGTERM');
  await flushMicrotasks();
  assert.equal(processRef.exitCode, undefined);
  cleanupFinished.resolve();
  await removeHandlers.whenSettled();
  assert.equal(processRef.exitCode, 1);
  removeHandlers();
});

test('captures reset, smoke, and sanity output in distinct run-scoped diagnostics while keeping their output piped', async () => {
  // Catches a mutation that leaves transient suite output on inherited streams without per-run diagnostics.
  const children = new Map(
    serviceDefinitions().map((definition) => [definition.name, createChild(definition.pid)]),
  );
  const openedDiagnostics = [];
  const transientSpawnOptions = [];
  let nextPid = 80;
  const transientChild = () => {
    const child = createChild(nextPid);
    nextPid += 1;
    queueMicrotask(() => {
      child.exitCode = 0;
      child.emit('exit', 0, null);
    });
    return child;
  };

  const result = await runSmokeSanity({
    mode: 'local',
    resetDb: true,
    env: { DATABASE_URL: 'postgresql://postgres@127.0.0.1:5432/smoke_test' },
    definitions: serviceDefinitions(),
    diagnostics: {
      createTransientLogStreams: (name) => {
        openedDiagnostics.push(name);
        return { stdio: ['ignore', 'pipe', 'pipe'] };
      },
    },
    spawn: (_command, args, options) => {
      const suite = suiteName(args);
      const isReset = args.includes('migrate') && args.includes('reset');
      if (suite || isReset) {
        transientSpawnOptions.push({ name: suite ?? 'database-reset', stdio: options.stdio });
        return transientChild();
      }
      return children.get(args[0].replace('.mjs', ''));
    },
    waitForReady: async () => ({ ok: true, services: [] }),
    terminateOwnedChildren: async () => ({ graceful: [], forced: [] }),
  });

  assert.deepEqual(result, { smokeExitCode: 0, sanityExitCode: 0 });
  assert.deepEqual(openedDiagnostics, ['database-reset', 'smoke', 'sanity']);
  assert.deepEqual(transientSpawnOptions, [
    { name: 'database-reset', stdio: ['ignore', 'pipe', 'pipe'] },
    { name: 'smoke', stdio: ['ignore', 'pipe', 'pipe'] },
    { name: 'sanity', stdio: ['ignore', 'pipe', 'pipe'] },
  ]);
});

test('preserves a safe structured readiness failure and exposes the final cleanup outcome', async () => {
  // Catches a mutation that drops readiness diagnostics or discards cleanup results in the finalizer.
  const readinessFailure = {
    code: 'READINESS_TIMEOUT',
    elapsedMs: 120000,
    services: [
      { service: 'api', attempts: 3, lastStatus: 503, lastError: null, elapsedMs: 120000 },
      {
        service: 'agent',
        attempts: 3,
        lastStatus: null,
        lastError: 'request_failed',
        elapsedMs: 120000,
      },
    ],
  };
  const cleanupOutcome = { graceful: [{ name: 'api', pid: 1 }], forced: [] };
  const children = new Map(
    serviceDefinitions().map((definition) => [definition.name, createChild(definition.pid)]),
  );

  await assert.rejects(
    runSmokeSanity({
      mode: 'ci',
      definitions: serviceDefinitions(),
      spawn: (_command, args) => children.get(args[0].replace('.mjs', '')),
      waitForReady: async () => Promise.reject(readinessFailure),
      terminateOwnedChildren: async () => cleanupOutcome,
    }),
    (failure) => {
      assert.equal(failure.code, 'READINESS_TIMEOUT');
      assert.equal(failure.elapsedMs, 120000);
      assert.deepEqual(failure.services, readinessFailure.services);
      assert.doesNotMatch(JSON.stringify(failure), /password|token|authorization|bearer/i);
      assert.deepEqual(failure.cleanup, cleanupOutcome);
      return true;
    },
  );
});

test('force-escalates a recorded POSIX group when its root exited but a recorded descendant remains alive', async () => {
  // Catches a mutation that decides cleanup safety from only the root child handle.
  const root = createChild(801);
  root.exitCode = 0;
  const ambient = createChild(899);
  let recordedTreeAlive = true;
  const signals = [];
  const gracePeriods = [];

  const report = await terminateOwnedChildren(
    [{ name: 'api', pid: root.pid, child: root }],
    {
      platform: 'linux',
      gracePeriodMs: 5000,
      clock: { sleep: async (milliseconds) => gracePeriods.push(milliseconds) },
      isChildAlive: () => false,
      isRecordedTreeAlive: (entry) => entry.pid === root.pid && recordedTreeAlive,
      terminateProcessGroup: (processGroupId, signal) => {
        signals.push([processGroupId, signal]);
        if (signal === 'SIGKILL') recordedTreeAlive = false;
      },
    },
  );

  assert.deepEqual(signals, [
    [-801, 'SIGTERM'],
    [-801, 'SIGKILL'],
  ]);
  assert.equal(signals.some(([pid]) => pid === -ambient.pid), false);
  assert.deepEqual(gracePeriods, [5000]);
  assert.deepEqual(report, {
    graceful: [{ name: 'api', pid: 801 }],
    forced: [{ name: 'api', pid: 801 }],
  });
});
