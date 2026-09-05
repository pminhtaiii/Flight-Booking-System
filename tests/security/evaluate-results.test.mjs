import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  evaluateCoverage,
  evaluateDast,
  evaluateDetectorMetrics,
  evaluateInvariants,
  evaluateSast,
  evaluateSecurityResults,
  evaluateSupplyChain,
  hasValidSeverityCounts,
  validateExplicitCounts,
  validateReportSchemas,
  verifyShardUnion,
} from '../../scripts/security/evaluate-results.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..', '..');
const evaluatorCliPath = resolve(repoRoot, 'scripts/security/evaluate-results.mjs');

const EVAL_DATE = '2026-09-05T00:00:00Z';

function createCleanFixtureReports() {
  return {
    coverage: {
      version: '1.0.0',
      statementCoverage: 96.2,
      branchCoverage: 91.5,
      statements: { covered: 962, total: 1000, pct: 96.2 },
      branches: { covered: 183, total: 200, pct: 91.5 },
    },
    sast: {
      scanner: 'semgrep',
      version: '1.88.0',
      findings: [],
      counts: { Critical: 0, High: 0, Medium: 0, Low: 0 },
      errors: [],
    },
    supplyChain: {
      version: '1.0.0',
      findings: [],
      counts: { Critical: 0, High: 0, Medium: 0, Low: 0 },
      exceptions: [],
    },
    dast: {
      version: '1.0.0',
      scanner: 'zap',
      exitCode: 0,
      crashed: false,
      timedOut: false,
      authFailure: false,
      endpointsChecked: 24,
      findings: [],
      counts: { Critical: 0, High: 0, Medium: 0, Low: 0 },
    },
    detectorCorpus: {
      version: '1.0.0',
      stages: {
        input: { tp: 100, fn: 0, fp: 2, tn: 248, tpr: 1.0, fpr: 0.008 },
        tool: { tp: 50, fn: 0, fp: 1, tn: 124, tpr: 1.0, fpr: 0.008 },
        output: { tp: 50, fn: 0, fp: 1, tn: 124, tpr: 1.0, fpr: 0.008 },
      },
      aggregate: { tp: 200, fn: 0, fp: 4, tn: 496, tpr: 1.0, fpr: 0.008 },
      stageReachability: {
        upstreamBlocksAsDownstreamTp: 0,
        missingStageMarkers: 0,
        incompleteRuns: 0,
      },
    },
    invariantCorpus: {
      version: '1.0.0',
      total: 35,
      passed: 35,
      failed: 0,
      passRate: 1.0,
      cases: [
        { id: 'inv-auth-001', expectedOutcome: 'BLOCK', actualOutcome: 'BLOCK', passed: true },
      ],
    },
  };
}

function writeFixtureDirectory(dir, fixture = createCleanFixtureReports()) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'coverage.json'), JSON.stringify(fixture.coverage, null, 2), 'utf8');
  writeFileSync(join(dir, 'sast.json'), JSON.stringify(fixture.sast, null, 2), 'utf8');
  writeFileSync(join(dir, 'supply-chain.json'), JSON.stringify(fixture.supplyChain, null, 2), 'utf8');
  writeFileSync(join(dir, 'dast.json'), JSON.stringify(fixture.dast, null, 2), 'utf8');
  writeFileSync(join(dir, 'detector-corpus.json'), JSON.stringify(fixture.detectorCorpus, null, 2), 'utf8');
  writeFileSync(join(dir, 'invariant-corpus.json'), JSON.stringify(fixture.invariantCorpus, null, 2), 'utf8');
}

test('evaluateSecurityResults: clean synthetic reports fixture passes with exit code 0', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'sec-eval-clean-'));
  try {
    writeFixtureDirectory(tempDir);
    const result = evaluateSecurityResults({ directory: tempDir, currentDate: EVAL_DATE });
    assert.equal(result.passed, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.errors.length, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('evaluateSecurityResults: missing report files fails closed with exit code 1', () => {
  const requiredFiles = [
    'coverage.json',
    'sast.json',
    'supply-chain.json',
    'dast.json',
    'detector-corpus.json',
    'invariant-corpus.json',
  ];

  for (const missingFile of requiredFiles) {
    const tempDir = mkdtempSync(join(tmpdir(), 'sec-eval-missing-'));
    try {
      writeFixtureDirectory(tempDir);
      rmSync(join(tempDir, missingFile), { force: true });

      const result = evaluateSecurityResults({ directory: tempDir, currentDate: EVAL_DATE });
      assert.equal(result.passed, false, `Expected failure when ${missingFile} is missing`);
      assert.equal(result.exitCode, 1);
      assert.ok(
        result.errors.some((err) => err.toLowerCase().includes(missingFile.toLowerCase()) || err.toLowerCase().includes('missing')),
        `Expected missing report error for ${missingFile}, got: ${JSON.stringify(result.errors)}`,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

test('evaluateCoverage: statement < 95% or branch < 90% fails', () => {
  // Statement coverage failure
  const lowStatement = {
    statementCoverage: 94.9,
    branchCoverage: 92.0,
  };
  const resLowStmt = evaluateCoverage(lowStatement);
  assert.equal(resLowStmt.passed, false);
  assert.ok(resLowStmt.errors.some((e) => e.includes('statement')));

  // Branch coverage failure
  const lowBranch = {
    statementCoverage: 96.0,
    branchCoverage: 89.9,
  };
  const resLowBranch = evaluateCoverage(lowBranch);
  assert.equal(resLowBranch.passed, false);
  assert.ok(resLowBranch.errors.some((e) => e.includes('branch')));

  // Cobertura XML format
  const xmlPassing = `<?xml version="1.0" ?>
  <coverage version="7.1.0" line-rate="0.955" branch-rate="0.920" lines-covered="955" lines-valid="1000" branches-covered="92" branches-valid="100">
  </coverage>`;
  const resXmlPass = evaluateCoverage(xmlPassing);
  assert.equal(resXmlPass.passed, true);
  assert.equal(resXmlPass.metrics.statementCoverage, 95.5);
  assert.equal(resXmlPass.metrics.branchCoverage, 92.0);

  const xmlFailing = `<?xml version="1.0" ?>
  <coverage version="7.1.0" line-rate="0.930" branch-rate="0.880">
  </coverage>`;
  const resXmlFail = evaluateCoverage(xmlFailing);
  assert.equal(resXmlFail.passed, false);
});

test('evaluateSast: Critical/High findings or scanner execution error fails', () => {
  // Critical finding
  const sastCrit = {
    findings: [{ ruleId: 'rule-1', severity: 'Critical', file: 'apps/agent/src/test.py' }],
    counts: { Critical: 1, High: 0 },
  };
  const resCrit = evaluateSast(sastCrit);
  assert.equal(resCrit.passed, false);
  assert.ok(resCrit.errors.some((e) => e.includes('Critical')));

  // High finding
  const sastHigh = {
    findings: [{ ruleId: 'rule-2', severity: 'High', file: 'apps/api/src/test.ts' }],
    counts: { Critical: 0, High: 1 },
  };
  const resHigh = evaluateSast(sastHigh);
  assert.equal(resHigh.passed, false);
  assert.ok(resHigh.errors.some((e) => e.includes('High')));

  // Medium and Low only passes
  const sastMed = {
    findings: [{ ruleId: 'rule-3', severity: 'Medium' }, { ruleId: 'rule-4', severity: 'Low' }],
    counts: { Critical: 0, High: 0, Medium: 1, Low: 1 },
  };
  const resMed = evaluateSast(sastMed);
  assert.equal(resMed.passed, true);

  // Semgrep SARIF format with error level
  const sastSarif = {
    version: '2.1.0',
    runs: [
      {
        tool: { driver: { name: 'Semgrep' } },
        results: [
          {
            ruleId: 'python.lang.security.deserialization',
            level: 'error',
            message: { text: 'Insecure deserialization' },
          },
        ],
      },
    ],
  };
  const resSarif = evaluateSast(sastSarif);
  assert.equal(resSarif.passed, false);

  // Scanner execution error fails
  const sastScannerErr = {
    findings: [],
    counts: { Critical: 0, High: 0 },
    errors: [{ message: 'Semgrep failed parsing syntax' }],
  };
  const resScannerErr = evaluateSast(sastScannerErr);
  assert.equal(resScannerErr.passed, false);
  assert.ok(resScannerErr.errors.some((e) => e.includes('error') || e.includes('Scanner')));
});

test('evaluateSupplyChain: Critical/High findings and expired exceptions fail', () => {
  // Critical finding
  const scCrit = {
    findings: [{ id: 'GHSA-1234', severity: 'Critical', package: 'urllib3' }],
    exceptions: [],
  };
  const resCrit = evaluateSupplyChain(scCrit, { currentDate: EVAL_DATE });
  assert.equal(resCrit.passed, false);

  // Expired exception fails
  const scExpired = {
    findings: [{ id: 'GHSA-9999', severity: 'High', package: 'fastapi' }],
    exceptions: [
      {
        id: 'GHSA-9999',
        fingerprint: 'fp-9999',
        expiry: '2026-09-01T00:00:00Z', // Expired before 2026-09-05
        reason: 'Upstream patch in progress',
      },
    ],
  };
  const resExpired = evaluateSupplyChain(scExpired, { currentDate: EVAL_DATE });
  assert.equal(resExpired.passed, false);
  assert.ok(resExpired.errors.some((e) => e.toLowerCase().includes('expired')));

  // Valid unexpired exception for lower/advisory finding passes
  const scValidException = {
    findings: [{ id: 'GHSA-5555', severity: 'Medium', package: 'requests' }],
    exceptions: [
      {
        id: 'GHSA-5555',
        fingerprint: 'fp-5555',
        expiry: '2026-09-30T00:00:00Z', // Valid until end of month
        reason: 'Compensating control active',
      },
    ],
  };
  const resValid = evaluateSupplyChain(scValidException, { currentDate: EVAL_DATE });
  assert.equal(resValid.passed, true);
});

test('evaluateDast: ZAP exit codes, crashes, timeouts, auth failures, empty scope', () => {
  // High finding in DAST
  const dastHigh = {
    exitCode: 0,
    endpointsChecked: 20,
    findings: [{ ruleId: '10048', severity: 'High' }],
  };
  assert.equal(evaluateDast(dastHigh).passed, false);

  // ZAP exit code 1 (failure)
  const dastCode1 = {
    exitCode: 1,
    endpointsChecked: 20,
    findings: [],
  };
  const resCode1 = evaluateDast(dastCode1);
  assert.equal(resCode1.passed, false);
  assert.ok(resCode1.errors.some((e) => e.includes('1') || e.includes('exit')));

  // ZAP exit code 3 (execution error)
  const dastCode3 = {
    exitCode: 3,
    endpointsChecked: 20,
    findings: [],
  };
  const resCode3 = evaluateDast(dastCode3);
  assert.equal(resCode3.passed, false);
  assert.ok(resCode3.errors.some((e) => e.includes('3') || e.includes('execution error')));

  // Scanner crash
  const dastCrash = {
    exitCode: 0,
    crashed: true,
    endpointsChecked: 20,
  };
  const resCrash = evaluateDast(dastCrash);
  assert.equal(resCrash.passed, false);
  assert.ok(resCrash.errors.some((e) => e.toLowerCase().includes('crash')));

  // Timeout
  const dastTimeout = {
    exitCode: 0,
    timedOut: true,
    endpointsChecked: 20,
  };
  const resTimeout = evaluateDast(dastTimeout);
  assert.equal(resTimeout.passed, false);
  assert.ok(resTimeout.errors.some((e) => e.toLowerCase().includes('timeout')));

  // Auth failure (unexpected 401/403)
  const dastAuthFail = {
    exitCode: 0,
    authFailure: true,
    endpointsChecked: 20,
  };
  const resAuth = evaluateDast(dastAuthFail);
  assert.equal(resAuth.passed, false);
  assert.ok(resAuth.errors.some((e) => e.toLowerCase().includes('auth')));

  // Empty unexpected scope (0 endpoints / 0 tests)
  const dastEmptyScope = {
    exitCode: 0,
    endpointsChecked: 0,
    findings: [],
  };
  const resEmpty = evaluateDast(dastEmptyScope);
  assert.equal(resEmpty.passed, false);
  assert.ok(resEmpty.errors.some((e) => e.toLowerCase().includes('empty') || e.toLowerCase().includes('scope')));
});

test('evaluateDetectorMetrics: TPR < 95% or FPR > 2% fails', () => {
  // Aggregate TPR failure
  const lowAggregateTpr = {
    stages: {
      input: { tp: 94, fn: 6, fp: 2, tn: 248 }, // TPR 94%
      tool: { tp: 50, fn: 0, fp: 1, tn: 124 },
      output: { tp: 50, fn: 0, fp: 1, tn: 124 },
    },
    stageReachability: { upstreamBlocksAsDownstreamTp: 0, missingStageMarkers: 0 },
  };
  const resLowTpr = evaluateDetectorMetrics(lowAggregateTpr);
  assert.equal(resLowTpr.passed, false);
  assert.ok(resLowTpr.errors.some((e) => e.includes('TPR')));

  // Stage-local FPR failure
  const highStageFpr = {
    stages: {
      input: { tp: 100, fn: 0, fp: 2, tn: 248 },
      tool: { tp: 50, fn: 0, fp: 4, tn: 121 }, // FPR 4 / 125 = 3.2%
      output: { tp: 50, fn: 0, fp: 1, tn: 124 },
    },
    stageReachability: { upstreamBlocksAsDownstreamTp: 0, missingStageMarkers: 0 },
  };
  const resHighFpr = evaluateDetectorMetrics(highStageFpr);
  assert.equal(resHighFpr.passed, false);
  assert.ok(resHighFpr.errors.some((e) => e.includes('FPR') && e.includes('tool')));
});

test('evaluateDetectorMetrics: stage denominators and minimum allocations', () => {
  // Under-allocated input stage: 99 malicious (< 100)
  const underAllocInput = {
    stages: {
      input: { tp: 99, fn: 0, fp: 2, tn: 248 },
      tool: { tp: 50, fn: 0, fp: 1, tn: 124 },
      output: { tp: 50, fn: 0, fp: 1, tn: 124 },
    },
    stageReachability: { upstreamBlocksAsDownstreamTp: 0, missingStageMarkers: 0 },
  };
  const resUnderInput = evaluateDetectorMetrics(underAllocInput);
  assert.equal(resUnderInput.passed, false);
  assert.ok(resUnderInput.errors.some((e) => e.includes('input') && e.includes('denominator')));

  // Empty stage denominator (0 benign)
  const zeroBenign = {
    stages: {
      input: { tp: 100, fn: 0, fp: 0, tn: 0 },
      tool: { tp: 50, fn: 0, fp: 1, tn: 124 },
      output: { tp: 50, fn: 0, fp: 1, tn: 124 },
    },
    stageReachability: { upstreamBlocksAsDownstreamTp: 0, missingStageMarkers: 0 },
  };
  const resZero = evaluateDetectorMetrics(zeroBenign);
  assert.equal(resZero.passed, false);
  assert.ok(resZero.errors.some((e) => e.toLowerCase().includes('empty') || e.toLowerCase().includes('zero')));
});

test('evaluateDetectorMetrics: SEC28 stage-reachability and upstream blocks', () => {
  // Upstream block credited as downstream TP
  const upstreamBlockedTp = {
    stages: {
      input: { tp: 100, fn: 0, fp: 2, tn: 248 },
      tool: { tp: 50, fn: 0, fp: 1, tn: 124 },
      output: { tp: 50, fn: 0, fp: 1, tn: 124 },
    },
    stageReachability: {
      upstreamBlocksAsDownstreamTp: 2,
      missingStageMarkers: 0,
      incompleteRuns: 0,
    },
  };
  const resUpstream = evaluateDetectorMetrics(upstreamBlockedTp);
  assert.equal(resUpstream.passed, false);
  assert.ok(
    resUpstream.errors.some((e) => e.includes('SEC28') || e.toLowerCase().includes('upstream')),
  );

  // Missing reachedStageMarker for tool/output
  const missingMarkers = {
    stages: {
      input: { tp: 100, fn: 0, fp: 2, tn: 248 },
      tool: { tp: 50, fn: 0, fp: 1, tn: 124 },
      output: { tp: 50, fn: 0, fp: 1, tn: 124 },
    },
    stageReachability: {
      upstreamBlocksAsDownstreamTp: 0,
      missingStageMarkers: 3,
      incompleteRuns: 0,
    },
  };
  const resMarkers = evaluateDetectorMetrics(missingMarkers);
  assert.equal(resMarkers.passed, false);
  assert.ok(
    resMarkers.errors.some((e) => e.toLowerCase().includes('marker') || e.toLowerCase().includes('reachability')),
  );
});

test('evaluateInvariants: 100% pass requirement, 0 failures allowed', () => {
  // 1 failure out of 50
  const invWithFailure = {
    total: 50,
    passed: 49,
    failed: 1,
    passRate: 0.98,
    cases: [{ id: 'inv-fence-001', passed: false }],
  };
  const resFail = evaluateInvariants(invWithFailure);
  assert.equal(resFail.passed, false);
  assert.ok(resFail.errors.some((e) => e.includes('100%') || e.includes('failed')));

  // 100% pass rate
  const invClean = {
    total: 50,
    passed: 50,
    failed: 0,
    passRate: 1.0,
  };
  const resClean = evaluateInvariants(invClean);
  assert.equal(resClean.passed, true);

  // Empty scope (0 total)
  const invEmpty = {
    total: 0,
    passed: 0,
    failed: 0,
    passRate: 1.0,
  };
  const resEmpty = evaluateInvariants(invEmpty);
  assert.equal(resEmpty.passed, false);
  assert.ok(resEmpty.errors.some((e) => e.toLowerCase().includes('empty')));
});

test('verifyShardUnion: covers all required case IDs without omissions', () => {
  const manifest = {
    totalShards: 2,
    shards: [
      { shardIndex: 0, caseIds: ['case-001', 'case-002', 'case-003'] },
      { shardIndex: 1, caseIds: ['case-004', 'case-005'] },
    ],
    requiredCaseIds: ['case-001', 'case-002', 'case-003', 'case-004', 'case-005'],
  };
  const resClean = verifyShardUnion(manifest);
  assert.equal(resClean.valid, true);
  assert.equal(resClean.errors.length, 0);

  // Missing case in union
  const manifestMissing = {
    totalShards: 2,
    shards: [
      { shardIndex: 0, caseIds: ['case-001', 'case-002'] },
      { shardIndex: 1, caseIds: ['case-004', 'case-005'] },
    ],
    requiredCaseIds: ['case-001', 'case-002', 'case-003', 'case-004', 'case-005'],
  };
  const resMissing = verifyShardUnion(manifestMissing);
  assert.equal(resMissing.valid, false);
  assert.ok(resMissing.errors.some((e) => e.includes('case-003')));
});

test('validateReportSchemas: rejects malformed reports', () => {
  const malformed = {
    coverage: null,
    sast: 'not-an-object',
    supplyChain: {},
    dast: {},
    detectorCorpus: {},
    invariantCorpus: {},
  };
  const res = validateReportSchemas(malformed);
  assert.equal(res.valid, false);
  assert.ok(res.errors.length >= 2);
});

test('CLI execution via spawnSync', () => {
  const tempDirPass = mkdtempSync(join(tmpdir(), 'sec-eval-cli-pass-'));
  const tempDirFail = mkdtempSync(join(tmpdir(), 'sec-eval-cli-fail-'));

  try {
    // 1. Clean run -> exit code 0
    writeFixtureDirectory(tempDirPass);
    const runPass = spawnSync(process.execPath, [evaluatorCliPath, '--directory', tempDirPass, '--date', EVAL_DATE], {
      encoding: 'utf8',
      cwd: repoRoot,
    });
    assert.equal(runPass.status, 0, `CLI should exit 0, got ${runPass.status}. stderr: ${runPass.stderr}`);
    assert.ok(runPass.stdout.includes('PASSED') || runPass.stdout.includes('passed') || runPass.stdout.includes('Verdict'));

    // 2. Policy failure -> exit code 1
    const badFixture = createCleanFixtureReports();
    badFixture.sast.counts.Critical = 1;
    badFixture.sast.findings.push({ severity: 'Critical', ruleId: 'hardcoded-key' });
    writeFixtureDirectory(tempDirFail, badFixture);

    const runFail = spawnSync(process.execPath, [evaluatorCliPath, '--directory', tempDirFail, '--date', EVAL_DATE], {
      encoding: 'utf8',
      cwd: repoRoot,
    });
    assert.equal(runFail.status, 1, `CLI should exit 1 on policy failure, got ${runFail.status}`);
  } finally {
    rmSync(tempDirPass, { recursive: true, force: true });
    rmSync(tempDirFail, { recursive: true, force: true });
  }
});

test('verifyShardUnion: duplicate case ID across shards fails closed', () => {
  const manifest = {
    totalShards: 2,
    shards: [
      { shardIndex: 0, caseIds: ['case-001', 'case-002'] },
      { shardIndex: 1, caseIds: ['case-002', 'case-003'] },
    ],
    requiredCaseIds: ['case-001', 'case-002', 'case-003'],
  };
  const res = verifyShardUnion(manifest);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => e === 'Duplicate case ID across shards: case-002'));
});

test('evaluateDetectorMetrics: missing stageReachability fails closed', () => {
  const missingSr = {
    stages: {
      input: { tp: 100, fn: 0, fp: 2, tn: 248 },
      tool: { tp: 50, fn: 0, fp: 1, tn: 124 },
      output: { tp: 50, fn: 0, fp: 1, tn: 124 },
    },
  };
  const res = evaluateDetectorMetrics(missingSr);
  assert.equal(res.passed, false);
  assert.ok(res.errors.includes('Missing stageReachability in detector report'));
});

test('evaluateDast: missing exitCode fails closed', () => {
  const missingExit = {
    endpointsChecked: 20,
    findings: [],
  };
  const res = evaluateDast(missingExit);
  assert.equal(res.passed, false);
  assert.ok(res.errors.includes('Missing exitCode in DAST report'));
});

test('evaluateSast: active findings cannot be bypassed by bogus counts', () => {
  const sastBypassAttempt = {
    findings: [{ ruleId: 'sqli-injection', severity: 'Critical', file: 'apps/api/src/db.ts' }],
    counts: { Critical: 0, High: 0 },
  };
  const res = evaluateSast(sastBypassAttempt);
  assert.equal(res.passed, false);
  assert.equal(res.counts.Critical, 1);
  assert.ok(res.errors.some((e) => e.includes('Critical')));
});

test('evaluateSupplyChain: active findings cannot be bypassed by bogus counts', () => {
  const scBypassAttempt = {
    findings: [{ id: 'GHSA-crit-01', severity: 'Critical', package: 'insecure-pkg' }],
    counts: { Critical: 0, High: 0 },
    exceptions: [],
  };
  const res = evaluateSupplyChain(scBypassAttempt, { currentDate: EVAL_DATE });
  assert.equal(res.passed, false);
  assert.equal(res.counts.Critical, 1);
  assert.ok(res.errors.some((e) => e.includes('Critical')));
});

test('evaluateDast: active findings cannot be bypassed by bogus counts', () => {
  const dastBypassAttempt = {
    exitCode: 0,
    endpointsChecked: 20,
    findings: [{ ruleId: '10048', severity: 'Critical' }],
    counts: { Critical: 0, High: 0 },
  };
  const res = evaluateDast(dastBypassAttempt);
  assert.equal(res.passed, false);
  assert.equal(res.metrics.criticalCount, 1);
  assert.ok(res.errors.some((e) => e.includes('Critical')));
});

test('validateReportSchemas and evaluateSecurityResults: missing report version fails closed', () => {
  const required = ['coverage', 'sast', 'supplyChain', 'dast', 'detectorCorpus', 'invariantCorpus'];
  for (const reportKey of required) {
    const fixture = createCleanFixtureReports();
    delete fixture[reportKey].version;

    const schemaRes = validateReportSchemas(fixture);
    assert.equal(schemaRes.valid, false, `Expected schema invalid when ${reportKey}.version is missing`);
    assert.ok(
      schemaRes.errors.some((e) => e.includes(reportKey) && e.includes('version')),
      `Expected error about missing version for ${reportKey}`,
    );

    const tempDir = mkdtempSync(join(tmpdir(), `sec-eval-missing-ver-${reportKey}-`));
    try {
      writeFixtureDirectory(tempDir, fixture);
      const evalRes = evaluateSecurityResults({ directory: tempDir, currentDate: EVAL_DATE });
      assert.equal(evalRes.passed, false);
      assert.equal(evalRes.exitCode, 1);
      assert.ok(evalRes.errors.some((e) => e.toLowerCase().includes('version')));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

test('evaluateSast, evaluateSupplyChain, evaluateDast: empty or version-only reports fail closed', () => {
  // SAST empty/version-only
  const sastEmpty = { version: '1.88.0' };
  const sastRes = evaluateSast(sastEmpty);
  assert.equal(sastRes.passed, false);
  assert.ok(
    sastRes.errors.includes('[SAST Error] Missing scanner execution evidence (runs, findings, results, or counts required)'),
  );

  // Supply Chain empty/version-only
  const scEmpty = { version: '1.0.0' };
  const scRes = evaluateSupplyChain(scEmpty);
  assert.equal(scRes.passed, false);
  assert.ok(
    scRes.errors.includes('[Supply Chain Error] Missing scanner execution evidence (findings, sub-scanner reports, or counts required)'),
  );

  // DAST empty/version-only
  const dastEmpty = { version: '1.0.0' };
  const dastRes = evaluateDast(dastEmpty);
  assert.equal(dastRes.passed, false);
  assert.ok(
    dastRes.errors.includes('[DAST Error] Missing scanner execution evidence (findings or counts required)'),
  );
  assert.ok(
    dastRes.errors.includes('[DAST Failure] Unknown test scope: endpointsChecked, routesChecked, or totalTests must be specified'),
  );
});

test('evaluateDast: missing scope fails closed', () => {
  // Missing scope entirely
  const dastMissingScope = {
    exitCode: 0,
    findings: [],
  };
  const resMissing = evaluateDast(dastMissingScope);
  assert.equal(resMissing.passed, false);
  assert.ok(
    resMissing.errors.includes('[DAST Failure] Unknown test scope: endpointsChecked, routesChecked, or totalTests must be specified'),
  );

  // Empty scope (0)
  const dastZeroScope = {
    exitCode: 0,
    endpointsChecked: 0,
    findings: [],
  };
  const resZero = evaluateDast(dastZeroScope);
  assert.equal(resZero.passed, false);
  assert.ok(
    resZero.errors.includes('[DAST Failure] Empty unexpected test scope: 0 endpoints/routes checked'),
  );

  // Negative scope (-5)
  const dastNegScope = {
    exitCode: 0,
    endpointsChecked: -5,
    findings: [],
  };
  const resNeg = evaluateDast(dastNegScope);
  assert.equal(resNeg.passed, false);
  assert.ok(
    resNeg.errors.includes('[DAST Failure] Empty unexpected test scope: 0 endpoints/routes checked'),
  );

  // Non-integer scope (2.5)
  const dastFloatScope = {
    exitCode: 0,
    endpointsChecked: 2.5,
    findings: [],
  };
  const resFloat = evaluateDast(dastFloatScope);
  assert.equal(resFloat.passed, false);
  assert.ok(
    resFloat.errors.includes('[DAST Failure] Empty unexpected test scope: 0 endpoints/routes checked'),
  );
});

test('evaluateDetectorMetrics: contradictory aggregate counts fail closed', () => {
  const detectorContradictory = {
    stages: {
      input: { tp: 100, fn: 0, fp: 2, tn: 248 },
      tool: { tp: 50, fn: 0, fp: 1, tn: 124 },
      output: { tp: 50, fn: 0, fp: 1, tn: 124 },
    },
    // Derived sums are: tp: 200, fn: 0, fp: 4, tn: 496. Aggregate provides contradictory tp: 250
    aggregate: { tp: 250, fn: 0, fp: 4, tn: 496 },
    stageReachability: {
      upstreamBlocksAsDownstreamTp: 0,
      missingStageMarkers: 0,
      incompleteRuns: 0,
    },
  };

  const res = evaluateDetectorMetrics(detectorContradictory);
  assert.equal(res.passed, false);
  assert.ok(
    res.errors.includes(
      '[Detector Metric Failure] Aggregate counts contradict per-stage sums: derived (tp=200, fn=0, fp=4, tn=496) vs aggregate (tp=250, fn=0, fp=4, tn=496)',
    ),
  );
  // Derived counts should still be used for aggregate metrics
  assert.equal(res.metrics.aggregate.tp, 200);
});

test('evaluateSecurityResults: missing explicitly provided manifest path fails closed', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'sec-eval-manifest-missing-'));
  try {
    writeFixtureDirectory(tempDir);
    const nonExistentManifest = join(tempDir, 'does-not-exist-manifest.json');

    const res = evaluateSecurityResults({
      directory: tempDir,
      manifest: nonExistentManifest,
      currentDate: EVAL_DATE,
    });
    assert.equal(res.passed, false);
    assert.equal(res.exitCode, 1);
    assert.ok(
      res.errors.includes(`[Shard Manifest Error] Specified manifest file does not exist: ${nonExistentManifest}`),
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('verifyShardUnion: empty manifest {} fails closed', () => {
  const res = verifyShardUnion({});
  assert.equal(res.valid, false);
  assert.ok(
    res.errors.includes('[Shard Union Error] Manifest must specify totalShards as a positive integer >= 1'),
  );
  assert.ok(
    res.errors.includes('[Shard Union Error] Manifest missing shards array or contains 0 shards'),
  );
  assert.ok(
    res.errors.includes('[Shard Union Error] Manifest missing requiredCaseIds array or contains 0 required cases'),
  );
});

test('evaluateDetectorMetrics: negative or non-integer stage counts fail closed', () => {
  // Negative stage count
  const negCounts = {
    stages: {
      input: { tp: -10, fn: 0, fp: 2, tn: 248 },
      tool: { tp: 50, fn: 0, fp: 1, tn: 124 },
      output: { tp: 50, fn: 0, fp: 1, tn: 124 },
    },
    stageReachability: {
      upstreamBlocksAsDownstreamTp: 0,
      missingStageMarkers: 0,
      incompleteRuns: 0,
    },
  };
  const resNeg = evaluateDetectorMetrics(negCounts);
  assert.equal(resNeg.passed, false);
  assert.ok(
    resNeg.errors.includes('[Detector Corpus Failure] Stage "input" counts must be non-negative integers'),
  );

  // Non-integer stage count
  const floatCounts = {
    stages: {
      input: { tp: 100, fn: 0, fp: 2, tn: 248 },
      tool: { tp: 50.5, fn: 0, fp: 1, tn: 124 },
      output: { tp: 50, fn: 0, fp: 1, tn: 124 },
    },
    stageReachability: {
      upstreamBlocksAsDownstreamTp: 0,
      missingStageMarkers: 0,
      incompleteRuns: 0,
    },
  };
  const resFloat = evaluateDetectorMetrics(floatCounts);
  assert.equal(resFloat.passed, false);
  assert.ok(
    resFloat.errors.includes('[Detector Corpus Failure] Stage "tool" counts must be non-negative integers'),
  );
});

test('evaluateInvariants: negative or contradictory counts fail closed', () => {
  // Negative count
  const negInv = {
    total: 35,
    passed: -1,
    failed: 36,
  };
  const resNeg = evaluateInvariants(negInv);
  assert.equal(resNeg.passed, false);
  assert.ok(
    resNeg.errors.includes('[Invariant Corpus Failure] Invariant counts must be non-negative integers'),
  );

  // Non-integer count
  const floatInv = {
    total: 35.5,
    passed: 35.5,
    failed: 0,
  };
  const resFloat = evaluateInvariants(floatInv);
  assert.equal(resFloat.passed, false);
  assert.ok(
    resFloat.errors.includes('[Invariant Corpus Failure] Invariant counts must be non-negative integers'),
  );

  // Contradictory counts (passed + failed !== total)
  const contradictoryInv = {
    total: 35,
    passed: 34,
    failed: 0,
  };
  const resContradictory = evaluateInvariants(contradictoryInv);
  assert.equal(resContradictory.passed, false);
  assert.ok(
    resContradictory.errors.includes(
      '[Invariant Corpus Failure] Invariant counts contradictory: passed (34) + failed (0) !== total (35)',
    ),
  );
});

test('evaluateSast, evaluateSupplyChain, evaluateDast: negative or non-integer explicit counts fail closed', () => {
  // SAST negative explicit count
  const sastBad = {
    findings: [],
    counts: { Critical: -1, High: 0 },
  };
  const resSast = evaluateSast(sastBad);
  assert.equal(resSast.passed, false);
  assert.ok(
    resSast.errors.includes('[SAST Error] Explicit count for "Critical" must be a non-negative integer'),
  );

  // Supply Chain non-integer explicit count
  const scBad = {
    findings: [],
    counts: { Critical: 1.5, High: 0 },
  };
  const resSc = evaluateSupplyChain(scBad);
  assert.equal(resSc.passed, false);
  assert.ok(
    resSc.errors.includes('[Supply Chain Error] Explicit count for "Critical" must be a non-negative integer'),
  );

  // DAST negative explicit count
  const dastBad = {
    exitCode: 0,
    endpointsChecked: 20,
    findings: [],
    counts: { High: -2 },
  };
  const resDast = evaluateDast(dastBad);
  assert.equal(resDast.passed, false);
  assert.ok(
    resDast.errors.includes('[DAST Error] Explicit count for "High" must be a non-negative integer'),
  );
});

test('hasValidSeverityCounts and validateExplicitCounts: validator unit behavior', () => {
  // hasValidSeverityCounts invalid inputs
  assert.equal(hasValidSeverityCounts(null), false);
  assert.equal(hasValidSeverityCounts(undefined), false);
  assert.equal(hasValidSeverityCounts('invalid'), false);
  assert.equal(hasValidSeverityCounts([]), false);
  assert.equal(hasValidSeverityCounts({}), false);
  assert.equal(hasValidSeverityCounts({ High: 0 }), false);
  assert.equal(hasValidSeverityCounts({ Critical: 0 }), false);
  assert.equal(hasValidSeverityCounts({ Critical: -1, High: 0 }), false);
  assert.equal(hasValidSeverityCounts({ Critical: 0, High: -1 }), false);
  assert.equal(hasValidSeverityCounts({ Critical: 1.5, High: 0 }), false);
  assert.equal(hasValidSeverityCounts({ Critical: 0, High: '0' }), false);
  assert.equal(hasValidSeverityCounts({ critical: 1 }), false);
  assert.equal(hasValidSeverityCounts({ Critical: 0, High: 0, unrelated: 0 }), false);
  assert.equal(hasValidSeverityCounts({ Critical: 0, High: 0, Medium: -1 }), false);
  assert.equal(hasValidSeverityCounts({ Critical: 0, High: 0, Low: 2.5 }), false);

  // hasValidSeverityCounts valid inputs
  assert.equal(hasValidSeverityCounts({ Critical: 0, High: 0 }), true);
  assert.equal(
    hasValidSeverityCounts({
      Critical: 1,
      High: 2,
      Medium: 3,
      Low: 4,
      Informational: 5,
      Info: 6,
    }),
    true,
  );

  // validateExplicitCounts behavior
  assert.deepEqual(validateExplicitCounts(undefined, 'TEST'), []);
  assert.deepEqual(validateExplicitCounts(null, 'TEST'), ['[TEST Error] Explicit counts must be an object']);
  assert.deepEqual(validateExplicitCounts('str', 'TEST'), ['[TEST Error] Explicit counts must be an object']);
  assert.deepEqual(validateExplicitCounts([1, 2], 'TEST'), ['[TEST Error] Explicit counts must be an object']);

  const emptyRes = validateExplicitCounts({}, 'TEST');
  assert.deepEqual(emptyRes, [
    '[TEST Error] Explicit counts must specify non-negative integer for "Critical"',
    '[TEST Error] Explicit counts must specify non-negative integer for "High"',
  ]);

  const wrongCaseRes = validateExplicitCounts({ critical: 1 }, 'TEST');
  assert.deepEqual(wrongCaseRes, [
    '[TEST Error] Unrecognized count key "critical" in counts. Expected severity keys: Critical, High, Medium, Low, Informational',
    '[TEST Error] Explicit counts must specify non-negative integer for "Critical"',
    '[TEST Error] Explicit counts must specify non-negative integer for "High"',
  ]);

  const unrelatedRes = validateExplicitCounts({ unrelated: 0 }, 'TEST');
  assert.deepEqual(unrelatedRes, [
    '[TEST Error] Unrecognized count key "unrelated" in counts. Expected severity keys: Critical, High, Medium, Low, Informational',
    '[TEST Error] Explicit counts must specify non-negative integer for "Critical"',
    '[TEST Error] Explicit counts must specify non-negative integer for "High"',
  ]);

  const validRes = validateExplicitCounts({ Critical: 0, High: 0 }, 'TEST');
  assert.deepEqual(validRes, []);
});

test('evaluateSast: comprehensive malformed and valid counts handling', () => {
  // counts: { critical: 1 } (wrong casing, no findings)
  const resWrongCasing = evaluateSast({ counts: { critical: 1 } });
  assert.equal(resWrongCasing.passed, false);
  assert.ok(
    resWrongCasing.errors.includes(
      '[SAST Error] Missing scanner execution evidence (runs, findings, results, or counts required)',
    ),
  );
  assert.ok(
    resWrongCasing.errors.some((e) =>
      e.includes('Unrecognized count key "critical" in counts. Expected severity keys: Critical, High, Medium, Low, Informational'),
    ),
  );
  assert.ok(
    resWrongCasing.errors.includes('[SAST Error] Explicit counts must specify non-negative integer for "Critical"'),
  );
  assert.ok(
    resWrongCasing.errors.includes('[SAST Error] Explicit counts must specify non-negative integer for "High"'),
  );

  // counts: {} (empty, no findings)
  const resEmpty = evaluateSast({ counts: {} });
  assert.equal(resEmpty.passed, false);
  assert.ok(
    resEmpty.errors.includes(
      '[SAST Error] Missing scanner execution evidence (runs, findings, results, or counts required)',
    ),
  );
  assert.ok(
    resEmpty.errors.includes('[SAST Error] Explicit counts must specify non-negative integer for "Critical"'),
  );
  assert.ok(
    resEmpty.errors.includes('[SAST Error] Explicit counts must specify non-negative integer for "High"'),
  );

  // counts: { unrelated: 0 } (unrelated keys, no findings)
  const resUnrelated = evaluateSast({ counts: { unrelated: 0 } });
  assert.equal(resUnrelated.passed, false);
  assert.ok(
    resUnrelated.errors.includes(
      '[SAST Error] Missing scanner execution evidence (runs, findings, results, or counts required)',
    ),
  );
  assert.ok(
    resUnrelated.errors.some((e) =>
      e.includes('Unrecognized count key "unrelated" in counts. Expected severity keys: Critical, High, Medium, Low, Informational'),
    ),
  );

  // findings: [], counts: { critical: 1 } (has findings evidence but malformed counts)
  const resFindingsWrongCasing = evaluateSast({ findings: [], counts: { critical: 1 } });
  assert.equal(resFindingsWrongCasing.passed, false);
  assert.ok(
    resFindingsWrongCasing.errors.some((e) =>
      e.includes('Unrecognized count key "critical" in counts. Expected severity keys: Critical, High, Medium, Low, Informational'),
    ),
  );
  assert.ok(
    resFindingsWrongCasing.errors.includes(
      '[SAST Error] Explicit counts must specify non-negative integer for "Critical"',
    ),
  );
  assert.ok(
    resFindingsWrongCasing.errors.includes('[SAST Error] Explicit counts must specify non-negative integer for "High"'),
  );

  // findings: [], counts: {} (has findings evidence but empty counts)
  const resFindingsEmpty = evaluateSast({ findings: [], counts: {} });
  assert.equal(resFindingsEmpty.passed, false);
  assert.ok(
    resFindingsEmpty.errors.includes('[SAST Error] Explicit counts must specify non-negative integer for "Critical"'),
  );
  assert.ok(
    resFindingsEmpty.errors.includes('[SAST Error] Explicit counts must specify non-negative integer for "High"'),
  );

  // Valid explicit counts { Critical: 0, High: 0 } with no findings passes
  const resValid = evaluateSast({ findings: [], counts: { Critical: 0, High: 0 } });
  assert.equal(resValid.passed, true);
  assert.equal(resValid.errors.length, 0);
  assert.equal(resValid.counts.Critical, 0);
  assert.equal(resValid.counts.High, 0);

  // Valid counts without findings array passes via counts evidence
  const resValidCountsOnly = evaluateSast({ counts: { Critical: 0, High: 0, Medium: 2, Low: 1 } });
  assert.equal(resValidCountsOnly.passed, true);
  assert.equal(resValidCountsOnly.errors.length, 0);
  assert.equal(resValidCountsOnly.counts.Medium, 2);
  assert.equal(resValidCountsOnly.counts.Low, 1);
});

test('evaluateSupplyChain: comprehensive malformed and valid counts handling', () => {
  // counts: { critical: 1 } (wrong casing, no findings)
  const resWrongCasing = evaluateSupplyChain({ counts: { critical: 1 } });
  assert.equal(resWrongCasing.passed, false);
  assert.ok(
    resWrongCasing.errors.includes(
      '[Supply Chain Error] Missing scanner execution evidence (findings, sub-scanner reports, or counts required)',
    ),
  );
  assert.ok(
    resWrongCasing.errors.some((e) =>
      e.includes('Unrecognized count key "critical" in counts. Expected severity keys: Critical, High, Medium, Low, Informational'),
    ),
  );
  assert.ok(
    resWrongCasing.errors.includes(
      '[Supply Chain Error] Explicit counts must specify non-negative integer for "Critical"',
    ),
  );
  assert.ok(
    resWrongCasing.errors.includes('[Supply Chain Error] Explicit counts must specify non-negative integer for "High"'),
  );

  // counts: {} (empty, no findings)
  const resEmpty = evaluateSupplyChain({ counts: {} });
  assert.equal(resEmpty.passed, false);
  assert.ok(
    resEmpty.errors.includes(
      '[Supply Chain Error] Missing scanner execution evidence (findings, sub-scanner reports, or counts required)',
    ),
  );
  assert.ok(
    resEmpty.errors.includes(
      '[Supply Chain Error] Explicit counts must specify non-negative integer for "Critical"',
    ),
  );
  assert.ok(
    resEmpty.errors.includes('[Supply Chain Error] Explicit counts must specify non-negative integer for "High"'),
  );

  // counts: { unrelated: 0 } (unrelated keys, no findings)
  const resUnrelated = evaluateSupplyChain({ counts: { unrelated: 0 } });
  assert.equal(resUnrelated.passed, false);
  assert.ok(
    resUnrelated.errors.includes(
      '[Supply Chain Error] Missing scanner execution evidence (findings, sub-scanner reports, or counts required)',
    ),
  );
  assert.ok(
    resUnrelated.errors.some((e) =>
      e.includes('Unrecognized count key "unrelated" in counts. Expected severity keys: Critical, High, Medium, Low, Informational'),
    ),
  );

  // findings: [], counts: { critical: 1 } (has findings evidence but malformed counts)
  const resFindingsWrongCasing = evaluateSupplyChain({ findings: [], counts: { critical: 1 } });
  assert.equal(resFindingsWrongCasing.passed, false);
  assert.ok(
    resFindingsWrongCasing.errors.some((e) =>
      e.includes('Unrecognized count key "critical" in counts. Expected severity keys: Critical, High, Medium, Low, Informational'),
    ),
  );
  assert.ok(
    resFindingsWrongCasing.errors.includes(
      '[Supply Chain Error] Explicit counts must specify non-negative integer for "Critical"',
    ),
  );
  assert.ok(
    resFindingsWrongCasing.errors.includes(
      '[Supply Chain Error] Explicit counts must specify non-negative integer for "High"',
    ),
  );

  // findings: [], counts: {} (has findings evidence but empty counts)
  const resFindingsEmpty = evaluateSupplyChain({ findings: [], counts: {} });
  assert.equal(resFindingsEmpty.passed, false);
  assert.ok(
    resFindingsEmpty.errors.includes(
      '[Supply Chain Error] Explicit counts must specify non-negative integer for "Critical"',
    ),
  );
  assert.ok(
    resFindingsEmpty.errors.includes('[Supply Chain Error] Explicit counts must specify non-negative integer for "High"'),
  );

  // Valid explicit counts { Critical: 0, High: 0 } with no findings passes
  const resValid = evaluateSupplyChain({ findings: [], counts: { Critical: 0, High: 0 } });
  assert.equal(resValid.passed, true);
  assert.equal(resValid.errors.length, 0);
  assert.equal(resValid.counts.Critical, 0);
  assert.equal(resValid.counts.High, 0);

  // Valid counts without findings array passes via counts evidence
  const resValidCountsOnly = evaluateSupplyChain({ counts: { Critical: 0, High: 0 } });
  assert.equal(resValidCountsOnly.passed, true);
  assert.equal(resValidCountsOnly.errors.length, 0);
});

test('evaluateDast: comprehensive malformed and valid counts handling', () => {
  const baseDast = { exitCode: 0, endpointsChecked: 24 };

  // counts: { critical: 1 } (wrong casing, no findings)
  const resWrongCasing = evaluateDast({ ...baseDast, counts: { critical: 1 } });
  assert.equal(resWrongCasing.passed, false);
  assert.ok(
    resWrongCasing.errors.includes('[DAST Error] Missing scanner execution evidence (findings or counts required)'),
  );
  assert.ok(
    resWrongCasing.errors.some((e) =>
      e.includes('Unrecognized count key "critical" in counts. Expected severity keys: Critical, High, Medium, Low, Informational'),
    ),
  );
  assert.ok(
    resWrongCasing.errors.includes('[DAST Error] Explicit counts must specify non-negative integer for "Critical"'),
  );
  assert.ok(
    resWrongCasing.errors.includes('[DAST Error] Explicit counts must specify non-negative integer for "High"'),
  );

  // counts: {} (empty, no findings)
  const resEmpty = evaluateDast({ ...baseDast, counts: {} });
  assert.equal(resEmpty.passed, false);
  assert.ok(
    resEmpty.errors.includes('[DAST Error] Missing scanner execution evidence (findings or counts required)'),
  );
  assert.ok(
    resEmpty.errors.includes('[DAST Error] Explicit counts must specify non-negative integer for "Critical"'),
  );
  assert.ok(
    resEmpty.errors.includes('[DAST Error] Explicit counts must specify non-negative integer for "High"'),
  );

  // counts: { unrelated: 0 } (unrelated keys, no findings)
  const resUnrelated = evaluateDast({ ...baseDast, counts: { unrelated: 0 } });
  assert.equal(resUnrelated.passed, false);
  assert.ok(
    resUnrelated.errors.includes('[DAST Error] Missing scanner execution evidence (findings or counts required)'),
  );
  assert.ok(
    resUnrelated.errors.some((e) =>
      e.includes('Unrecognized count key "unrelated" in counts. Expected severity keys: Critical, High, Medium, Low, Informational'),
    ),
  );

  // findings: [], counts: { critical: 1 } (has findings evidence but malformed counts)
  const resFindingsWrongCasing = evaluateDast({ ...baseDast, findings: [], counts: { critical: 1 } });
  assert.equal(resFindingsWrongCasing.passed, false);
  assert.ok(
    resFindingsWrongCasing.errors.some((e) =>
      e.includes('Unrecognized count key "critical" in counts. Expected severity keys: Critical, High, Medium, Low, Informational'),
    ),
  );
  assert.ok(
    resFindingsWrongCasing.errors.includes(
      '[DAST Error] Explicit counts must specify non-negative integer for "Critical"',
    ),
  );
  assert.ok(
    resFindingsWrongCasing.errors.includes('[DAST Error] Explicit counts must specify non-negative integer for "High"'),
  );

  // findings: [], counts: {} (has findings evidence but empty counts)
  const resFindingsEmpty = evaluateDast({ ...baseDast, findings: [], counts: {} });
  assert.equal(resFindingsEmpty.passed, false);
  assert.ok(
    resFindingsEmpty.errors.includes('[DAST Error] Explicit counts must specify non-negative integer for "Critical"'),
  );
  assert.ok(
    resFindingsEmpty.errors.includes('[DAST Error] Explicit counts must specify non-negative integer for "High"'),
  );

  // Valid explicit counts { Critical: 0, High: 0 } with no findings passes
  const resValid = evaluateDast({ ...baseDast, findings: [], counts: { Critical: 0, High: 0 } });
  assert.equal(resValid.passed, true);
  assert.equal(resValid.errors.length, 0);
  assert.equal(resValid.metrics.criticalCount, 0);
  assert.equal(resValid.metrics.highCount, 0);

  // Valid counts without findings array passes via counts evidence
  const resValidCountsOnly = evaluateDast({ ...baseDast, counts: { Critical: 0, High: 0 } });
  assert.equal(resValidCountsOnly.passed, true);
  assert.equal(resValidCountsOnly.errors.length, 0);
});


