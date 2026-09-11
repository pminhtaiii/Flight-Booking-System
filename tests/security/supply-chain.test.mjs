import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { main, runSupplyChainScan } from '../../scripts/security/run-supply-chain.mjs';
import { evaluateSupplyChain } from '../../scripts/security/evaluate-results.mjs';

test('writes a versioned clean report through the public scan interface', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'supply-chain-clean-'));
  try {
    const result = runSupplyChainScan({
      rootDir: process.cwd(),
      output: join(tempDir, 'supply-chain.json'),
      strict: false,
      execFn: (command) => {
        if (command === 'pnpm')
          return {
            status: 0,
            stdout: JSON.stringify({ advisories: {}, metadata: { vulnerabilities: {} } }),
            stderr: '',
          };
        if (command === 'gitleaks') return { status: 0, stdout: '[]', stderr: '' };
        return { status: 0, stdout: '[]', stderr: '' };
      },
      now: () => new Date('2026-09-11T00:00:00.000Z'),
      rawReportDir: join(tempDir, 'raw-reports'),
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.passed, true);
    assert.equal(result.report.version, '1.0.0');
    assert.deepEqual(result.report.counts, {
      Critical: 0,
      High: 0,
      Medium: 0,
      Low: 0,
      Informational: 0,
    });
    assert.ok(result.report.pipAudit);
    assert.ok(result.report.pnpmAudit);
    assert.ok(result.report.gitleaks);
    assert.equal(result.report.pipAudit.freshness.advisoryDatabaseTimestamp, undefined);
    assert.equal(result.report.pnpmAudit.freshness.advisoryDatabaseTimestamp, undefined);
    assert.equal(
      evaluateSupplyChain(result.report, { currentDate: '2026-09-11T00:00:00.000Z' }).passed,
      true,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('exports the locked agent dependency set before invoking pinned pip-audit', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'supply-chain-contract-'));
  const calls = [];
  try {
    const result = runSupplyChainScan({
      rootDir: process.cwd(),
      output: join(tempDir, 'supply-chain.json'),
      strict: false,
      rawReportDir: join(tempDir, 'raw'),
      now: () => new Date('2026-09-11T00:00:00.000Z'),
      execFn: (command, args) => {
        calls.push({ command, args });
        if (command === 'pnpm')
          return {
            status: 0,
            stdout: JSON.stringify({ advisories: {}, metadata: { vulnerabilities: {} } }),
            stderr: '',
          };
        if (command === 'gitleaks') return { status: 0, stdout: '[]', stderr: '' };
        if (args[0] === 'export')
          return { status: 0, stdout: '# frozen agent requirements\n', stderr: '' };
        return { status: 0, stdout: JSON.stringify({ dependencies: [] }), stderr: '' };
      },
    });

    assert.equal(result.exitCode, 0, result.errors.join('; '));
    const uvCalls = calls.filter(({ command }) => command === 'uv');
    assert.equal(uvCalls.length, 2);
    assert.deepEqual(uvCalls[0].args.slice(0, 8), [
      'export',
      '--package',
      'agent',
      '--locked',
      '--no-dev',
      '--format',
      'requirements-txt',
      '--output-file',
    ]);
    assert.equal(uvCalls[0].args[8], join(tempDir, 'raw', 'agent-requirements.txt'));
    assert.deepEqual(uvCalls[1].args.slice(0, 7), [
      'tool',
      'run',
      '--from',
      'pip-audit==2.7.3',
      'pip-audit',
      '--requirement',
      join(tempDir, 'raw', 'agent-requirements.txt'),
    ]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('runs Gitleaks over all history and the current working tree separately', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'supply-chain-gitleaks-'));
  const gitleaksCalls = [];
  try {
    const result = runSupplyChainScan({
      rootDir: process.cwd(),
      output: join(tempDir, 'supply-chain.json'),
      strict: false,
      rawReportDir: join(tempDir, 'raw'),
      execFn: (command, args) => {
        if (command === 'gitleaks') gitleaksCalls.push(args);
        if (command === 'pnpm')
          return {
            status: 0,
            stdout: JSON.stringify({ advisories: {}, metadata: { vulnerabilities: {} } }),
            stderr: '',
          };
        if (command === 'gitleaks') return { status: 0, stdout: '[]', stderr: '' };
        if (args[0] === 'export')
          return { status: 0, stdout: '# frozen requirements\n', stderr: '' };
        return { status: 0, stdout: JSON.stringify({ dependencies: [] }), stderr: '' };
      },
    });

    assert.equal(result.exitCode, 0, result.errors.join('; '));
    assert.equal(gitleaksCalls.length, 2);
    assert.ok(gitleaksCalls[0].includes('--log-opts=--all'));
    assert.ok(!gitleaksCalls[0].includes('--no-git'));
    assert.ok(gitleaksCalls[1].includes('--no-git'));
    assert.ok(!gitleaksCalls[1].includes('--log-opts=--all'));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('normalizes blocking vulnerabilities and redacts constructed secret controls', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'supply-chain-findings-'));
  const secretCanary = 'constructed-runtime-secret-9f5f';
  try {
    const result = runSupplyChainScan({
      rootDir: process.cwd(),
      output: join(tempDir, 'supply-chain.json'),
      strict: false,
      rawReportDir: join(tempDir, 'raw'),
      now: () => new Date('2026-09-11T00:00:00.000Z'),
      execFn: (command, args) => {
        if (command === 'pnpm') {
          return {
            status: 1,
            stdout: JSON.stringify({
              advisories: {
                1001: {
                  id: 1001,
                  module_name: 'fixture-package',
                  severity: 'high',
                  title: 'Synthetic package vulnerability',
                },
              },
              metadata: { vulnerabilities: { high: 1 } },
            }),
            stderr: '',
          };
        }
        if (command === 'gitleaks') {
          return {
            status: 1,
            stdout: JSON.stringify([
              {
                RuleID: 'jwt-secret',
                File: 'apps/api/src/config.ts',
                StartLine: 7,
                Secret: secretCanary,
                Match: secretCanary,
              },
            ]),
            stderr: '',
          };
        }
        if (args[0] === 'export')
          return { status: 0, stdout: '# frozen requirements\n', stderr: '' };
        return {
          status: 1,
          stdout: JSON.stringify({
            dependencies: [
              {
                name: 'fixture-python-package',
                version: '1.0.0',
                vulns: [
                  {
                    id: 'CVE-2099-0001',
                    severity: 'critical',
                    description: 'Synthetic Python vulnerability',
                  },
                ],
              },
            ],
          }),
          stderr: '',
        };
      },
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.passed, false);
    assert.equal(result.counts.Critical, 2);
    assert.equal(result.counts.High, 1);
    assert.equal(result.findings.length, 3);
    const serialized = JSON.stringify(result.report);
    assert.doesNotMatch(serialized, new RegExp(secretCanary));
    assert.doesNotMatch(serialized, /"(?:Secret|Match)"/);
    assert.ok(result.report.findings.every((finding) => finding.fingerprint.length === 64));
    const evaluation = evaluateSupplyChain(result.report, {
      currentDate: '2026-09-11T00:00:00.000Z',
    });
    assert.equal(evaluation.passed, false);
    assert.ok(evaluation.errors.some((error) => error.includes('Critical')));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails closed on malformed reports and unavailable scanner execution while persisting evidence', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'supply-chain-errors-'));
  const outputPath = join(tempDir, 'supply-chain.json');
  try {
    const result = runSupplyChainScan({
      rootDir: process.cwd(),
      output: outputPath,
      strict: true,
      rawReportDir: join(tempDir, 'raw'),
      now: () => new Date('2026-09-11T00:00:00.000Z'),
      execFn: (command, args) => {
        if (command === 'gitleaks') {
          const error = new Error('spawnSync gitleaks ENOENT');
          error.code = 'ENOENT';
          throw error;
        }
        if (command === 'pnpm') return { status: 1, stdout: '', stderr: 'registry unavailable' };
        if (args[0] === 'export')
          return { status: 0, stdout: '# frozen requirements\n', stderr: '' };
        return { status: 0, stdout: 'not-json', stderr: '' };
      },
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.passed, false);
    assert.ok(result.errors.some((error) => error.includes('Parse Error')));
    assert.ok(result.errors.some((error) => error.includes('unavailable')));
    assert.ok(existsSync(outputPath));
    const persisted = JSON.parse(readFileSync(outputPath, 'utf8'));
    assert.equal(persisted.version, '1.0.0');
    assert.ok(Array.isArray(persisted.errors));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails strict scans when an emitted advisory timestamp is stale', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'supply-chain-stale-'));
  try {
    const result = runSupplyChainScan({
      rootDir: process.cwd(),
      output: join(tempDir, 'supply-chain.json'),
      strict: true,
      rawReportDir: join(tempDir, 'raw'),
      now: () => new Date('2026-09-11T00:00:00.000Z'),
      execFn: (command, args) => {
        if (command === 'pnpm') {
          return {
            status: 0,
            stdout: JSON.stringify({
              advisories: {},
              metadata: { vulnerabilities: {} },
              advisoryDatabaseTimestamp: '2026-09-01T00:00:00.000Z',
            }),
            stderr: '',
          };
        }
        if (command === 'gitleaks') return { status: 0, stdout: '[]', stderr: '' };
        if (args[0] === 'export')
          return { status: 0, stdout: '# frozen requirements\n', stderr: '' };
        return {
          status: 0,
          stdout: JSON.stringify({
            dependencies: [],
            advisoryDatabaseTimestamp: '2026-09-01T00:00:00.000Z',
          }),
          stderr: '',
        };
      },
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.passed, false);
    assert.equal(
      result.report.pipAudit.freshness.advisoryDatabaseTimestamp,
      '2026-09-01T00:00:00.000Z',
    );
    assert.ok(result.errors.filter((error) => error.includes('Freshness Error')).length >= 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails closed when the sanitized report cannot be written', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'supply-chain-write-'));
  try {
    const result = runSupplyChainScan({
      rootDir: process.cwd(),
      output: tempDir,
      strict: false,
      rawReportDir: join(tempDir, 'raw'),
      execFn: (command, args) => {
        if (command === 'pnpm')
          return {
            status: 0,
            stdout: JSON.stringify({ advisories: {}, metadata: { vulnerabilities: {} } }),
            stderr: '',
          };
        if (command === 'gitleaks') return { status: 0, stdout: '[]', stderr: '' };
        if (args[0] === 'export')
          return { status: 0, stdout: '# frozen requirements\n', stderr: '' };
        return { status: 0, stdout: JSON.stringify({ dependencies: [] }), stderr: '' };
      },
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.passed, false);
    assert.ok(result.errors.some((error) => error.includes('Report Error')));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('supports the strict CLI contract and rejects unknown options', () => {
  let exitCode;
  const helpLogs = [];
  assert.equal(
    main(['--help'], {
      exitFn: (code) => {
        exitCode = code;
        return code;
      },
      logFn: (message) => helpLogs.push(message),
      errFn: () => {},
    }),
    0,
  );
  assert.equal(exitCode, 0);
  assert.match(helpLogs.join('\n'), /--output/);

  const errors = [];
  assert.equal(
    main(['--unknown'], {
      exitFn: (code) => code,
      logFn: () => {},
      errFn: (message) => errors.push(message),
    }),
    1,
  );
  assert.match(errors.join('\n'), /Unknown option/);
});
