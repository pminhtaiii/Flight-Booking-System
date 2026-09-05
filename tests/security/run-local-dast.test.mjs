import assert from 'node:assert/strict';
import test from 'node:test';

import { createRunPlan, dockerEnvironment, runLocalDast } from '../../scripts/security/run-local-dast.mjs';

test('Docker command environment preserves configured daemon discovery', () => {
  const configured = dockerEnvironment({}, {
    DOCKER_CONFIG: '/home/test/.docker',
    DOCKER_CONTEXT: 'rootless',
    DOCKER_HOST: 'unix:///run/user/1000/docker.sock',
    DOCKER_TLS_VERIFY: '1',
    DOCKER_CERT_PATH: '/home/test/.docker/certs',
  });
  assert.equal(configured.DOCKER_CONFIG, '/home/test/.docker');
  assert.equal(configured.DOCKER_CONTEXT, 'rootless');
  assert.equal(configured.DOCKER_HOST, 'unix:///run/user/1000/docker.sock');
  assert.equal(configured.DOCKER_TLS_VERIFY, '1');
  assert.equal(configured.DOCKER_CERT_PATH, '/home/test/.docker/certs');

  const discovered = dockerEnvironment({}, {});
  assert.equal(discovered.DOCKER_HOST, undefined);
});

test('run plan owns fresh disposable state and fixed loopback destinations', () => {
  const a = createRunPlan({ profile: 'detector' });
  const b = createRunPlan({ profile: 'quota-invariant' });
  assert.match(a.project, /^security-dast-[a-f0-9]{32}$/);
  assert.notEqual(a.project, b.project);
  assert.equal(a.environment.DAST_QUOTA_DAILY, '10000');
  assert.equal(a.environment.DAST_QUOTA_BURST, '600');
  assert.equal(b.environment.DAST_QUOTA_DAILY, undefined);
  assert.equal(b.environment.DAST_QUOTA_BURST, undefined);
  assert.deepEqual(a.origins, ['http://127.0.0.1:3301', 'http://127.0.0.1:3302', 'http://127.0.0.1:3400']);
  assert.equal(a.maxRequests, 5000);
  assert.equal(a.maxDurationMs, 1800000);
});

test('invalid profiles and inflated budgets fail before Docker starts', () => {
  for (const options of [{ profile: 'production' }, { maxRequests: 5001 }, { maxDurationMs: 1800001 }]) {
    assert.throws(() => createRunPlan(options));
  }
});

function fixture({ failCommand, badAuth = false } = {}) {
  const commands = [];
  let closed = false;
  let requests = 0;
  const users = new Map();
  return {
    commands,
    get closed() { return closed; },
    command: async (args, options) => {
      commands.push({ args, options });
      if (args.includes(failCommand)) throw new Error('synthetic command failure');
    },
    transportFactory: () => ({
      get requests() { return requests; },
      remainingMs: 1800000,
      close() { closed = true; },
      async request(url, options = {}) {
        requests++;
        if (url.endsWith('/register')) return { status: 201, body: '{}' };
        if (url.endsWith('/login')) {
          const { email } = JSON.parse(options.body);
          const token = `private-token-${users.size}`;
          users.set(token, { id: `id-${users.size}`, email });
          return { status: badAuth ? 401 : 200, body: JSON.stringify({ token }) };
        }
        if (url.endsWith('/me')) {
          return { status: 200, body: JSON.stringify(users.get(options.headers.authorization.slice(7))) };
        }
        return { status: 200, body: '{}' };
      },
    }),
  };
}

test('real lifecycle contract migrates before apps, authenticates distinct users, and cleans owned volumes', async () => {
  const f = fixture();
  const result = await runLocalDast({ profile: 'detector', smoke: true }, f);
  const args = f.commands.map((c) => c.args);
  assert.ok(args.findIndex((a) => a.includes('migrate')) < args.findIndex((a) => a.includes('api_security')));
  assert.deepEqual(args.at(-1).slice(-3), ['down', '-v', '--remove-orphans']);
  assert.equal(new Set(args.map((a) => a[a.indexOf('-p') + 1])).size, 1);
  assert.equal(result.authenticatedUsers, 2);
  assert.equal(result.requests, 9);
  assert.equal(result.kind, 'harness-smoke');
  assert.equal(result.securityEvaluation, false);
  assert.equal(f.closed, true);
  assert.doesNotMatch(JSON.stringify(result), /private-token|password|@example/);
});

test('partial startup and authentication failure always tear down the owned project', async () => {
  for (const options of [{ failCommand: 'migrate' }, { badAuth: true }]) {
    const f = fixture(options);
    await assert.rejects(runLocalDast({ smoke: true }, f));
    assert.deepEqual(f.commands.at(-1).args.slice(-3), ['down', '-v', '--remove-orphans']);
    assert.equal(f.closed, true);
  }
});

test('missing runtime suites cannot be reported as completed DAST', async () => {
  const f = fixture();
  await assert.rejects(runLocalDast({ profile: 'full' }, f), /DAST_DRIVERS_NOT_IMPLEMENTED/);
  assert.equal(f.commands.length, 0);
});

test('cancellation during startup stops work and still performs cleanup without the aborted signal', async () => {
  const f = fixture();
  const controller = new AbortController();
  const command = async (args, options) => {
    await f.command(args, options);
    if (args.includes('migrate')) controller.abort();
  };
  await assert.rejects(runLocalDast({ smoke: true, signal: controller.signal }, { ...f, command }), /DEADLINE/);
  assert.equal(f.commands.some(({ args }) => args.includes('api_security')), false);
  assert.equal(f.commands.at(-1).options.signal, undefined);
  assert.equal(f.commands.at(-1).options.timeoutMs, 60000);
  assert.equal(f.closed, true);
});

test('repeated suites and profiles recreate volumes under distinct project names', async () => {
  const f = fixture();
  const first = await runLocalDast({ smoke: true, profile: 'detector' }, f);
  const second = await runLocalDast({ smoke: true, profile: 'quota-invariant' }, f);
  assert.notEqual(first.project, second.project);
  assert.equal(f.commands.filter(({ args }) => args.includes('down')).length, 2);
  const migrationRuns = f.commands.filter(({ args }) => args.includes('migrate'));
  assert.equal(migrationRuns.length, 2);
  assert.deepEqual(migrationRuns[1].options.environment, {});
});

test('a failed teardown makes the run fail even when all probes passed', async () => {
  const f = fixture({ failCommand: 'down' });
  await assert.rejects(runLocalDast({ smoke: true }, f));
  assert.equal(f.closed, true);
});
