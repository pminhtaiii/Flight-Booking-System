import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildZapDockerArgs,
  evaluateZapReport,
  runZap,
  SUPPORTED_ZAP_JOB_TYPES,
  validateConfigFileScope,
  validateRedirectScope,
  validateScope,
} from '../../scripts/security/run-zap.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..', '..');
const toolchainPath = resolve(repoRoot, 'tests/security/toolchain.json');
const runZapCli = resolve(repoRoot, 'scripts/security/run-zap.mjs');

// -----------------------------------------------------------------------------
// Suite 1: validateScope(targets)
// -----------------------------------------------------------------------------
test('validateScope: accepts valid loopback addresses on allowed ports (3000, 3001, 3002, 3301, 3302, 3400)', () => {
  // Local dev server ports
  assert.equal(validateScope('http://127.0.0.1:3000'), true);
  assert.equal(validateScope('http://127.0.0.1:3001'), true);
  assert.equal(validateScope('http://127.0.0.1:3002'), true);
  assert.equal(validateScope('http://localhost:3000'), true);
  assert.equal(validateScope('http://localhost:3001'), true);
  assert.equal(validateScope('http://localhost:3002'), true);

  // T007 security compose stack ports (3301 api, 3302 agent, 3400 web)
  assert.equal(validateScope('http://127.0.0.1:3301'), true);
  assert.equal(validateScope('http://127.0.0.1:3302'), true);
  assert.equal(validateScope('http://127.0.0.1:3400'), true);
  assert.equal(validateScope('http://localhost:3301'), true);
  assert.equal(validateScope('http://localhost:3302'), true);
  assert.equal(validateScope('http://localhost:3400'), true);

  // Container loopback resolution host alias
  assert.equal(validateScope('http://host.docker.internal:3000'), true);
  assert.equal(validateScope('http://host.docker.internal:3301'), true);
  assert.equal(validateScope('http://host.docker.internal:3400'), true);

  // Array of valid targets
  assert.equal(
    validateScope([
      'http://127.0.0.1:3000',
      'http://127.0.0.1:3001',
      'http://127.0.0.1:3002',
      'http://127.0.0.1:3301',
      'http://127.0.0.1:3302',
      'http://127.0.0.1:3400',
    ]),
    true,
  );
  assert.equal(validateScope(['http://localhost:3400', 'http://127.0.0.1:3301']), true);
});

test('validateScope: rejects external addresses', () => {
  assert.equal(validateScope('http://example.com'), false);
  assert.equal(validateScope('http://192.168.1.1'), false);
  assert.equal(validateScope('https://google.com'), false);
  assert.equal(validateScope('http://10.0.0.1:3000'), false);
  assert.equal(validateScope('http://attacker.local:3000'), false);

  // Array containing at least one external address
  assert.equal(
    validateScope(['http://127.0.0.1:3000', 'http://example.com']),
    false,
  );
  assert.equal(
    validateScope(['http://127.0.0.1:3000', 'http://192.168.1.1:3001']),
    false,
  );
});

test('validateScope: rejects unallowed ports on loopback', () => {
  assert.equal(validateScope('http://127.0.0.1:8080'), false);
  assert.equal(validateScope('http://localhost:8080'), false);
  assert.equal(validateScope('http://127.0.0.1:80'), false);
  assert.equal(validateScope('http://127.0.0.1:443'), false);
  assert.equal(validateScope('http://127.0.0.1:5432'), false);
  assert.equal(validateScope('http://127.0.0.1'), false); // default port 80 not allowed
});

test('validateScope: rejects malformed, non-string, or empty targets', () => {
  assert.equal(validateScope(''), false);
  assert.equal(validateScope(null), false);
  assert.equal(validateScope(undefined), false);
  assert.equal(validateScope(123), false);
  assert.equal(validateScope('not-a-valid-url'), false);
  assert.equal(validateScope([]), false);
});

// -----------------------------------------------------------------------------
// Suite 1b: validateRedirectScope(redirectTarget, baseUrl)
// -----------------------------------------------------------------------------
test('validateRedirectScope: accepts valid redirect destinations within allowed loopback scope', () => {
  // Absolute URLs on allowed ports
  assert.equal(validateRedirectScope('http://127.0.0.1:3000/dashboard'), true);
  assert.equal(validateRedirectScope('http://127.0.0.1:3301/api/health'), true);
  assert.equal(validateRedirectScope('http://127.0.0.1:3400/login'), true);
  assert.equal(validateRedirectScope('http://localhost:3002/chat'), true);

  // Relative paths resolved against valid base URL
  assert.equal(validateRedirectScope('/api/auth/me', 'http://127.0.0.1:3001'), true);
  assert.equal(validateRedirectScope('/flights/search', 'http://127.0.0.1:3400'), true);
  assert.equal(validateRedirectScope('relative/path', 'http://127.0.0.1:3000'), true);

  // Relative path defaulting to loopback port 3000
  assert.equal(validateRedirectScope('/dashboard'), true);
});

test('validateRedirectScope: rejects out-of-scope or external redirect destinations', () => {
  // External destinations
  assert.equal(validateRedirectScope('http://evil.com/phish'), false);
  assert.equal(validateRedirectScope('https://google.com'), false);
  assert.equal(validateRedirectScope('//attacker.com/steal'), false);

  // Unallowed loopback ports
  assert.equal(validateRedirectScope('http://127.0.0.1:8080/admin'), false);
  assert.equal(validateRedirectScope('http://localhost:9000'), false);

  // Out-of-scope base URL with relative path
  assert.equal(validateRedirectScope('/profile', 'http://evil.com'), false);
  assert.equal(validateRedirectScope('/profile', 'http://127.0.0.1:8080'), false);

  // Invalid protocols or inputs
  assert.equal(validateRedirectScope('javascript:alert(1)'), false);
  assert.equal(validateRedirectScope(''), false);
  assert.equal(validateRedirectScope(null), false);
  assert.equal(validateRedirectScope(undefined), false);
});

// -----------------------------------------------------------------------------
// Suite 2: buildZapDockerArgs(options)
// -----------------------------------------------------------------------------
test('buildZapDockerArgs: reads pinned image/digest from toolchain.json and generates docker run args', () => {
  const toolchain = JSON.parse(readFileSync(toolchainPath, 'utf8'));
  const expectedPinnedImage = toolchain.scanners.zap.pinnedImage;

  assert.ok(expectedPinnedImage, 'toolchain.json must define scanners.zap.pinnedImage');

  const args = buildZapDockerArgs({ toolchainPath });

  assert.ok(Array.isArray(args), 'buildZapDockerArgs must return an array of arguments');
  assert.ok(args.includes('run'), 'args must include "run"');
  assert.ok(args.includes('--rm'), 'args must include "--rm"');
  assert.ok(args.includes('-t'), 'args must include "-t"');
  assert.ok(
    args.includes(expectedPinnedImage),
    `args must include pinned image: ${expectedPinnedImage}`,
  );

  // Check volume mount contains /zap/wrk/:rw
  const mountIdx = args.indexOf('-v');
  assert.ok(mountIdx !== -1, 'args must include volume mount (-v)');
  const mountArg = args[mountIdx + 1];
  assert.ok(
    mountArg && mountArg.includes('/zap/wrk/:rw'),
    `Volume mount must map to /zap/wrk/:rw, got: ${mountArg}`,
  );

  // Check zap command and autorun flag
  assert.ok(args.includes('zap.sh'), 'args must invoke "zap.sh"');
  assert.ok(args.includes('-autorun'), 'args must include "-autorun"');
  assert.ok(
    args.some((arg) => arg.includes('automation.yaml')),
    'args must specify automation.yaml config file',
  );
});

test('buildZapDockerArgs: supports custom zapDir and user options', () => {
  const customDir = resolve(tmpdir(), 'custom-zap-dir');
  const args = buildZapDockerArgs({
    zapDir: customDir,
    user: '1000:1000',
    toolchainPath,
  });

  const mountIdx = args.indexOf('-v');
  assert.ok(mountIdx !== -1);
  assert.ok(
    args[mountIdx + 1].startsWith(customDir),
    `Volume mount should use customDir: ${customDir}`,
  );

  const userIdx = args.indexOf('--user');
  assert.ok(userIdx !== -1, 'args must include --user when specified');
  assert.equal(args[userIdx + 1], '1000:1000');
});

test('buildZapDockerArgs: defaults network to host and includes add-host for host.docker.internal', () => {
  const args = buildZapDockerArgs({ toolchainPath });
  const netIdx = args.indexOf('--network');
  assert.ok(netIdx !== -1, 'args must include --network');
  assert.equal(args[netIdx + 1], 'host', '--network must default to host');

  const hostIdx = args.indexOf('--add-host');
  assert.ok(hostIdx !== -1, 'args must include --add-host');
  assert.equal(args[hostIdx + 1], 'host.docker.internal:host-gateway');
});

test('buildZapDockerArgs: allows network override and validates target ports', () => {
  const customNetArgs = buildZapDockerArgs({ network: 'bridge', toolchainPath });
  const netIdx = customNetArgs.indexOf('--network');
  assert.ok(netIdx !== -1);
  assert.equal(customNetArgs[netIdx + 1], 'bridge');

  // Valid target ports across dev (3000-3002) and compose (3301, 3302, 3400)
  const validPortsArgs = buildZapDockerArgs({
    targetPorts: [3000, 3001, 3002, 3301, 3302, 3400],
    toolchainPath,
  });
  assert.ok(Array.isArray(validPortsArgs));

  // Invalid target port throws error
  assert.throws(() => {
    buildZapDockerArgs({ targetPorts: [8080], toolchainPath });
  }, /not an allowed dev or compose port/i);
});

// -----------------------------------------------------------------------------
// Suite 3: evaluateZapReport(rawReportPathOrObject)
// -----------------------------------------------------------------------------
test('evaluateZapReport: returns exitCode 0 when 0 High/Critical alerts exist', () => {
  const cleanReport = {
    site: [
      {
        '@name': 'http://127.0.0.1:3000',
        alerts: [
          {
            pluginid: '10038',
            alertRef: '10038',
            alert: 'Content Security Policy (CSP) Header Not Set',
            riskcode: '2', // Medium
            riskdesc: 'Medium (High)',
            desc: 'CSP header missing',
            uri: 'http://127.0.0.1:3000/',
          },
          {
            pluginid: '10021',
            alertRef: '10021',
            alert: 'X-Content-Type-Options Header Missing',
            riskcode: '1', // Low
            riskdesc: 'Low (Medium)',
            desc: 'X-Content-Type-Options header missing',
            uri: 'http://127.0.0.1:3000/',
          },
          {
            pluginid: '10049',
            alertRef: '10049',
            alert: 'Stale Cookie',
            riskcode: '0', // Informational
            riskdesc: 'Informational (Low)',
            desc: 'Informational finding',
            uri: 'http://127.0.0.1:3000/',
          },
        ],
      },
    ],
  };

  const result = evaluateZapReport(cleanReport);

  assert.equal(result.exitCode, 0, 'Clean scan must return exitCode 0');
  assert.equal(result.criticalCount, 0);
  assert.equal(result.highCount, 0);
  assert.equal(result.mediumCount, 1);
  assert.equal(result.lowCount, 1);
  assert.equal(result.infoCount, 1);
  assert.equal(result.findings.length, 3);
});

test('evaluateZapReport: returns exitCode 1 when 1 or more High or Critical alerts exist', () => {
  const highReport = {
    site: [
      {
        '@name': 'http://127.0.0.1:3001',
        alerts: [
          {
            pluginid: '40018',
            alertRef: '40018',
            alert: 'SQL Injection - Hypersonic SQL',
            riskcode: '3', // High
            riskdesc: 'High (High)',
            desc: 'SQL injection detected',
            uri: 'http://127.0.0.1:3001/api/auth/login',
          },
        ],
      },
    ],
  };

  const resultHigh = evaluateZapReport(highReport);
  assert.equal(resultHigh.exitCode, 1, 'High alert must return exitCode 1');
  assert.equal(resultHigh.highCount, 1);
  assert.equal(resultHigh.criticalCount, 0);

  const critReport = {
    site: [
      {
        '@name': 'http://127.0.0.1:3002',
        alerts: [
          {
            pluginid: '99999',
            alertRef: '99999',
            alert: 'Remote Code Execution',
            riskcode: '4', // Critical
            riskdesc: 'Critical (High)',
            desc: 'RCE vulnerability detected',
            uri: 'http://127.0.0.1:3002/chat/stream',
          },
        ],
      },
    ],
  };

  const resultCrit = evaluateZapReport(critReport);
  assert.equal(resultCrit.exitCode, 1, 'Critical alert must return exitCode 1');
  assert.equal(resultCrit.criticalCount, 1);
});

test('evaluateZapReport: returns exitCode 2 when report is missing, empty, or unparseable', () => {
  // Missing file
  const missingResult = evaluateZapReport(join(tmpdir(), 'non-existent-zap-report.json'));
  assert.equal(missingResult.exitCode, 2);
  assert.ok(missingResult.error, 'Must provide error message on missing report');

  // Empty file
  const emptyFile = join(tmpdir(), `empty-zap-report-${Date.now()}.json`);
  writeFileSync(emptyFile, '   \n  ');
  try {
    const emptyResult = evaluateZapReport(emptyFile);
    assert.equal(emptyResult.exitCode, 2);
    assert.ok(emptyResult.error);
  } finally {
    rmSync(emptyFile, { force: true });
  }

  // Unparseable JSON file
  const malformedFile = join(tmpdir(), `malformed-zap-report-${Date.now()}.json`);
  writeFileSync(malformedFile, '{ not valid json');
  try {
    const malformedResult = evaluateZapReport(malformedFile);
    assert.equal(malformedResult.exitCode, 2);
    assert.ok(malformedResult.error);
  } finally {
    rmSync(malformedFile, { force: true });
  }

  // Invalid data structure (null / undefined / empty string)
  assert.equal(evaluateZapReport(null).exitCode, 2);
  assert.equal(evaluateZapReport(undefined).exitCode, 2);
  assert.equal(evaluateZapReport('').exitCode, 2);
});

test('evaluateZapReport: returns exitCode 2 when scan produced 0 URLs or is empty', () => {
  // Empty object with no scanned sites, findings or urls
  const emptyObjResult = evaluateZapReport({});
  assert.equal(emptyObjResult.exitCode, 2);
  assert.match(emptyObjResult.error, /empty/i);

  // Empty site array
  const emptySitesResult = evaluateZapReport({ site: [] });
  assert.equal(emptySitesResult.exitCode, 2);
  assert.match(emptySitesResult.error, /0 URLs scanned|empty/i);

  // Explicit scannedUrls: 0
  const zeroUrlsResult = evaluateZapReport({ scannedUrls: 0 });
  assert.equal(zeroUrlsResult.exitCode, 2);
  assert.match(zeroUrlsResult.error, /0 scanned URLs/i);

  // Empty urls array
  const emptyUrlsResult = evaluateZapReport({ urls: [] });
  assert.equal(emptyUrlsResult.exitCode, 2);
  assert.match(emptyUrlsResult.error, /0 scanned URLs/i);
});

test('evaluateZapReport: returns exitCode 2 when authentication failure occurs during scan', () => {
  // authFailed flag
  const authFailedResult = evaluateZapReport({
    site: [{ '@name': 'http://127.0.0.1:3000', alerts: [] }],
    authFailed: true,
  });
  assert.equal(authFailedResult.exitCode, 2);
  assert.match(authFailedResult.error, /Authentication failure/i);

  // authErrors array
  const authErrorsResult = evaluateZapReport({
    site: [{ '@name': 'http://127.0.0.1:3000', alerts: [] }],
    authErrors: ['Token expired during login turn'],
  });
  assert.equal(authErrorsResult.exitCode, 2);
  assert.match(authErrorsResult.error, /Authentication error/i);

  // All authenticated endpoints returned 401/403
  const all401Result = evaluateZapReport({
    site: [{ '@name': 'http://127.0.0.1:3000', alerts: [] }],
    authenticatedEndpoints: [
      { path: '/api/auth/me', status: 401 },
      { path: '/profile', status: 403 },
    ],
  });
  assert.equal(all401Result.exitCode, 2);
  assert.match(all401Result.error, /401 or 403/i);
});

test('evaluateZapReport: returns exitCode 2 when authentication or authorization failure alert is detected', () => {
  const authAlertReport = {
    site: [
      {
        '@name': 'http://127.0.0.1:3001',
        alerts: [
          {
            pluginid: '99001',
            alertRef: '99001',
            alert: '401 Unauthorized - Authentication Failure',
            riskcode: '2',
            riskdesc: 'Medium (High)',
            desc: 'Authentication failure reported across protected routes',
            uri: 'http://127.0.0.1:3001/api/auth/me',
          },
        ],
      },
    ],
  };

  const result = evaluateZapReport(authAlertReport);
  assert.equal(result.exitCode, 2);
  assert.match(result.error, /Authentication or authorization failure alert detected/i);
});

test('evaluateZapReport: returns exitCode 2 when 0 endpoints were scanned', () => {
  const zeroEndpointsReport = {
    site: [{ '@name': 'http://127.0.0.1:3000', alerts: [] }],
    endpoints: [],
  };
  const result = evaluateZapReport(zeroEndpointsReport);
  assert.equal(result.exitCode, 2);
  assert.match(result.error, /0 scanned endpoints/i);
});

// -----------------------------------------------------------------------------
// Suite 3b: validateConfigFileScope(configPath, allowedScope)
// -----------------------------------------------------------------------------
test('validateConfigFileScope: accepts automation.yaml within allowed loopback scope', () => {
  const automationPath = resolve(repoRoot, 'tests/security/zap/automation.yaml');
  const allowedScope = [
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3001',
    'http://127.0.0.1:3002',
  ];

  const result = validateConfigFileScope(automationPath, allowedScope);
  assert.equal(result.valid, true, `Scope validation failed: ${result.error}`);
  assert.ok(Array.isArray(result.urls));
  assert.ok(result.urls.length >= 3);
});

test('validateConfigFileScope: rejects configuration declaring external URLs', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'zap-config-evil-'));
  const evilConfig = join(tempDir, 'evil.yaml');
  try {
    writeFileSync(
      evilConfig,
      `
env:
  contexts:
    - name: "Evil"
      urls:
        - "http://evil.com"
jobs:
  - type: "spider"
    parameters:
      url: "http://evil.com"
`,
      'utf8',
    );
    const result = validateConfigFileScope(evilConfig);
    assert.equal(result.valid, false);
    assert.match(result.error, /outside allowed loopback scope/i);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('validateConfigFileScope: rejects configuration when declared target is outside allowedScope', () => {
  const automationPath = resolve(repoRoot, 'tests/security/zap/automation.yaml');
  // allowedScope only permits port 3000, but automation.yaml targets 3001 as well
  const narrowScope = ['http://127.0.0.1:3000'];

  const result = validateConfigFileScope(automationPath, narrowScope);
  assert.equal(result.valid, false);
  assert.match(result.error, /outside allowed scope/i);
});

test('validateConfigFileScope: rejects missing or empty configuration file', () => {
  const missing = validateConfigFileScope(join(tmpdir(), 'missing-config.yaml'));
  assert.equal(missing.valid, false);
  assert.match(missing.error, /not found/i);

  const emptyDir = mkdtempSync(join(tmpdir(), 'zap-config-empty-'));
  const emptyFile = join(emptyDir, 'empty.yaml');
  try {
    writeFileSync(emptyFile, '  \n  ', 'utf8');
    const emptyResult = validateConfigFileScope(emptyFile);
    assert.equal(emptyResult.valid, false);
    assert.match(emptyResult.error, /empty/i);
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }
});

test('SUPPORTED_ZAP_JOB_TYPES exports expected job types Set', () => {
  assert.ok(SUPPORTED_ZAP_JOB_TYPES instanceof Set);
  const expectedJobs = [
    'passiveScan-config',
    'passiveScan-wait',
    'spider',
    'openapi',
    'activeScan',
    'report',
    'requestor',
  ];
  assert.equal(SUPPORTED_ZAP_JOB_TYPES.size, expectedJobs.length);
  for (const job of expectedJobs) {
    assert.ok(SUPPORTED_ZAP_JOB_TYPES.has(job), `Missing job type: ${job}`);
  }
});

test('validateConfigFileScope: rejects configuration with YAML anchor or alias', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'zap-config-anchor-'));
  const anchorConfig = join(tempDir, 'anchor.yaml');
  const aliasConfig = join(tempDir, 'alias.yaml');
  try {
    // YAML anchor definition
    writeFileSync(
      anchorConfig,
      `
env:
  contexts:
    - name: "AnchorContext"
      urls:
        - &ref http://example.com
jobs:
  - type: "spider"
    parameters:
      url: *ref
`,
      'utf8',
    );
    const resultAnchor = validateConfigFileScope(anchorConfig);
    assert.equal(resultAnchor.valid, false);
    assert.match(resultAnchor.error, /unsupported YAML anchor or alias construct/i);
    assert.match(resultAnchor.error, /&ref/);

    // YAML alias reference
    writeFileSync(
      aliasConfig,
      `
env:
  contexts:
    - name: "AliasContext"
      urls:
        - *ref
jobs:
  - type: "spider"
    parameters:
      url: "http://127.0.0.1:3000"
`,
      'utf8',
    );
    const resultAlias = validateConfigFileScope(aliasConfig);
    assert.equal(resultAlias.valid, false);
    assert.match(resultAlias.error, /unsupported YAML anchor or alias construct/i);
    assert.match(resultAlias.error, /\*ref/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('validateConfigFileScope: rejects configuration with unsupported job type', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'zap-config-jobtype-'));
  const ajaxConfig = join(tempDir, 'spider-ajax.yaml');
  const graphqlConfig = join(tempDir, 'graphql.yaml');
  try {
    // Unsupported spiderAjax job
    writeFileSync(
      ajaxConfig,
      `
env:
  contexts:
    - name: "TestContext"
      urls:
        - "http://127.0.0.1:3000"
jobs:
  - type: "spiderAjax"
    parameters:
      url: "http://127.0.0.1:3000"
`,
      'utf8',
    );
    const resultAjax = validateConfigFileScope(ajaxConfig);
    assert.equal(resultAjax.valid, false);
    assert.match(resultAjax.error, /unsupported ZAP job type.*spiderAjax/i);

    // Unsupported graphql job
    writeFileSync(
      graphqlConfig,
      `
env:
  contexts:
    - name: "TestContext"
      urls:
        - "http://127.0.0.1:3000"
jobs:
  - type: "graphql"
    parameters:
      endpoint: "http://127.0.0.1:3000"
`,
      'utf8',
    );
    const resultGraphql = validateConfigFileScope(graphqlConfig);
    assert.equal(resultGraphql.valid, false);
    assert.match(resultGraphql.error, /unsupported ZAP job type.*graphql/i);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('validateConfigFileScope: rejects configuration with external target hidden in arbitrary job parameters', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'zap-config-hidden-'));
  const hiddenConfig = join(tempDir, 'hidden-target.yaml');
  try {
    writeFileSync(
      hiddenConfig,
      `
env:
  contexts:
    - name: "ValidContext"
      urls:
        - "http://127.0.0.1:3000"
jobs:
  - type: "spider"
    parameters:
      url: "http://127.0.0.1:3000"
      customCallback: "http://evil.com/leak"
`,
      'utf8',
    );
    const result = validateConfigFileScope(hiddenConfig);
    assert.equal(result.valid, false);
    assert.match(result.error, /outside allowed loopback scope/i);
    assert.match(result.error, /evil\.com/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('validateConfigFileScope: accepts valid configuration with supported jobs and loopback targets', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'zap-config-valid-'));
  const validConfig = join(tempDir, 'valid.yaml');
  try {
    writeFileSync(
      validConfig,
      `
env:
  contexts:
    - name: "LocalValid"
      urls:
        - "http://127.0.0.1:3000"
        - "http://127.0.0.1:3001"
      includePaths:
        - "http://127.0.0.1:3000/.*"
      excludePaths:
        - "^(?!http://127\\\\.0\\\\.0\\\\.1:(3000|3001)).*"
jobs:
  - type: "passiveScan-config"
  - type: "spider"
    parameters:
      url: "http://127.0.0.1:3000"
  - type: "openapi"
    parameters:
      targetUrl: "http://127.0.0.1:3001"
  - type: "passiveScan-wait"
  - type: "activeScan"
  - type: "report"
  - type: "requestor"
    parameters:
      url: "http://127.0.0.1:3000"
`,
      'utf8',
    );
    const result = validateConfigFileScope(validConfig, ['http://127.0.0.1:3000', 'http://127.0.0.1:3001']);
    assert.equal(result.valid, true, `Expected valid: true, got error: ${result.error}`);
    assert.ok(Array.isArray(result.urls));
    assert.ok(result.urls.includes('http://127.0.0.1:3000'));
    assert.ok(result.urls.includes('http://127.0.0.1:3001'));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// Suite 4: runZap(options, dependencies)
// -----------------------------------------------------------------------------
test('runZap: executes injected docker runner, evaluates clean report, and sanitizes output', async () => {
  const testDir = join(tmpdir(), `run-zap-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });

  const rawReportFile = join(testDir, 'zap-raw-report.json');
  const outputReportFile = join(testDir, 'artifacts/security/zap-report.json');
  const mockConfig = join(testDir, 'automation.yaml');
  writeFileSync(
    mockConfig,
    `
env:
  contexts:
    - name: "BookingSystems-Local"
      urls:
        - "http://127.0.0.1:3000"
        - "http://127.0.0.1:3001"
jobs:
  - type: "spider"
    parameters:
      url: "http://127.0.0.1:3000"
`,
    'utf8',
  );

  const cleanReport = {
    site: [
      {
        '@name': 'http://127.0.0.1:3000',
        alerts: [
          {
            pluginid: '10038',
            alertRef: '10038',
            alert: 'Content Security Policy (CSP) Header Not Set',
            riskcode: '2',
            riskdesc: 'Medium (High)',
            desc: 'Bearer eyJhbGciOiJIUzI1NiJ9.synthetic.jwt token should be redacted',
            uri: 'http://127.0.0.1:3000/',
          },
        ],
      },
    ],
  };

  let runnerCalledWith = null;
  const mockRunner = async (args) => {
    runnerCalledWith = args;
    writeFileSync(rawReportFile, JSON.stringify(cleanReport, null, 2), 'utf8');
    return { exitCode: 0 };
  };

  try {
    const result = await runZap(
      {
        scope: ['http://127.0.0.1:3000', 'http://127.0.0.1:3001'],
        rawReportPath: rawReportFile,
        output: outputReportFile,
        zapDir: testDir,
        configFile: 'automation.yaml',
        toolchainPath,
      },
      {
        dockerRunner: mockRunner,
      },
    );

    assert.ok(runnerCalledWith, 'Injected docker runner must be invoked');
    assert.equal(result.exitCode, 0, 'Clean report should yield exitCode 0');
    assert.equal(result.criticalCount, 0);
    assert.equal(result.highCount, 0);
    assert.equal(result.mediumCount, 1);

    // Verify sanitized report was written
    assert.ok(existsSync(outputReportFile), 'Sanitized report must be written to output path');
    const sanitizedContent = JSON.parse(readFileSync(outputReportFile, 'utf8'));

    assert.ok(sanitizedContent.timestamp);
    assert.ok(sanitizedContent.scannerSummary);
    assert.equal(sanitizedContent.scannerSummary.counts.High, 0);
    assert.equal(sanitizedContent.scannerSummary.counts.Medium, 1);

    // Verify privacy redactions
    const reportStr = JSON.stringify(sanitizedContent);
    assert.ok(
      !reportStr.includes('eyJhbGciOiJIUzI1NiJ9.synthetic.jwt'),
      'Raw JWT token must be redacted in sanitized report',
    );
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('runZap: returns exitCode 1 when high/critical findings exist', async () => {
  const testDir = join(tmpdir(), `run-zap-high-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });

  const rawReportFile = join(testDir, 'zap-raw-report.json');
  const outputReportFile = join(testDir, 'artifacts/security/zap-report.json');
  const mockConfig = join(testDir, 'automation.yaml');
  writeFileSync(
    mockConfig,
    `
env:
  contexts:
    - name: "BookingSystems-Local"
      urls:
        - "http://127.0.0.1:3000"
jobs:
  - type: "spider"
    parameters:
      url: "http://127.0.0.1:3000"
`,
    'utf8',
  );

  const highReport = {
    site: [
      {
        '@name': 'http://127.0.0.1:3000',
        alerts: [
          {
            pluginid: '40012',
            alertRef: '40012',
            alert: 'Cross Site Scripting (Reflected)',
            riskcode: '3', // High
            riskdesc: 'High (High)',
            desc: '<script>alert(1)</script>',
            uri: 'http://127.0.0.1:3000/search',
          },
        ],
      },
    ],
  };

  const mockRunner = async () => {
    writeFileSync(rawReportFile, JSON.stringify(highReport, null, 2), 'utf8');
    return { exitCode: 0 };
  };

  try {
    const result = await runZap(
      {
        scope: ['http://127.0.0.1:3000'],
        rawReportPath: rawReportFile,
        output: outputReportFile,
        zapDir: testDir,
        configFile: 'automation.yaml',
        toolchainPath,
      },
      {
        dockerRunner: mockRunner,
      },
    );

    assert.equal(result.exitCode, 1, 'Report with High alert must yield exitCode 1');
    assert.equal(result.highCount, 1);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('runZap: returns exitCode 3 when runner fails or times out', async () => {
  const failingRunner = async () => {
    throw new Error('Docker execution timed out or container crashed');
  };

  const result = await runZap(
    {
      scope: ['http://127.0.0.1:3000', 'http://127.0.0.1:3001', 'http://127.0.0.1:3002'],
      toolchainPath,
    },
    {
      dockerRunner: failingRunner,
    },
  );

  assert.equal(result.exitCode, 3, 'Container crash or timeout must return exitCode 3');
  assert.ok(result.error);
});

test('runZap: rejects out-of-scope targets and returns exitCode 2', async () => {
  const result = await runZap({
    scope: ['http://example.com'],
    toolchainPath,
  });

  assert.equal(result.exitCode, 2, 'Invalid scope must return exitCode 2');
  assert.ok(result.error);
});

test('runZap: dry-run validates scope and returns dockerArgs without executing container', async () => {
  let runnerCalled = false;
  const mockRunner = async () => {
    runnerCalled = true;
    return { exitCode: 0 };
  };

  const result = await runZap(
    {
      scope: ['http://127.0.0.1:3000', 'http://127.0.0.1:3001', 'http://127.0.0.1:3002'],
      dryRun: true,
      toolchainPath,
    },
    {
      dockerRunner: mockRunner,
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.dryRun, true);
  assert.equal(runnerCalled, false, 'Runner should NOT be called on dry-run');
  assert.ok(Array.isArray(result.dockerArgs));
});

test('runZap: passes explicit timeout options cleanly to docker runner', async () => {
  let capturedTimeoutMs = null;
  const testDir = join(tmpdir(), `run-zap-timeout-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  const rawReportFile = join(testDir, 'zap-raw-report.json');
  const mockConfig = join(testDir, 'automation.yaml');
  writeFileSync(
    mockConfig,
    `
env:
  contexts:
    - name: "BookingSystems-Local"
      urls:
        - "http://127.0.0.1:3000"
jobs:
  - type: "spider"
    parameters:
      url: "http://127.0.0.1:3000"
`,
    'utf8',
  );

  const mockRunner = async (_args, opts) => {
    capturedTimeoutMs = opts.timeoutMs;
    writeFileSync(
      rawReportFile,
      JSON.stringify({ site: [{ '@name': 'http://127.0.0.1:3000', alerts: [] }] }),
      'utf8',
    );
    return { exitCode: 0 };
  };

  try {
    // 1. Explicit timeout in seconds (--timeout 45 -> 45000ms)
    await runZap(
      {
        scope: ['http://127.0.0.1:3000'],
        timeout: 45,
        rawReportPath: rawReportFile,
        output: join(testDir, 'report.json'),
        zapDir: testDir,
        configFile: 'automation.yaml',
        toolchainPath,
      },
      { dockerRunner: mockRunner },
    );
    assert.equal(capturedTimeoutMs, 45000, 'timeout in seconds must convert directly to milliseconds');

    // 2. Explicit timeoutMs (timeoutMs: 120000 -> 120000ms)
    await runZap(
      {
        scope: ['http://127.0.0.1:3000'],
        timeoutMs: 120000,
        rawReportPath: rawReportFile,
        output: join(testDir, 'report.json'),
        zapDir: testDir,
        configFile: 'automation.yaml',
        toolchainPath,
      },
      { dockerRunner: mockRunner },
    );
    assert.equal(capturedTimeoutMs, 120000, 'timeoutMs must be passed directly');
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('runZap: Issue 4: returns exitCode 2 when config targets exceed scope', async () => {
  // automation.yaml declares 3000, 3001, 3002. Passing scope restricted to only 3000 must fail.
  const result = await runZap({
    scope: ['http://127.0.0.1:3000'],
    toolchainPath,
  });

  assert.equal(result.exitCode, 2);
  assert.match(result.error, /outside allowed scope/i);
});

test('runZap: Issue 5: cleans existing raw reports and rejects missing or stale report files', async () => {
  const testDir = join(tmpdir(), `run-zap-stale-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });

  const rawReportFile = join(testDir, 'zap-raw-report.json');
  const rawSarifFile = join(testDir, 'zap-raw-report.sarif');
  const mockConfig = join(testDir, 'automation.yaml');
  writeFileSync(
    mockConfig,
    `
env:
  contexts:
    - name: "BookingSystems-Local"
      urls:
        - "http://127.0.0.1:3000"
jobs:
  - type: "spider"
    parameters:
      url: "http://127.0.0.1:3000"
`,
    'utf8',
  );

  // 1. Verify pre-existing raw files are cleaned before runner runs
  writeFileSync(rawReportFile, '{"site":[]}', 'utf8');
  writeFileSync(rawSarifFile, '{}', 'utf8');

  let runnerRan = false;
  const mockRunnerMissing = async () => {
    runnerRan = true;
    // Intentionally DO NOT create rawReportFile
    return { exitCode: 0 };
  };

  try {
    const missingResult = await runZap(
      {
        scope: ['http://127.0.0.1:3000'],
        rawReportPath: rawReportFile,
        output: join(testDir, 'report.json'),
        zapDir: testDir,
        configFile: 'automation.yaml',
        toolchainPath,
      },
      { dockerRunner: mockRunnerMissing },
    );

    assert.equal(runnerRan, true);
    assert.equal(missingResult.exitCode, 2);
    assert.match(missingResult.error, /was not generated by ZAP run or is stale/i);
    assert.equal(existsSync(rawSarifFile), false, 'Pre-existing sarif file must be removed');

    // 2. Verify stale report file (mtime older than run start) fails with exitCode 2
    const mockRunnerStale = async () => {
      writeFileSync(
        rawReportFile,
        JSON.stringify({ site: [{ '@name': 'http://127.0.0.1:3000', alerts: [] }] }),
        'utf8',
      );
      // Backdate mtime to 10 seconds in the past
      const past = (Date.now() - 10000) / 1000;
      utimesSync(rawReportFile, past, past);
      return { exitCode: 0 };
    };

    const staleResult = await runZap(
      {
        scope: ['http://127.0.0.1:3000'],
        rawReportPath: rawReportFile,
        output: join(testDir, 'report.json'),
        zapDir: testDir,
        configFile: 'automation.yaml',
        toolchainPath,
      },
      { dockerRunner: mockRunnerStale },
    );

    assert.equal(staleResult.exitCode, 2);
    assert.match(staleResult.error, /was not generated by ZAP run or is stale/i);

    // 3. Verify that passing in-memory rawReport bypasses disk existence check
    const inMemoryResult = await runZap(
      {
        scope: ['http://127.0.0.1:3000'],
        rawReport: {
          site: [{ '@name': 'http://127.0.0.1:3000', alerts: [] }],
        },
        output: join(testDir, 'report.json'),
        zapDir: testDir,
        configFile: 'automation.yaml',
        toolchainPath,
      },
      { dockerRunner: async () => ({ exitCode: 0 }) },
    );

    assert.equal(inMemoryResult.exitCode, 0);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// Suite 5: CLI execution via spawnSync
// -----------------------------------------------------------------------------
test('CLI: node scripts/security/run-zap.mjs --help outputs usage and exits 0', () => {
  const proc = spawnSync('node', [runZapCli, '--help'], { encoding: 'utf8' });
  assert.equal(proc.status, 0, `--help must exit 0, got status ${proc.status}: ${proc.stderr}`);
  assert.match(proc.stdout, /Usage:/i, 'Help text must describe usage');
  assert.match(proc.stdout, /--dry-run/, 'Help text must mention --dry-run');
  assert.match(proc.stdout, /--scope/, 'Help text must mention --scope');
});

test('CLI: node scripts/security/run-zap.mjs --dry-run validates config and exits 0', () => {
  const proc = spawnSync('node', [runZapCli, '--dry-run'], { encoding: 'utf8' });
  assert.equal(proc.status, 0, `--dry-run must exit 0, got: ${proc.stderr}`);
  assert.match(proc.stdout, /dry-run/i, 'Stdout should indicate dry-run success');
});

test('CLI: node scripts/security/run-zap.mjs --scope http://evil.com exits with error code', () => {
  const proc = spawnSync('node', [runZapCli, '--scope', 'http://evil.com'], { encoding: 'utf8' });
  assert.ok(
    proc.status === 2 || proc.status === 3,
    `Invalid scope must exit with code 2 or 3, got status ${proc.status}`,
  );
});
