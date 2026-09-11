import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  evaluateSupplyChain,
  validateExplicitCounts,
} from '../../scripts/security/evaluate-results.mjs';
import {
  main,
  parseGitleaksOutput,
  parsePipAuditOutput,
  parsePnpmAuditOutput,
  runPipAudit,
  runPnpmAudit,
  runSecretScan,
  runSupplyChainScan,
} from '../../scripts/security/run-supply-chain.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..', '..');

function createTempDir(prefix = 'sc-test-') {
  const dir = join(tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('T033 - parsePipAuditOutput: parses vulnerable python package and assigns severity', () => {
  const mockPipAuditOutput = JSON.stringify({
    dependencies: [
      {
        name: 'cryptography',
        version: '41.0.0',
        vulns: [
          {
            id: 'PYSEC-2023-123',
            fix_versions: ['41.0.5'],
            description: 'Vulnerable buffer overflow in cryptography',
            aliases: ['CVE-2023-45678'],
            severity: 'CRITICAL',
          },
          {
            id: 'PYSEC-2023-124',
            fix_versions: ['41.0.6'],
            description: 'Timing attack vulnerability in cryptography',
            aliases: ['CVE-2023-45679'],
            severity: 'HIGH',
          },
        ],
      },
      {
        name: 'urllib3',
        version: '1.26.5',
        vulns: [
          {
            id: 'PYSEC-2023-125',
            fix_versions: ['1.26.18'],
            description: 'Cookie leak on redirect',
            aliases: ['CVE-2023-45680'],
            severity: 'MEDIUM',
          },
        ],
      },
    ],
  });

  const parsed = parsePipAuditOutput(mockPipAuditOutput);
  assert.equal(parsed.findings.length, 3);
  assert.equal(parsed.counts.Critical, 1);
  assert.equal(parsed.counts.High, 1);
  assert.equal(parsed.counts.Medium, 1);
  assert.equal(parsed.counts.Low, 0);

  const crit = parsed.findings.find((f) => f.id === 'PYSEC-2023-123');
  assert.ok(crit);
  assert.equal(crit.severity, 'Critical');
  assert.equal(crit.package, 'cryptography');
  assert.equal(crit.scanner, 'pip-audit');
});

test('T033 - parsePipAuditOutput: handles clean output with 0 vulnerabilities', () => {
  const cleanOutput = JSON.stringify({
    dependencies: [
      {
        name: 'fastapi',
        version: '0.115.0',
        vulns: [],
      },
    ],
  });

  const parsed = parsePipAuditOutput(cleanOutput);
  assert.equal(parsed.findings.length, 0);
  assert.deepEqual(parsed.counts, {
    Critical: 0,
    High: 0,
    Medium: 0,
    Low: 0,
    Informational: 0,
  });
});

test('T033 - parsePnpmAuditOutput: parses pnpm audit vulnerabilities and metadata', () => {
  const mockPnpmAuditOutput = JSON.stringify({
    actions: [],
    advisories: {
      '1092': {
        id: 1092,
        title: 'Prototype Pollution in lodash',
        module_name: 'lodash',
        severity: 'high',
        findings: [{ version: '4.17.15', paths: ['lodash'] }],
        overview: 'Prototype pollution in lodash',
        github_advisory_id: 'GHSA-p6mc-m468-83gw',
      },
      '2001': {
        id: 2001,
        title: 'Remote Code Execution in vm2',
        module_name: 'vm2',
        severity: 'critical',
        findings: [{ version: '3.9.15', paths: ['vm2'] }],
        overview: 'Sandbox escape in vm2',
        github_advisory_id: 'GHSA-1234-5678-9012',
      },
    },
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: 1,
        critical: 1,
      },
      dependencies: 1200,
      devDependencies: 300,
      totalDependencies: 1500,
    },
  });

  const parsed = parsePnpmAuditOutput(mockPnpmAuditOutput);
  assert.equal(parsed.findings.length, 2);
  assert.equal(parsed.counts.Critical, 1);
  assert.equal(parsed.counts.High, 1);
  assert.equal(parsed.counts.Medium, 0);

  const rce = parsed.findings.find((f) => f.package === 'vm2');
  assert.ok(rce);
  assert.equal(rce.severity, 'Critical');
  assert.equal(rce.scanner, 'pnpm-audit');
});

test('T033 - parsePnpmAuditOutput: handles clean pnpm audit output', () => {
  const cleanPnpm = JSON.stringify({
    actions: [],
    advisories: {},
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: 0,
        critical: 0,
      },
      dependencies: 100,
      devDependencies: 20,
      totalDependencies: 120,
    },
  });

  const parsed = parsePnpmAuditOutput(cleanPnpm);
  assert.equal(parsed.findings.length, 0);
  assert.deepEqual(parsed.counts, {
    Critical: 0,
    High: 0,
    Medium: 0,
    Low: 0,
    Informational: 0,
  });
});

test('T033 - parseGitleaksOutput: parses secrets report and redacts raw secrets', () => {
  const rawSecret = 'sk-' + 'abcdef1234567890abcdef1234';
  const mockGitleaksOutput = JSON.stringify([
    {
      Description: `Hardcoded API key: ${rawSecret}`,
      StartLine: 12,
      EndLine: 12,
      StartColumn: 1,
      EndColumn: 40,
      Match: rawSecret,
      Secret: rawSecret,
      File: 'apps/agent/src/secret.py',
      Commit: '1234567890abcdef',
      RuleID: 'openai-api-key',
      Fingerprint: 'mock-fingerprint-1234',
    },
  ]);

  const parsed = parseGitleaksOutput(mockGitleaksOutput);
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.counts.High, 1);

  const f = parsed.findings[0];
  assert.equal(f.file, 'apps/agent/src/secret.py');
  assert.equal(f.scanner, 'gitleaks');

  // Verify secret redaction invariant
  const findingStr = JSON.stringify(f);
  assert.equal(findingStr.includes(rawSecret), false, 'Raw secret must not appear in finding');
  assert.ok(findingStr.includes('[REDACTED_SECRET]') || !findingStr.includes('sk-'));
});

test('T033 - runSupplyChainScan: positive control with vulnerable pip package fails policy', () => {
  const tempDir = createTempDir();
  const outputPath = join(tempDir, 'supply-chain.json');

  const mockExecFn = (cmd, args) => {
    const fullCmd = [cmd, ...args].join(' ');
    if (fullCmd.includes('pip-audit')) {
      return {
        status: 1,
        stdout: JSON.stringify({
          dependencies: [
            {
              name: 'insecure-package',
              version: '0.1.0',
              vulns: [
                {
                  id: 'PYSEC-2023-CRIT',
                  description: 'Critical code execution in insecure-package',
                  severity: 'CRITICAL',
                },
              ],
            },
          ],
        }),
        stderr: '',
      };
    }
    if (fullCmd.includes('pnpm audit')) {
      return {
        status: 0,
        stdout: JSON.stringify({
          actions: [],
          advisories: {},
          metadata: { vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0, info: 0 } },
        }),
        stderr: '',
      };
    }
    if (fullCmd.includes('gitleaks')) {
      return {
        status: 0,
        stdout: '[]',
        stderr: '',
      };
    }
    return { status: 0, stdout: '', stderr: '' };
  };

  try {
    const result = runSupplyChainScan({
      rootDir: repoRoot,
      output: outputPath,
      execFn: mockExecFn,
    });

    assert.equal(result.passed, false, 'Scan must fail when Critical vuln is present');
    assert.equal(result.exitCode, 1);
    assert.ok(result.counts.Critical >= 1);
    assert.ok(existsSync(outputPath));

    // Verify evaluateSupplyChain also fails closed
    const fileContent = JSON.parse(readFileSync(outputPath, 'utf8'));
    assert.equal(fileContent.version, '1.0.0');
    const evaluated = evaluateSupplyChain(fileContent);
    assert.equal(evaluated.passed, false);
    assert.ok(evaluated.errors.some((e) => e.includes('Critical vulnerability finding')));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('T033 - runSupplyChainScan: positive control with detected secret fails policy and redacts secret', () => {
  const tempDir = createTempDir();
  const outputPath = join(tempDir, 'supply-chain.json');
  const leakedJwtSecret = 'JWT_SECRET=supersecretlongkeywithmanycharacters12345';

  const mockExecFn = (cmd, args) => {
    const fullCmd = [cmd, ...args].join(' ');
    if (fullCmd.includes('pip-audit')) {
      return {
        status: 0,
        stdout: JSON.stringify({ dependencies: [] }),
        stderr: '',
      };
    }
    if (fullCmd.includes('pnpm audit')) {
      return {
        status: 0,
        stdout: JSON.stringify({
          actions: [],
          advisories: {},
          metadata: { vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0, info: 0 } },
        }),
        stderr: '',
      };
    }
    if (fullCmd.includes('gitleaks')) {
      return {
        status: 1,
        stdout: JSON.stringify([
          {
            Description: `Detected secret ${leakedJwtSecret}`,
            Match: leakedJwtSecret,
            Secret: leakedJwtSecret,
            File: 'apps/api/.env',
            StartLine: 5,
            RuleID: 'jwt-secret',
            Fingerprint: 'mock-jwt-fingerprint',
          },
        ]),
        stderr: '',
      };
    }
    return { status: 0, stdout: '', stderr: '' };
  };

  try {
    const result = runSupplyChainScan({
      rootDir: repoRoot,
      output: outputPath,
      execFn: mockExecFn,
    });

    assert.equal(result.passed, false, 'Secret finding must cause scan to fail');
    assert.equal(result.exitCode, 1);

    // Verify report sanitization invariant
    const rawReportContent = readFileSync(outputPath, 'utf8');
    assert.equal(
      rawReportContent.includes('supersecretlongkeywithmanycharacters12345'),
      false,
      'Raw secret text must NEVER appear in persisted supply-chain.json',
    );

    const reportJson = JSON.parse(rawReportContent);
    assert.equal(reportJson.version, '1.0.0');
    const evaluated = evaluateSupplyChain(reportJson);
    assert.equal(evaluated.passed, false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('T033 - runSupplyChainScan: negative control with clean dependencies and 0 secrets passes', () => {
  const tempDir = createTempDir();
  const outputPath = join(tempDir, 'supply-chain.json');

  const mockExecFn = (cmd, args) => {
    const fullCmd = [cmd, ...args].join(' ');
    if (fullCmd.includes('pip-audit')) {
      return {
        status: 0,
        stdout: JSON.stringify({ dependencies: [{ name: 'safe-pkg', version: '1.0.0', vulns: [] }] }),
        stderr: '',
      };
    }
    if (fullCmd.includes('pnpm audit')) {
      return {
        status: 0,
        stdout: JSON.stringify({
          actions: [],
          advisories: {},
          metadata: { vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0, info: 0 } },
        }),
        stderr: '',
      };
    }
    if (fullCmd.includes('gitleaks')) {
      return {
        status: 0,
        stdout: '[]',
        stderr: '',
      };
    }
    return { status: 0, stdout: '', stderr: '' };
  };

  try {
    const result = runSupplyChainScan({
      rootDir: repoRoot,
      output: outputPath,
      execFn: mockExecFn,
    });

    assert.equal(result.passed, true, 'Clean scan must pass');
    assert.equal(result.exitCode, 0);
    assert.equal(result.findings.length, 0);
    assert.deepEqual(result.counts, {
      Critical: 0,
      High: 0,
      Medium: 0,
      Low: 0,
      Informational: 0,
    });

    // Verify evaluateSupplyChain evaluates to passed
    const reportJson = JSON.parse(readFileSync(outputPath, 'utf8'));
    assert.equal(reportJson.version, '1.0.0');
    assert.ok(reportJson.pipAudit.advisoryDatabaseTimestamp, 'Must capture advisory DB timestamp');
    assert.ok(reportJson.pnpmAudit.advisoryDatabaseTimestamp, 'Must capture advisory DB timestamp');

    const evaluated = evaluateSupplyChain(reportJson);
    assert.equal(evaluated.passed, true);
    assert.equal(evaluated.errors.length, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('T033 - runSupplyChainScan: unavailable scanner fails closed in strict mode', () => {
  const tempDir = createTempDir();
  const outputPath = join(tempDir, 'supply-chain.json');

  const failingExecFn = () => {
    const err = new Error('spawn pip-audit ENOENT');
    err.code = 'ENOENT';
    throw err;
  };

  try {
    const result = runSupplyChainScan({
      rootDir: repoRoot,
      output: outputPath,
      strict: true,
      execFn: failingExecFn,
    });

    assert.equal(result.passed, false, 'Unavailable scanner in strict mode must fail closed');
    assert.equal(result.exitCode, 1);
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors.some((e) => e.includes('pip-audit') || e.includes('ENOENT')));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('T033 - runSupplyChainScan: offline mode skips or handles network dependencies gracefully', () => {
  const tempDir = createTempDir();
  const outputPath = join(tempDir, 'supply-chain.json');

  let pnpmAuditCalledWithOfflineOrFlag = false;

  const mockExecFn = (cmd, args) => {
    const fullCmd = [cmd, ...args].join(' ');
    if (fullCmd.includes('pnpm audit')) {
      pnpmAuditCalledWithOfflineOrFlag = true;
      return {
        status: 0,
        stdout: JSON.stringify({
          actions: [],
          advisories: {},
          metadata: { vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0, info: 0 } },
        }),
        stderr: '',
      };
    }
    return { status: 0, stdout: '[]', stderr: '' };
  };

  try {
    const result = runSupplyChainScan({
      rootDir: repoRoot,
      output: outputPath,
      offline: true,
      execFn: mockExecFn,
    });

    assert.equal(result.passed, true);
    assert.ok(existsSync(outputPath));
    const report = JSON.parse(readFileSync(outputPath, 'utf8'));
    assert.equal(report.offline, true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('T033 - main CLI entry point: handles arguments and exit codes', () => {
  const tempDir = createTempDir();
  const outputPath = join(tempDir, 'supply-chain.json');

  const mockExecFn = (cmd, args) => {
    const fullCmd = [cmd, ...args].join(' ');
    if (fullCmd.includes('pip-audit')) {
      return { status: 0, stdout: JSON.stringify({ dependencies: [] }), stderr: '' };
    }
    if (fullCmd.includes('pnpm audit')) {
      return {
        status: 0,
        stdout: JSON.stringify({
          actions: [],
          advisories: {},
          metadata: { vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0, info: 0 } },
        }),
        stderr: '',
      };
    }
    return { status: 0, stdout: '[]', stderr: '' };
  };

  let exitedCode = null;
  const logged = [];
  const errors = [];

  const exitFn = (code) => {
    exitedCode = code;
  };
  const logFn = (msg) => logged.push(msg);
  const errFn = (msg) => errors.push(msg);

  try {
    main(['--output', outputPath], {
      rootDir: repoRoot,
      execFn: mockExecFn,
      exitFn,
      logFn,
      errFn,
    });

    assert.equal(exitedCode, 0, 'Clean main execution must exit with 0');
    assert.ok(existsSync(outputPath));
    assert.ok(logged.some((l) => l.includes('PASSED') || l.includes('exit code 0')));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('T033 - runSecretScan: writes and parses from report file', () => {
  const tempDir = createTempDir();
  const reportPath = join(tempDir, 'test-gitleaks-report.json');

  let execCalledWithReportPath = false;
  const mockExecFn = (cmd, args) => {
    const reportPathIdx = args.indexOf('--report-path');
    if (reportPathIdx !== -1) {
      execCalledWithReportPath = true;
      const targetPath = args[reportPathIdx + 1];
      const findings = [
        {
          RuleID: 'aws-secret-key',
          Description: 'AWS Secret Key detected',
          File: 'apps/api/secret.env',
          StartLine: 4,
          Secret: 'AKIA' + 'IOSFODNN7EXAMPLE',
        },
      ];
      writeFileSync(targetPath, JSON.stringify(findings));
      return { status: 1, stdout: '', stderr: '' };
    }
    return { status: 0, stdout: '[]', stderr: '' };
  };

  try {
    const result = runSecretScan({
      rootDir: repoRoot,
      reportPath,
      execFn: mockExecFn,
    });

    assert.equal(execCalledWithReportPath, true);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].ruleId, 'aws-secret-key');
    assert.equal(result.counts.Critical, 1);
    assert.equal(result.errors.length, 0);
    assert.equal(existsSync(reportPath), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('T033 - runSecretScan: fails closed on nonzero exit code with no findings', () => {
  const mockExecFn = (_cmd, _args) => {
    return {
      status: 2,
      stdout: '',
      stderr: 'fatal: invalid argument --unknown-flag',
    };
  };

  const result = runSecretScan({
    rootDir: repoRoot,
    execFn: mockExecFn,
  });

  assert.equal(result.findings.length, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /\[Secret Scanner Error\] Gitleaks exited with code 2/);
  assert.match(result.errors[0], /invalid argument/);
});

