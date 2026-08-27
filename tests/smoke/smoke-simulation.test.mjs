import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function createSimulatedServer(overrides = {}) {
  let registeredUser = null;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname;
    const method = req.method;

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks).toString('utf8');
    let jsonBody = null;
    if (rawBody) {
      try {
        jsonBody = JSON.parse(rawBody);
      } catch {
        jsonBody = null;
      }
    }

    if (overrides.routeHandler) {
      const handled = overrides.routeHandler(req, res, { pathname, method, jsonBody });
      if (handled) return;
    }

    if (method === 'GET' && pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          dependencies: {
            database: 'up',
            redis: 'up',
          },
        }),
      );
      return;
    }

    if (method === 'GET' && pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!DOCTYPE html><html><body><h1 class="landing-title">wayfinder°</h1></body></html>');
      return;
    }

    if (method === 'GET' && pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (method === 'GET' && pathname === '/health/upstream') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', upstream: 'up' }));
      return;
    }

    if (method === 'GET' && pathname === '/api/health/agent') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (method === 'POST' && pathname === '/api/auth/register') {
      registeredUser = {
        id: 'usr_mock_uuid_123',
        email: jsonBody?.email,
      };
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          token: 'mock-valid-jwt-token-register-12345',
          user: registeredUser,
        }),
      );
      return;
    }

    if (method === 'POST' && pathname === '/api/auth/login') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          token: 'mock-valid-jwt-token-login-67890',
          user: registeredUser || { id: 'usr_mock_uuid_123', email: jsonBody?.email },
        }),
      );
      return;
    }

    if (method === 'GET' && pathname === '/api/auth/me') {
      const authHeader = req.headers['authorization'];
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: registeredUser?.id || 'usr_mock_uuid_123',
          email: registeredUser?.email || 'actor@example.com',
          role: 'USER',
        }),
      );
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  return server;
}

async function startServer(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('runs all 8 smoke checks successfully against healthy simulated endpoints', async (t) => {
  const server = createSimulatedServer();
  const { port, close } = await startServer(server);
  t.after(close);

  const env = {
    ...process.env,
    SMOKE_API_URL: `http://127.0.0.1:${port}/api`,
    SMOKE_WEB_URL: `http://127.0.0.1:${port}`,
    SMOKE_AGENT_URL: `http://127.0.0.1:${port}`,
  };
  delete env.NODE_TEST_CONTEXT;

  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ['--test', 'tests/smoke/smoke.test.mjs'],
    { env, cwd: process.cwd() },
  );

  assert.match(stdout, /API health and dependency shape/);
  assert.match(stdout, /Next\.js homepage HTML/);
  assert.match(stdout, /Agent health HTTP reachability/);
  assert.match(stdout, /PostgreSQL readiness/);
  assert.match(stdout, /Redis readiness/);
  assert.match(stdout, /Web upstream reachability/);
  assert.match(stdout, /API-to-Agent reachability/);
  assert.match(stdout, /Authentication round-trip/);
  assert.match(stdout, /pass 8/);
  assert.match(stdout, /fail 0/);
});

test('fails Check 4 (PostgreSQL readiness) when database dependency is down', async (t) => {
  const server = createSimulatedServer({
    routeHandler: (req, res, { method, pathname }) => {
      if (method === 'GET' && pathname === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'ok',
            dependencies: {
              database: 'down',
              redis: 'up',
            },
          }),
        );
        return true;
      }
      return false;
    },
  });
  const { port, close } = await startServer(server);
  t.after(close);

  const env = {
    ...process.env,
    SMOKE_API_URL: `http://127.0.0.1:${port}/api`,
    SMOKE_WEB_URL: `http://127.0.0.1:${port}`,
    SMOKE_AGENT_URL: `http://127.0.0.1:${port}`,
  };
  delete env.NODE_TEST_CONTEXT;

  let failed = false;
  try {
    await execFileAsync(process.execPath, ['--test', 'tests/smoke/smoke.test.mjs'], { env });
  } catch (err) {
    failed = true;
    assert.match(err.stdout, /PostgreSQL dependency must be "up"/);
  }
  assert.equal(failed, true, 'Smoke suite should fail when PostgreSQL is down');
});

test('fails Check 2 when homepage HTML lacks wayfinder marker', async (t) => {
  const server = createSimulatedServer({
    routeHandler: (req, res, { method, pathname }) => {
      if (method === 'GET' && pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><html><body><h1>Generic Title</h1></body></html>');
        return true;
      }
      return false;
    },
  });
  const { port, close } = await startServer(server);
  t.after(close);

  const env = {
    ...process.env,
    SMOKE_API_URL: `http://127.0.0.1:${port}/api`,
    SMOKE_WEB_URL: `http://127.0.0.1:${port}`,
    SMOKE_AGENT_URL: `http://127.0.0.1:${port}`,
  };
  delete env.NODE_TEST_CONTEXT;

  let failed = false;
  try {
    await execFileAsync(process.execPath, ['--test', 'tests/smoke/smoke.test.mjs'], { env });
  } catch (err) {
    failed = true;
    assert.match(err.stdout, /Homepage HTML must contain landing marker/);
  }
  assert.equal(failed, true, 'Smoke suite should fail when landing marker is missing');
});

test('preserves negative privacy (zero token/password leakage) on failure', async (t) => {
  let capturedPassword = null;
  const server = createSimulatedServer({
    routeHandler: (req, res, { method, pathname, jsonBody }) => {
      if (method === 'POST' && pathname === '/api/auth/register') {
        capturedPassword = jsonBody?.password;
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: `Registration failed with secret key sk_live_secretkey123 and password ${capturedPassword}`,
          }),
        );
        return true;
      }
      return false;
    },
  });
  const { port, close } = await startServer(server);
  t.after(close);

  const env = {
    ...process.env,
    SMOKE_API_URL: `http://127.0.0.1:${port}/api`,
    SMOKE_WEB_URL: `http://127.0.0.1:${port}`,
    SMOKE_AGENT_URL: `http://127.0.0.1:${port}`,
  };
  delete env.NODE_TEST_CONTEXT;

  let failed = false;
  try {
    await execFileAsync(process.execPath, ['--test', 'tests/smoke/smoke.test.mjs'], { env });
  } catch (err) {
    failed = true;
    assert.ok(capturedPassword, 'Captured password should be non-null');
    assert.ok(
      !err.stdout.includes(capturedPassword),
      'Failure output must not leak plaintext password',
    );
    assert.ok(
      !err.stdout.includes('sk_live_secretkey123'),
      'Failure output must not leak secret keys',
    );
    assert.ok(!err.stderr.includes(capturedPassword), 'Stderr must not leak plaintext password');
  }
  assert.equal(failed, true, 'Smoke suite should fail when registration returns 500');
});
