import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildZapDockerArgs,
  evaluateZapReport,
  runZap,
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
test('validateScope: accepts valid loopback addresses on allowed ports (3000, 3001, 3002)', () => {
  assert.equal(validateScope('http://127.0.0.1:3000'), true);
  assert.equal(validateScope('http://127.0.0.1:3001'), true);
  assert.equal(validateScope('http://127.0.0.1:3002'), true);
  assert.equal(validateScope('http://localhost:3000'), true);
  assert.equal(validateScope('http://localhost:3001'), true);
  assert.equal(validateScope('http://localhost:3002'), true);

  // Array of valid targets
  assert.equal(
    validateScope([
      'http://127.0.0.1:3000',
      'http://127.0.0.1:3001',
      'http://127.0.0.1:3002',
    ]),
    true,
  );
  assert.equal(validateScope(['http://localhost:3000', 'http://127.0.0.1:3001']), true);
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

// -----------------------------------------------------------------------------
// Suite 4: runZap(options, dependencies)
// -----------------------------------------------------------------------------
test('runZap: executes injected docker runner, evaluates clean report, and sanitizes output', async () => {
  const testDir = join(tmpdir(), `run-zap-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });

  const rawReportFile = join(testDir, 'zap-raw-report.json');
  const outputReportFile = join(testDir, 'artifacts/security/zap-report.json');

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
  writeFileSync(rawReportFile, JSON.stringify(cleanReport, null, 2), 'utf8');

  let runnerCalledWith = null;
  const mockRunner = async (args) => {
    runnerCalledWith = args;
    return { exitCode: 0 };
  };

  try {
    const result = await runZap(
      {
        scope: ['http://127.0.0.1:3000', 'http://127.0.0.1:3001'],
        rawReportPath: rawReportFile,
        output: outputReportFile,
        zapDir: testDir,
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
  writeFileSync(rawReportFile, JSON.stringify(highReport, null, 2), 'utf8');

  const mockRunner = async () => ({ exitCode: 0 });

  try {
    const result = await runZap(
      {
        scope: ['http://127.0.0.1:3000'],
        rawReportPath: rawReportFile,
        output: outputReportFile,
        zapDir: testDir,
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
      scope: ['http://127.0.0.1:3000'],
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
      scope: ['http://127.0.0.1:3000'],
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
