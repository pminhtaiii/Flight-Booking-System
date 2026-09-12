import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
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

  // Verify header-based session management with bearer token injection
  assert.match(raw, /method:\s*["']?headers["']?/);
  assert.match(raw, /Authorization:\s*["']?Bearer\s+.*token.*["']?/);
});

test('T037.1: automation.yaml defines required job pipeline: passiveScan, spider, activeScan, report', () => {
  const raw = readFileSync(automationPath, 'utf8');

  // 1. passiveScan-config with LOW alert threshold
  assert.match(raw, /type:\s*["']?passiveScan-config["']?/);
  assert.match(raw, /alertThreshold:\s*["']?LOW["']?/);

  // 2. spider on web service with authenticated UserA
  assert.match(raw, /type:\s*["']?spider["']?/);
  assert.match(raw, /user:\s*["']?UserA["']?/);
  assert.match(raw, /maxDuration:\s*5/);

  // 3. passiveScan-wait
  assert.match(raw, /type:\s*["']?passiveScan-wait["']?/);

  // 4. activeScan with StrictLocalBounded policy, authenticated UserA, and rules
  assert.match(raw, /type:\s*["']?activeScan["']?/);
  assert.match(raw, /user:\s*["']?UserA["']?/);
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

test('Issue 2: automation.yaml synthetic tokens are valid HMAC-SHA256 signed JWTs', () => {
  const raw = readFileSync(automationPath, 'utf8');

  // Extract tokens from automation.yaml
  const userATokenMatch = raw.match(/name:\s*["']?UserA["']?[\s\S]*?token:\s*["']?([^"'\s]+)["']?/);
  const userBTokenMatch = raw.match(/name:\s*["']?UserB["']?[\s\S]*?token:\s*["']?([^"'\s]+)["']?/);

  assert.ok(userATokenMatch && userATokenMatch[1], 'Must extract UserA token');
  assert.ok(userBTokenMatch && userBTokenMatch[1], 'Must extract UserB token');

  const tokenA = userATokenMatch[1];
  const tokenB = userBTokenMatch[1];
  const secret = 'security-synthetic-jwt-secret-only';

  function verifyHmacJwt(token) {
    const parts = token.split('.');
    assert.equal(parts.length, 3, 'JWT must have 3 parts: header.payload.signature');
    const [headerB64, payloadB64, signature] = parts;

    const expectedSig = crypto
      .createHmac('sha256', secret)
      .update(`${headerB64}.${payloadB64}`)
      .digest('base64url');
    assert.equal(signature, expectedSig, 'HMAC-SHA256 signature must be valid');

    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    assert.equal(header.alg, 'HS256');
    assert.equal(header.typ, 'JWT');

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    return payload;
  }

  const payloadA = verifyHmacJwt(tokenA);
  assert.equal(payloadA.id, 'usr_security_a');
  assert.equal(payloadA.email, 'security-a@example.invalid');
  assert.equal(payloadA.role, 'USER');
  assert.equal(payloadA.iss, 'booking-systems-api');
  assert.equal(payloadA.aud, 'booking-systems-clients');
  assert.equal(payloadA.jti, 'jti-security-a');

  const payloadB = verifyHmacJwt(tokenB);
  assert.equal(payloadB.id, 'usr_security_b');
  assert.equal(payloadB.email, 'security-b@example.invalid');
  assert.equal(payloadB.role, 'USER');
  assert.equal(payloadB.iss, 'booking-systems-api');
  assert.equal(payloadB.aud, 'booking-systems-clients');
  assert.equal(payloadB.jti, 'jti-security-b');
});

test('Issue 3: automation.yaml imports openapi.json before activeScan and exercises UserB', () => {
  const raw = readFileSync(automationPath, 'utf8');

  // Verify openapi job exists
  assert.match(raw, /type:\s*["']?openapi["']?/);
  assert.match(raw, /apiFile:\s*["']?\/zap\/wrk\/openapi\.json["']?/);
  assert.match(raw, /targetUrl:\s*["']?http:\/\/127\.0\.0\.1:3001["']?/);

  // Verify openapi job appears before activeScan job
  const openapiIdx = raw.indexOf('type: "openapi"');
  const activeScanIdx = raw.indexOf('type: "activeScan"');
  assert.ok(openapiIdx !== -1, 'openapi job must be declared');
  assert.ok(activeScanIdx !== -1, 'activeScan job must be declared');
  assert.ok(openapiIdx < activeScanIdx, 'openapi job must precede activeScan job');

  // Verify activeScan job for UserB exists as well as UserA
  const userAMatches = raw.match(/user:\s*["']?UserA["']?/g) || [];
  const userBMatches = raw.match(/user:\s*["']?UserB["']?/g) || [];
  assert.ok(userAMatches.length >= 2, 'UserA must be referenced in spider/openapi and activeScan');
  assert.ok(userBMatches.length >= 1, 'UserB must be referenced in activeScan');
});

test('Issue 3: openapi.json exists, is valid OpenAPI 3.0.3, and covers all 45 routes', () => {
  const openapiPath = resolve(repoRoot, 'tests/security/zap/openapi.json');
  assert.ok(existsSync(openapiPath), `openapi.json must exist at ${openapiPath}`);

  const raw = readFileSync(openapiPath, 'utf8');
  assert.ok(raw.trim().length > 0, 'openapi.json must not be empty');

  const doc = JSON.parse(raw);
  assert.equal(doc.openapi, '3.0.3', 'openapi version must be 3.0.3');
  assert.ok(doc.info?.title, 'info.title must exist');
  assert.ok(Array.isArray(doc.servers), 'servers must be an array');

  // Verify required server ports: 3000, 3001, 3002, 3301, 3302, 3400
  const serverUrls = doc.servers.map((s) => s.url);
  const requiredPorts = [3000, 3001, 3002, 3301, 3302, 3400];
  for (const port of requiredPorts) {
    const hasPort = serverUrls.some((u) => u.includes(`:${port}`));
    assert.ok(hasPort, `Servers must include port ${port}`);
  }

  // Verify security schemes
  const schemes = doc.components?.securitySchemes;
  assert.ok(schemes, 'components.securitySchemes must exist');
  assert.ok(schemes.bearerAuth, 'bearerAuth scheme must exist');
  assert.equal(schemes.bearerAuth.type, 'http');
  assert.equal(schemes.bearerAuth.scheme, 'bearer');
  assert.equal(schemes.bearerAuth.bearerFormat, 'JWT');

  assert.ok(schemes.agentApiKey, 'agentApiKey scheme must exist');
  assert.equal(schemes.agentApiKey.type, 'apiKey');
  assert.equal(schemes.agentApiKey.name, 'AGENT_SERVICE_API_KEY');

  assert.ok(schemes.claimToken, 'claimToken scheme must exist');
  assert.equal(schemes.claimToken.type, 'apiKey');
  assert.equal(schemes.claimToken.name, 'CLAIM_TOKEN');

  assert.ok(schemes.adminBearer, 'adminBearer scheme must exist');
  assert.equal(schemes.adminBearer.type, 'http');
  assert.equal(schemes.adminBearer.scheme, 'bearer');

  // Verify all 45 routes from routes.json are accounted for
  const routesData = JSON.parse(readFileSync(routesPath, 'utf8'));
  const routes = Array.isArray(routesData) ? routesData : routesData.routes;
  assert.equal(routes.length, 45, 'routes.json must contain all 45 routes');

  for (const r of routes) {
    const openApiPath = r.path.replace(/:([a-zA-Z0-9_]+)/g, (_, p1) => `{${p1}}`);
    const method = r.method.toLowerCase();

    assert.ok(
      doc.paths[openApiPath],
      `Path ${openApiPath} for route ${r.id} (${r.path}) must exist in openapi.json`,
    );

    const operation = doc.paths[openApiPath][method];
    assert.ok(
      operation,
      `Operation ${method.toUpperCase()} ${openApiPath} for route ${r.id} must exist in openapi.json`,
    );

    // Verify path params
    if (r.params?.path) {
      for (const paramName of r.params.path) {
        assert.ok(
          operation.parameters.some((p) => p.name === paramName && p.in === 'path'),
          `Path parameter ${paramName} missing for ${r.id}`,
        );
      }
    }

    // Verify query params
    if (r.params?.query) {
      for (const paramName of r.params.query) {
        assert.ok(
          operation.parameters.some((p) => p.name === paramName && p.in === 'query'),
          `Query parameter ${paramName} missing for ${r.id}`,
        );
      }
    }

    // Verify requestBody
    if (r.requestBody) {
      assert.ok(operation.requestBody, `requestBody missing for ${r.id}`);
      assert.ok(operation.requestBody.content?.['application/json'], `JSON content missing for ${r.id}`);
      assert.ok(
        operation.requestBody.content['application/json'].schema,
        `schema missing in requestBody for ${r.id}`,
      );
    }

    // Verify security
    if (r.authRequirement === 'bearer_user') {
      const hasBearer = operation.security.some((s) => 'bearerAuth' in s);
      assert.ok(hasBearer, `bearerAuth missing in security for ${r.id}`);
    } else if (r.authRequirement === 'agent_key_claim') {
      const hasAgentKey = operation.security.some((s) => 'agentApiKey' in s);
      assert.ok(hasAgentKey, `agentApiKey missing in security for ${r.id}`);
    } else if (r.authRequirement === 'admin_bearer') {
      const hasAdmin = operation.security.some((s) => 'adminBearer' in s);
      assert.ok(hasAdmin, `adminBearer missing in security for ${r.id}`);
    }
  }
});
