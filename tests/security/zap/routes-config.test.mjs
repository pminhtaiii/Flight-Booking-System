import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..', '..', '..');

const routesPath = resolve(repoRoot, 'tests/security/zap/routes.json');
const automationPath = resolve(repoRoot, 'tests/security/zap/automation.yaml');

test('T037.1: routes.json exists, is non-empty, and parses as valid JSON', () => {
  assert.ok(existsSync(routesPath), `routes.json must exist at ${routesPath}`);
  const raw = readFileSync(routesPath, 'utf8');
  assert.ok(raw.trim().length > 0, 'routes.json must not be empty');

  const data = JSON.parse(raw);
  assert.equal(typeof data, 'object');
  assert.ok(data !== null);

  const routes = Array.isArray(data) ? data : data.routes;
  assert.ok(Array.isArray(routes), 'routes must be an array');
  assert.ok(routes.length >= 40, `Expected at least 40 routes, found ${routes.length}`);
});

test('T037.1: routes.json conforms to schema with required fields and types', () => {
  const data = JSON.parse(readFileSync(routesPath, 'utf8'));
  const routes = Array.isArray(data) ? data : data.routes;

  const validMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
  const validServices = new Set(['web', 'api', 'agent']);
  const validPorts = new Set([3000, 3001, 3002]);
  const validAuthRequirements = new Set(['none', 'bearer_user', 'agent_key_claim', 'admin_bearer']);
  const validSensitivities = new Set(['low', 'medium', 'high', 'critical']);

  const seenIds = new Set();

  for (const route of routes) {
    // Required fields check
    const requiredFields = [
      'id',
      'method',
      'path',
      'service',
      'targetPort',
      'authRequirement',
      'params',
      'requestBody',
      'description',
      'sensitivity',
    ];
    for (const field of requiredFields) {
      assert.ok(field in route, `Route ${route.id || route.path} missing required field '${field}'`);
    }

    // Unique ID
    assert.ok(!seenIds.has(route.id), `Duplicate route ID: ${route.id}`);
    seenIds.add(route.id);

    // Method
    assert.ok(validMethods.has(route.method), `Invalid HTTP method '${route.method}' in ${route.id}`);

    // Path
    assert.ok(typeof route.path === 'string' && route.path.startsWith('/'), `Invalid path in ${route.id}`);

    // Service & Port mapping
    assert.ok(validServices.has(route.service), `Invalid service '${route.service}' in ${route.id}`);
    assert.ok(validPorts.has(route.targetPort), `Invalid targetPort '${route.targetPort}' in ${route.id}`);
    if (route.service === 'web') assert.equal(route.targetPort, 3000);
    if (route.service === 'api') assert.equal(route.targetPort, 3001);
    if (route.service === 'agent') assert.equal(route.targetPort, 3002);

    // Auth requirement
    assert.ok(
      validAuthRequirements.has(route.authRequirement),
      `Invalid authRequirement '${route.authRequirement}' in ${route.id}`,
    );

    // Sensitivity
    assert.ok(
      validSensitivities.has(route.sensitivity),
      `Invalid sensitivity '${route.sensitivity}' in ${route.id}`,
    );

    // Description
    assert.ok(
      typeof route.description === 'string' && route.description.trim().length > 0,
      `Empty description in ${route.id}`,
    );
  }
});

test('T037.1: routes.json covers all required Section 2 inventory routes', () => {
  const data = JSON.parse(readFileSync(routesPath, 'utf8'));
  const routes = Array.isArray(data) ? data : data.routes;

  const findRoutes = (path, method, authRequirement) =>
    routes.filter(
      (r) =>
        r.path === path &&
        (!method || r.method === method) &&
        (!authRequirement || r.authRequirement === authRequirement),
    );

  // 1. Unauthenticated routes
  const requiredUnauth = [
    { path: '/', method: 'GET' },
    { path: '/login', method: 'GET' },
    { path: '/register', method: 'GET' },
    { path: '/api/auth/register', method: 'POST' },
    { path: '/api/auth/login', method: 'POST' },
    { path: '/health', method: 'GET' },
    { path: '/health/live', method: 'GET' },
    { path: '/airports/search', method: 'GET' },
    { path: '/airports/nearby', method: 'GET' },
  ];
  for (const { path, method } of requiredUnauth) {
    const matches = findRoutes(path, method, 'none');
    assert.ok(matches.length >= 1, `Missing unauthenticated route ${method} ${path}`);
  }

  // 2. User Authenticated (bearer_user)
  const requiredBearerUser = [
    { path: '/api/auth/me', method: 'GET' },
    { path: '/api/auth/logout', method: 'POST' },
    { path: '/flights/search', method: 'POST' },
    { path: '/flights/:id', method: 'GET' },
    { path: '/bookings', method: 'GET' },
    { path: '/bookings/:id', method: 'GET' },
    { path: '/bookings/:id/cancel', method: 'POST' },
    { path: '/bookings/handoffs/resolve', method: 'POST' },
    { path: '/bookings/intent', method: 'POST' },
    { path: '/bookings/intent/:id', method: 'GET' },
    { path: '/bookings/intent/:intentId/ancillaries', method: 'GET' },
    { path: '/bookings/intent/:intentId/ancillaries', method: 'PUT' },
    { path: '/bookings/payment/create', method: 'POST' },
    { path: '/bookings/payment/confirm', method: 'POST' },
    { path: '/profile', method: 'GET' },
    { path: '/disruptions', method: 'GET' },
    { path: '/dashboard/summary', method: 'GET' },
  ];
  for (const { path, method } of requiredBearerUser) {
    const matches = findRoutes(path, method, 'bearer_user');
    assert.ok(matches.length >= 1, `Missing user authenticated route ${method} ${path}`);
  }

  // 3. Agent Attested (agent_key_claim)
  const requiredAgentAttested = [
    { path: '/agent-gateway/flights/search', method: 'GET' },
    { path: '/agent-gateway/v2/flights/search', method: 'POST' },
    { path: '/agent-gateway/users/bookings', method: 'GET' },
    { path: '/agent-gateway/users/bookings/summaries', method: 'GET' },
    { path: '/agent-gateway/users/bookings/:bookingReference', method: 'GET' },
    { path: '/agent-gateway/bookings/readiness', method: 'POST' },
    { path: '/agent-gateway/users/preferences', method: 'GET' },
  ];
  for (const { path, method } of requiredAgentAttested) {
    const matches = findRoutes(path, method, 'agent_key_claim');
    assert.ok(matches.length >= 1, `Missing agent attested route ${method} ${path}`);
  }

  // 4. Admin (admin_bearer)
  const requiredAdmin = [
    { path: '/admin/profile/backfill', method: 'POST' },
    { path: '/admin/refunds/:refundId/resolve', method: 'POST' },
  ];
  for (const { path, method } of requiredAdmin) {
    const matches = findRoutes(path, method, 'admin_bearer');
    assert.ok(matches.length >= 1, `Missing admin route ${method} ${path}`);
  }

  // 5. Agent chat stream
  const chatStreamMatches = findRoutes('/chat/stream', 'POST');
  assert.ok(chatStreamMatches.length >= 1, 'Missing /chat/stream route');
  const chatStream = chatStreamMatches[0];
  assert.equal(chatStream.service, 'agent');
  assert.equal(chatStream.targetPort, 3002);
  assert.equal(chatStream.authRequirement, 'bearer_user');
  assert.equal(chatStream.additionalAuth, 'agent_key_claim');
});

test('T037.1: automation.yaml exists, is non-empty, and contains valid YAML syntax', () => {
  assert.ok(existsSync(automationPath), `automation.yaml must exist at ${automationPath}`);
  const raw = readFileSync(automationPath, 'utf8');
  assert.ok(raw.trim().length > 0, 'automation.yaml must not be empty');

  // Verify YAML syntax via python's yaml parser
  const pyCheck = spawnSync(
    'python',
    ['-c', 'import yaml, sys; data = yaml.safe_load(sys.stdin.read()); assert data is not None; print("VALID_YAML")'],
    { input: raw, encoding: 'utf8' },
  );
  assert.equal(pyCheck.status, 0, `YAML parse error: ${pyCheck.stderr}`);
  assert.match(pyCheck.stdout, /VALID_YAML/);
});

test('T037.1: automation.yaml declares strict local loopback contexts and synthetic users', () => {
  const raw = readFileSync(automationPath, 'utf8');

  // Verify context definition
  assert.match(raw, /name:\s*["']?BookingSystems-Local["']?/);
  assert.match(raw, /http:\/\/127\.0\.0\.1:3000/);
  assert.match(raw, /http:\/\/127\.0\.0\.1:3001/);
  assert.match(raw, /http:\/\/127\.0\.0\.1:3002/);

  // Verify include paths
  assert.match(raw, /http:\/\/127\.0\.0\.1:3000\/\.\*/);
  assert.match(raw, /http:\/\/127\.0\.0\.1:3001\/\.\*/);
  assert.match(raw, /http:\/\/127\.0\.0\.1:3002\/\.\*/);

  // Verify strict exclude path locking to loopback
  assert.match(raw, /\^\(\?!http:\/\/127\\\\\.0\\\\\.0\\\\\.1:\(3000\|3001\|3002\)\)\.\*/);

  // Verify synthetic users User A and User B
  assert.match(raw, /security-a@example\.invalid/);
  assert.match(raw, /security-b@example\.invalid/);
  assert.match(raw, /User A/);
  assert.match(raw, /User B/);
});

test('T037.1: automation.yaml defines required job pipeline: passiveScan, spider, activeScan, report', () => {
  const raw = readFileSync(automationPath, 'utf8');

  // 1. passiveScan-config with LOW alert threshold
  assert.match(raw, /type:\s*["']?passiveScan-config["']?/);
  assert.match(raw, /alertThreshold:\s*["']?LOW["']?/);

  // 2. spider on web service
  assert.match(raw, /type:\s*["']?spider["']?/);
  assert.match(raw, /maxDuration:\s*5/);

  // 3. passiveScan-wait
  assert.match(raw, /type:\s*["']?passiveScan-wait["']?/);

  // 4. activeScan with StrictLocalBounded policy and rules
  assert.match(raw, /type:\s*["']?activeScan["']?/);
  assert.match(raw, /policy:\s*["']?StrictLocalBounded["']?/);
  assert.match(raw, /maxRuleDurationInMins:\s*2/);
  assert.match(raw, /maxScanDurationInMins:\s*10/);

  // Required targeted rule families
  assert.match(raw, /SQL Injection/);
  assert.match(raw, /Cross Site Scripting/);
  assert.match(raw, /Anti-CSRF Tokens/);
  assert.match(raw, /Path Traversal/);
  assert.match(raw, /Content Security Policy/);

  // 5. Raw JSON and SARIF reports output to /zap/wrk
  assert.match(raw, /zap-raw-report\.json/);
  assert.match(raw, /zap-raw-report\.sarif/);
  assert.match(raw, /\/zap\/wrk/);
});
