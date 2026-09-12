import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createTransport } from './dast-transport.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const composeFile = resolve(root, 'tests/security/compose.security.yml');
const origins = Object.freeze(['http://127.0.0.1:3301', 'http://127.0.0.1:3302', 'http://127.0.0.1:3400']);

export function createRunPlan({ profile = 'detector', maxRequests = 5000, maxDurationMs = 1800000 } = {}) {
  if (!['detector', 'quota-invariant'].includes(profile)) throw new Error('DAST_INVALID_PROFILE');
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 5000) throw new Error('DAST_INVALID_REQUEST_CAP');
  if (!Number.isInteger(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > 1800000) throw new Error('DAST_INVALID_TIME_CAP');
  return Object.freeze({
    project: `security-dast-${randomUUID().replaceAll('-', '')}`,
    profile, maxRequests, maxDurationMs, origins,
    environment: Object.freeze(profile === 'detector' ? { DAST_QUOTA_DAILY: '10000', DAST_QUOTA_BURST: '600' } : {}),
  });
}

// Only OS/Docker discovery variables cross this boundary. Never inherit .env,
// provider keys, proxy settings, NODE_OPTIONS or unit-test network guards.
export function dockerEnvironment(overrides = {}, source = process.env) {
  const env = {};
  for (const key of [
    'PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP',
    'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'DOCKER_CONFIG',
    'DOCKER_CONTEXT', 'DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH',
  ]) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return { ...env, ...overrides };
}

export function runDocker(args, { environment, signal, timeoutMs }) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn('docker', args, {
      cwd: root, env: dockerEnvironment(environment), shell: false,
      stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32',
    });
    let failure;
    let killer;
    const terminate = () => {
      failure = new Error('DAST_COMMAND_ABORTED');
      if (child.pid) {
        if (process.platform === 'win32') {
          killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.on('error', () => child.kill());
        } else {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        }
      }
    };
    const timer = setTimeout(terminate, timeoutMs);
    signal?.addEventListener('abort', terminate, { once: true });
    const finish = (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', terminate);
      if (error) reject(error); else resolveCommand();
    };
    child.once('error', () => finish(new Error('DAST_DOCKER_UNAVAILABLE')));
    child.once('close', (code) => finish(failure || (code === 0 ? undefined : new Error('DAST_COMMAND_FAILED'))));
    if (signal?.aborted) terminate();
  });
}

async function authenticateUsers(transport) {
  const users = [];
  for (const label of ['a', 'b']) {
    const email = `security-${label}@example.invalid`;
    const credentials = { email, password: 'Synthetic-Dast-Only-123!' };
    const options = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(credentials) };
    const registered = await transport.request(`${origins[0]}/api/auth/register`, options);
    if (registered.status !== 201) throw new Error('DAST_REGISTRATION_FAILED');
    const loggedIn = await transport.request(`${origins[0]}/api/auth/login`, options);
    if (loggedIn.status !== 200) throw new Error('DAST_AUTHENTICATION_FAILED');
    let token;
    try { token = JSON.parse(loggedIn.body).token; } catch { throw new Error('DAST_AUTHENTICATION_FAILED'); }
    if (typeof token !== 'string' || !token) throw new Error('DAST_AUTHENTICATION_FAILED');
    const me = await transport.request(`${origins[0]}/api/auth/me`, { headers: { authorization: `Bearer ${token}` } });
    let identity;
    try { identity = JSON.parse(me.body); } catch { throw new Error('DAST_IDENTITY_FAILED'); }
    if (me.status !== 200 || typeof identity.id !== 'string' || !identity.id || identity.email !== email) throw new Error('DAST_IDENTITY_FAILED');
    users.push({ id: identity.id, token });
  }
  if (users[0].id === users[1].id || users[0].token === users[1].token) throw new Error('DAST_IDENTITIES_NOT_DISTINCT');
  return users;
}

/** One suite owns one fresh Docker project; teardown removes only its volumes. */
export async function runLocalDast(options = {}, dependencies = {}) {
  if (!options.smoke) throw new Error('DAST_DRIVERS_NOT_IMPLEMENTED: T037-T041 required; use --smoke for lifecycle verification only');
  const plan = createRunPlan(options);
  const command = dependencies.command || runDocker;
  const transportFactory = dependencies.transportFactory || createTransport;
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(abort, plan.maxDurationMs);
  const started = Date.now();
  const transport = transportFactory({ origins: plan.origins, maxRequests: plan.maxRequests, maxDurationMs: plan.maxDurationMs, signal: controller.signal });
  const prefix = ['compose', '-f', composeFile, '-p', plan.project];
  let attempted = false;
  const execute = async (args, stage) => {
    if (controller.signal.aborted) throw new Error('DAST_DEADLINE_EXCEEDED');
    try {
      await command([...prefix, ...args], { environment: plan.environment, signal: controller.signal, timeoutMs: Math.max(1, plan.maxDurationMs - (Date.now() - started)) });
    } catch {
      throw new Error(`DAST_COMMAND_FAILED: ${stage}`);
    }
  };
  try {
    attempted = true;
    await execute(['up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '120', 'postgres_security', 'redis_security', 'mock_security'], 'infrastructure');
    await execute(['run', '--rm', '--no-deps', '--pull', 'never', 'migrate'], 'migrations');
    await execute(['up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '180', 'api_security', 'agent_security'], 'applications');
    for (const [origin, path] of [[origins[0], '/api/health/ping'], [origins[1], '/health'], [origins[2], '/health']]) {
      const response = await transport.request(`${origin}${path}`);
      if (response.status !== 200) throw new Error('DAST_READINESS_FAILED');
    }
    const users = await authenticateUsers(transport);
    if (controller.signal.aborted) throw new Error('DAST_DEADLINE_EXCEEDED');
    return { version: 1, kind: 'harness-smoke', securityEvaluation: false, profile: plan.profile, project: plan.project, authenticatedUsers: users.length, requests: transport.requests };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    transport.close();
    // Cleanup has its own bounded allowance so reaching the run deadline never
    // suppresses removal of owned containers and volumes.
    if (attempted) await command([...prefix, 'down', '-v', '--remove-orphans'], { environment: plan.environment, timeoutMs: 60000 });
  }
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node scripts/security/run-local-dast.mjs --profile detector|quota-invariant|full [--smoke]\n--smoke verifies isolated startup, migrations, two-user authentication and teardown only.\nfull --smoke runs both profiles with fresh state. Full DAST requires T037-T041 drivers.\nLimits: 5000 requests, 30 minutes per profile, local origins only. Prebuild with: docker compose -f tests/security/compose.security.yml build api_security agent_security');
    return;
  }
  let profile = 'detector';
  let smoke = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--smoke') smoke = true;
    else if (args[i] === '--profile' && args[i + 1]) profile = args[++i];
    else throw new Error('DAST_INVALID_ARGUMENT');
  }
  if (!['detector', 'quota-invariant', 'full'].includes(profile)) throw new Error('DAST_INVALID_PROFILE');
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    for (const current of profile === 'full' ? ['detector', 'quota-invariant'] : [profile]) {
      const result = await runLocalDast({ profile: current, smoke, signal: controller.signal });
      console.log(JSON.stringify(result));
    }
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message.startsWith('DAST_') ? error.message : 'DAST_HARNESS_FAILED');
    process.exitCode = 1;
  });
}
