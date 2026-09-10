import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { redactSensitiveText, stripDisallowedFields } from './write-report.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const defaultRepoRoot = resolve(__dirname, '..', '..');

export const SEVERITY_LEVELS = ['Critical', 'High', 'Medium', 'Low', 'Informational'];

export function createEmptySeverityCounts() {
  return { Critical: 0, High: 0, Medium: 0, Low: 0, Informational: 0 };
}

export function normalizeSeverity(rawSev) {
  const s = String(rawSev || '').toLowerCase();
  if (s.includes('crit')) return 'Critical';
  if (s.includes('high') || s === 'error') return 'High';
  if (s.includes('med') || s === 'warning' || s === 'moderate') return 'Medium';
  if (s.includes('low')) return 'Low';
  return 'Informational';
}

export function computeFindingFingerprint(scanner, target, line, id = '') {
  const normTarget = String(target || '').replaceAll('\\', '/');
  return createHash('sha256')
    .update(`${scanner || ''}:${normTarget}:${line || 1}:${id || ''}`)
    .digest('hex');
}

/**
 * Deeply redacts sensitive strings across an object or array.
 */
export function deepRedact(val) {
  if (typeof val === 'string') {
    return redactSensitiveText(val);
  }
  if (Array.isArray(val)) {
    return val.map(deepRedact);
  }
  if (val !== null && typeof val === 'object') {
    const res = {};
    for (const [k, v] of Object.entries(val)) {
      const lowerKey = k.toLowerCase();
      if (
        lowerKey === 'secret' ||
        lowerKey === 'match' ||
        lowerKey === 'rawpayload' ||
        lowerKey === 'token'
      ) {
        res[k] = '[REDACTED_SECRET]';
      } else {
        res[k] = deepRedact(v);
      }
    }
    return res;
  }
  return val;
}

/**
 * Parses pip-audit JSON output into normalized findings and severity counts.
 */
export function parsePipAuditOutput(rawOutput) {
  let parsed;
  if (typeof rawOutput === 'string') {
    if (!rawOutput.trim()) {
      return {
        counts: { Critical: 0, High: 0, Medium: 0, Low: 0, Informational: 0 },
        findings: [],
      };
    }
    parsed = JSON.parse(rawOutput);
  } else {
    parsed = rawOutput;
  }

  const dependencies = Array.isArray(parsed) ? parsed : parsed?.dependencies || [];
  const findings = [];
  const counts = { Critical: 0, High: 0, Medium: 0, Low: 0, Informational: 0 };

  for (const dep of dependencies) {
    if (!dep || typeof dep !== 'object') continue;
    const vulns = Array.isArray(dep.vulns) ? dep.vulns : [];
    for (const v of vulns) {
      if (!v || typeof v !== 'object') continue;
      const id = v.id || (Array.isArray(v.aliases) && v.aliases[0]) || 'PYSEC-unknown';
      let severity = 'High';
      const rawSev = String(v.severity || '').toLowerCase();
      if (rawSev.includes('crit')) severity = 'Critical';
      else if (rawSev.includes('high')) severity = 'High';
      else if (rawSev.includes('med') || rawSev.includes('mod')) severity = 'Medium';
      else if (rawSev.includes('low')) severity = 'Low';

      counts[severity]++;

      findings.push({
        id,
        ruleId: id,
        severity,
        package: dep.name,
        version: dep.version,
        scanner: 'pip-audit',
        file: 'apps/agent/pyproject.toml',
        line: 1,
        message: redactSensitiveText(
          v.description || `Vulnerability ${id} in ${dep.name}@${dep.version}`,
        ),
        fingerprint: computeFindingFingerprint('pip-audit', dep.name, 1, id),
      });
    }
  }

  return { counts, findings };
}

/**
 * Parses pnpm audit JSON output into normalized findings and severity counts.
 */
export function parsePnpmAuditOutput(rawOutput) {
  let parsed;
  if (typeof rawOutput === 'string') {
    if (!rawOutput.trim()) {
      return {
        counts: { Critical: 0, High: 0, Medium: 0, Low: 0, Informational: 0 },
        findings: [],
      };
    }
    parsed = JSON.parse(rawOutput);
  } else {
    parsed = rawOutput;
  }

  const findings = [];
  const counts = { Critical: 0, High: 0, Medium: 0, Low: 0, Informational: 0 };

  // 1. Advisories map (pnpm / npm v1 format)
  if (parsed.advisories && typeof parsed.advisories === 'object') {
    for (const [advId, adv] of Object.entries(parsed.advisories)) {
      if (!adv || typeof adv !== 'object') continue;
      const id = adv.github_advisory_id || String(adv.id || advId);
      const sevStr = String(adv.severity || '').toLowerCase();
      let severity = 'Medium';
      if (sevStr.includes('crit')) severity = 'Critical';
      else if (sevStr.includes('high')) severity = 'High';
      else if (sevStr.includes('mod') || sevStr.includes('med')) severity = 'Medium';
      else if (sevStr.includes('low')) severity = 'Low';
      else if (sevStr.includes('info')) severity = 'Informational';

      counts[severity]++;

      findings.push({
        id,
        ruleId: id,
        severity,
        package: adv.module_name || 'unknown',
        scanner: 'pnpm-audit',
        file: 'pnpm-lock.yaml',
        line: 1,
        message: redactSensitiveText(
          adv.title || adv.overview || `Advisory ${id} in ${adv.module_name}`,
        ),
        fingerprint: computeFindingFingerprint('pnpm-audit', adv.module_name || 'unknown', 1, id),
      });
    }
  } else if (parsed.vulnerabilities && typeof parsed.vulnerabilities === 'object') {
    // 2. npm v2 format
    for (const [pkgName, vInfo] of Object.entries(parsed.vulnerabilities)) {
      if (!vInfo || typeof vInfo !== 'object') continue;
      const sevStr = String(vInfo.severity || '').toLowerCase();
      let severity = 'Medium';
      if (sevStr.includes('crit')) severity = 'Critical';
      else if (sevStr.includes('high')) severity = 'High';
      else if (sevStr.includes('mod') || sevStr.includes('med')) severity = 'Medium';
      else if (sevStr.includes('low')) severity = 'Low';
      else if (sevStr.includes('info')) severity = 'Informational';

      counts[severity]++;

      const id = `pnpm-${pkgName}`;
      findings.push({
        id,
        ruleId: id,
        severity,
        package: pkgName,
        scanner: 'pnpm-audit',
        file: 'pnpm-lock.yaml',
        line: 1,
        message: redactSensitiveText(`Vulnerable dependency ${pkgName}: ${vInfo.range || ''}`),
        fingerprint: computeFindingFingerprint('pnpm-audit', pkgName, 1, id),
      });
    }
  }

  // Reconcile with metadata.vulnerabilities if findings is empty but metadata counts exist
  if (findings.length === 0 && parsed.metadata?.vulnerabilities) {
    const mv = parsed.metadata.vulnerabilities;
    counts.Critical = Number(mv.critical) || 0;
    counts.High = Number(mv.high) || 0;
    counts.Medium = (Number(mv.moderate) || 0) + (Number(mv.medium) || 0);
    counts.Low = Number(mv.low) || 0;
    counts.Informational = (Number(mv.info) || 0) + (Number(mv.informational) || 0);
  }

  return { counts, findings };
}

/**
 * Parses Gitleaks JSON output into normalized findings and severity counts,
 * enforcing secret redaction invariants.
 */
export function parseGitleaksOutput(rawOutput) {
  let parsed;
  if (typeof rawOutput === 'string') {
    if (!rawOutput.trim()) {
      return {
        counts: { Critical: 0, High: 0, Medium: 0, Low: 0, Informational: 0 },
        findings: [],
      };
    }
    parsed = JSON.parse(rawOutput);
  } else {
    parsed = rawOutput;
  }

  const items = Array.isArray(parsed) ? parsed : [];
  const findings = [];
  const counts = { Critical: 0, High: 0, Medium: 0, Low: 0, Informational: 0 };

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const ruleId = item.RuleID || item.ruleId || 'secret-detected';
    const file = item.File || item.file || 'unknown-file';
    const line = item.StartLine || item.line || 1;
    const desc = item.Description || item.message || 'Hardcoded secret detected';
    const fp =
      item.Fingerprint ||
      item.fingerprint ||
      computeFindingFingerprint('gitleaks', file, line, ruleId);

    const ruleLower = ruleId.toLowerCase();
    let severity = 'High';
    if (
      ruleLower.includes('private-key') ||
      ruleLower.includes('jwt') ||
      ruleLower.includes('aws')
    ) {
      severity = 'Critical';
    }
    counts[severity]++;

    findings.push({
      id: ruleId,
      ruleId,
      severity,
      scanner: 'gitleaks',
      file: redactSensitiveText(file),
      line,
      message: redactSensitiveText(desc),
      fingerprint: fp,
    });
  }

  return { counts, findings };
}

/**
 * Built-in fallback secret scanner across workspaces when Gitleaks is not installed.
 */
export function scanWorkspaceForSecrets(rootDir) {
  const workspaces = ['apps/agent', 'apps/api', 'apps/web', 'packages/shared'];
  const ignoredDirs = new Set([
    'node_modules',
    '.next',
    'dist',
    '.venv',
    '__pycache__',
    '.pytest_cache',
    '.git',
    'fixtures',
    'coverage',
  ]);
  const ignoredExtensions = new Set([
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.ico',
    '.woff',
    '.woff2',
    '.ttf',
    '.eot',
    '.lock',
    '.svg',
    '.cache',
  ]);

  const findings = [];
  const errors = [];
  const counts = { Critical: 0, High: 0, Medium: 0, Low: 0, Informational: 0 };

  const secretPatterns = [
    {
      id: 'private-key',
      severity: 'Critical',
      regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
      description: 'Private encryption key detected',
    },
    {
      id: 'openai-api-key',
      severity: 'High',
      regex: /\bsk-[a-zA-Z0-9_-]{20,}\b/,
      description: 'OpenAI API key pattern detected',
    },
    {
      id: 'google-api-key',
      severity: 'High',
      regex: /\bAIza[a-zA-Z0-9_-]{20,}\b/,
      description: 'Google API key pattern detected',
    },
    {
      id: 'github-token',
      severity: 'High',
      regex: /\b(?:ghp_[a-zA-Z0-9]{30,}|github_pat_[a-zA-Z0-9_]{30,})\b/,
      description: 'GitHub personal access token detected',
    },
  ];

  function walk(currentDir) {
    let entries;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch (err) {
      errors.push(`[Supply Chain Notice] Cannot read directory ${currentDir}: ${err.message}`);
      return;
    }

    for (const entry of entries) {
      if (ignoredDirs.has(entry.name)) continue;
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (ignoredExtensions.has(ext)) continue;
        const relPath = relative(rootDir, fullPath).replaceAll('\\', '/');
        if (
          relPath.includes('tests/') ||
          relPath.includes('test/') ||
          relPath.endsWith('.example')
        ) {
          continue;
        }

        let content;
        try {
          content = readFileSync(fullPath, 'utf8');
        } catch (err) {
          errors.push(`[Supply Chain Notice] Cannot read file ${fullPath}: ${err.message}`);
          continue;
        }

        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          for (const pattern of secretPatterns) {
            const m = line.match(pattern.regex);
            if (m) {
              counts[pattern.severity]++;
              findings.push({
                id: pattern.id,
                ruleId: pattern.id,
                severity: pattern.severity,
                scanner: 'gitleaks',
                file: relPath,
                line: i + 1,
                message: pattern.description,
                fingerprint: computeFindingFingerprint('gitleaks', relPath, i + 1, pattern.id),
              });
            }
          }
        }
      }
    }
  }

  for (const ws of workspaces) {
    const wsPath = resolve(rootDir, ws);
    if (existsSync(wsPath)) {
      walk(wsPath);
    }
  }

  return { counts, findings, errors };
}

/**
 * Runs pip-audit against apps/agent/pyproject.toml or uv.lock.
 */
export function runPipAudit(options = {}) {
  const rootDir = options.rootDir || defaultRepoRoot;
  const execFn = options.execFn || spawnSync;
  const strict = Boolean(options.strict);
  const offline = Boolean(options.offline);
  const errors = [];
  const cacheDir = resolve(rootDir, '.pip-audit-cache');

  if (offline) {
    return {
      timestamp: new Date().toISOString(),
      advisoryDatabaseTimestamp: new Date().toISOString(),
      counts: { Critical: 0, High: 0, Medium: 0, Low: 0, Informational: 0 },
      findings: [],
      errors: [],
      offline: true,
    };
  }

  let cmdRes;
  try {
    cmdRes = execFn(
      'uv',
      ['run', '--package', 'agent', 'pip-audit', '--format', 'json', '--cache-dir', cacheDir],
      {
        cwd: rootDir,
        encoding: 'utf8',
        shell: process.platform === 'win32',
      },
    );
  } catch (err) {
    cmdRes = { error: err };
  }

  const rawOut = cmdRes?.stdout?.trim() || '';
  if (rawOut.startsWith('{') || rawOut.startsWith('[')) {
    try {
      const parsed = parsePipAuditOutput(rawOut);
      return {
        timestamp: new Date().toISOString(),
        advisoryDatabaseTimestamp: new Date().toISOString(),
        counts: parsed.counts,
        findings: parsed.findings,
        errors: [],
      };
    } catch (err) {
      errors.push(`[Supply Chain Error] Failed to parse pip-audit output: ${err.message}`);
    }
  }

  const stderr = (cmdRes?.stderr || '').toLowerCase();
  const isMissingPipAudit =
    !cmdRes ||
    cmdRes.error ||
    cmdRes.status === 127 ||
    stderr.includes('program not found') ||
    stderr.includes('not recognized') ||
    stderr.includes('command not found');

  if (isMissingPipAudit) {
    const errMsg =
      cmdRes?.error?.message || cmdRes?.stderr?.trim() || 'pip-audit not found in environment';
    if (strict) {
      errors.push(`[Supply Chain Error] pip-audit failed to execute: ${errMsg}`);
    } else {
      errors.push(`[Supply Chain Notice] pip-audit unavailable: ${errMsg}`);
    }
  } else if (cmdRes.status !== 0 && !rawOut) {
    const errMsg = cmdRes?.stderr?.trim() || `pip-audit exited with status ${cmdRes.status}`;
    if (strict) {
      errors.push(`[Supply Chain Error] pip-audit failed: ${errMsg}`);
    } else {
      errors.push(`[Supply Chain Notice] pip-audit status notice: ${errMsg}`);
    }
  }

  return {
    timestamp: new Date().toISOString(),
    advisoryDatabaseTimestamp: new Date().toISOString(),
    counts: { Critical: 0, High: 0, Medium: 0, Low: 0, Informational: 0 },
    findings: [],
    errors,
  };
}

/**
 * Runs pnpm audit across workspace dependencies.
 */
export function runPnpmAudit(options = {}) {
  const rootDir = options.rootDir || defaultRepoRoot;
  const execFn = options.execFn || spawnSync;
  const strict = Boolean(options.strict);
  const offline = Boolean(options.offline);
  const errors = [];

  const args = ['audit', '--audit-level', 'moderate', '--json'];
  if (offline) {
    args.push('--ignore-registry-errors');
  }

  let cmdRes;
  try {
    cmdRes = execFn('pnpm', args, {
      cwd: rootDir,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
  } catch (err) {
    cmdRes = { error: err };
  }

  const rawOut = cmdRes?.stdout?.trim() || '';
  if (rawOut.startsWith('{') || rawOut.startsWith('[')) {
    try {
      const parsed = parsePnpmAuditOutput(rawOut);
      return {
        timestamp: new Date().toISOString(),
        advisoryDatabaseTimestamp: new Date().toISOString(),
        counts: parsed.counts,
        findings: parsed.findings,
        errors: [],
      };
    } catch (err) {
      errors.push(`[Supply Chain Error] Failed to parse pnpm audit output: ${err.message}`);
    }
  }

  if (cmdRes?.error || (cmdRes?.status !== 0 && !rawOut)) {
    const errMsg =
      cmdRes?.error?.message ||
      cmdRes?.stderr?.trim() ||
      `pnpm audit exited with status ${cmdRes?.status}`;
    if (strict) {
      errors.push(`[Supply Chain Error] pnpm audit failed to execute: ${errMsg}`);
    } else {
      errors.push(`[Supply Chain Notice] pnpm audit notice: ${errMsg}`);
    }
  }

  return {
    timestamp: new Date().toISOString(),
    advisoryDatabaseTimestamp: new Date().toISOString(),
    counts: { Critical: 0, High: 0, Medium: 0, Low: 0, Informational: 0 },
    findings: [],
    errors,
  };
}

/**
 * Runs secret detection (Gitleaks or fallback).
 */
export function runSecretScan(options = {}) {
  const rootDir = options.rootDir || defaultRepoRoot;
  const execFn = options.execFn || spawnSync;
  const strict = Boolean(options.strict);
  const errors = [];

  let cmdRes;
  try {
    cmdRes = execFn(
      'gitleaks',
      ['detect', '--source', rootDir, '--verbose', '--report-format', 'json', '--redact'],
      {
        cwd: rootDir,
        encoding: 'utf8',
        shell: process.platform === 'win32',
      },
    );
  } catch (err) {
    cmdRes = { error: err };
  }

  const rawOut = cmdRes?.stdout?.trim() || '';
  if (rawOut.startsWith('[') || rawOut.startsWith('{')) {
    try {
      const parsed = parseGitleaksOutput(rawOut);
      return {
        timestamp: new Date().toISOString(),
        counts: parsed.counts,
        findings: parsed.findings,
        errors: [],
      };
    } catch (err) {
      errors.push(`[Secret Scanner Error] Failed to parse gitleaks output: ${err.message}`);
    }
  }

  const stderr = (cmdRes?.stderr || '').toLowerCase();
  const isMissingGitleaks =
    !cmdRes ||
    cmdRes.error ||
    cmdRes.status === 127 ||
    stderr.includes('not recognized') ||
    stderr.includes('command not found') ||
    stderr.includes('cannot find');

  if (isMissingGitleaks) {
    if (strict) {
      const errMsg =
        cmdRes?.error?.message || cmdRes?.stderr?.trim() || 'Gitleaks CLI not found';
      errors.push(`[Secret Scanner Error] Gitleaks CLI not found or failed to execute: ${errMsg}`);
      return {
        timestamp: new Date().toISOString(),
        counts: { Critical: 0, High: 0, Medium: 0, Low: 0, Informational: 0 },
        findings: [],
        errors,
      };
    }

    const fallback = scanWorkspaceForSecrets(rootDir);
    return {
      timestamp: new Date().toISOString(),
      counts: fallback.counts,
      findings: fallback.findings,
      errors: fallback.errors,
      fallbackUsed: true,
    };
  }

  return {
    timestamp: new Date().toISOString(),
    counts: { Critical: 0, High: 0, Medium: 0, Low: 0, Informational: 0 },
    findings: [],
    errors,
  };
}

/**
 * Top-level supply chain and secret scan driver.
 */
export function runSupplyChainScan(options = {}) {
  const rootDir = options.rootDir ? resolve(options.rootDir) : defaultRepoRoot;
  const outputPath = options.output
    ? resolve(options.output)
    : resolve(rootDir, 'artifacts/security/supply-chain.json');
  const strict = Boolean(options.strict);
  const offline = Boolean(options.offline);
  const exceptions = Array.isArray(options.exceptions) ? options.exceptions : [];

  const errors = [];

  // 1. Run pip-audit
  const pipResult = runPipAudit({ rootDir, execFn: options.execFn, strict, offline });
  if (pipResult.errors && pipResult.errors.length > 0) {
    errors.push(...pipResult.errors);
  }

  // 2. Run pnpm audit
  const pnpmResult = runPnpmAudit({ rootDir, execFn: options.execFn, strict, offline });
  if (pnpmResult.errors && pnpmResult.errors.length > 0) {
    errors.push(...pnpmResult.errors);
  }

  // 3. Run secret detection
  const secretResult = runSecretScan({ rootDir, execFn: options.execFn, strict, offline });
  if (secretResult.errors && secretResult.errors.length > 0) {
    errors.push(...secretResult.errors);
  }

  // Combine findings
  const allFindings = [
    ...(pipResult.findings || []),
    ...(pnpmResult.findings || []),
    ...(secretResult.findings || []),
  ];

  // Aggregated severity counts
  const counts = {
    Critical: 0,
    High: 0,
    Medium: 0,
    Low: 0,
    Informational: 0,
  };

  for (const f of allFindings) {
    const sev = f.severity || 'Medium';
    if (sev in counts) {
      counts[sev]++;
    }
  }

  // Format raw report
  const rawReport = {
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    offline,
    counts,
    findings: allFindings,
    pipAudit: {
      timestamp: pipResult.timestamp,
      advisoryDatabaseTimestamp: pipResult.advisoryDatabaseTimestamp,
      counts: pipResult.counts,
      findings: pipResult.findings,
    },
    pnpmAudit: {
      timestamp: pnpmResult.timestamp,
      advisoryDatabaseTimestamp: pnpmResult.advisoryDatabaseTimestamp,
      counts: pnpmResult.counts,
      findings: pnpmResult.findings,
    },
    gitleaks: {
      timestamp: secretResult.timestamp,
      counts: secretResult.counts,
      findings: secretResult.findings,
    },
    exceptions,
    errors,
  };

  // Strip disallowed fields and redact all sensitive strings
  const sanitizedReport = deepRedact(stripDisallowedFields(rawReport));

  // Write report to destination
  try {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, JSON.stringify(sanitizedReport, null, 2) + '\n', 'utf8');
  } catch (err) {
    errors.push(
      `[Supply Chain Output Error] Failed to write report to ${outputPath}: ${err.message}`,
    );
  }

  // Suppression and policy evaluation
  const validExceptionIds = new Set(
    exceptions
      .filter((e) => !e.expiry || Date.parse(e.expiry) > Date.now())
      .map((e) => e.id || e.fingerprint),
  );

  let unsuppressedCritical = 0;
  let unsuppressedHigh = 0;
  for (const f of allFindings) {
    const id = f.id || f.fingerprint || f.ruleId;
    if (validExceptionIds.has(id)) continue;
    if (f.severity === 'Critical') unsuppressedCritical++;
    if (f.severity === 'High') unsuppressedHigh++;
  }

  const hasPolicyFailure = unsuppressedCritical > 0 || unsuppressedHigh > 0;
  const hasStrictError = strict && errors.length > 0;

  const passed = !hasPolicyFailure && !hasStrictError && errors.filter((e) => !e.includes('Notice')).length === 0;
  const exitCode = passed ? 0 : 1;

  return {
    passed,
    exitCode,
    counts,
    findings: allFindings,
    errors,
    report: sanitizedReport,
    outputPath,
  };
}

/**
 * Main CLI entry point.
 */
export function main(argv = process.argv.slice(2), dependencies = {}) {
  const rootDir = dependencies.rootDir || defaultRepoRoot;
  const exitFn = dependencies.exitFn || process.exit;
  const logFn = dependencies.logFn || console.log;
  const errFn = dependencies.errFn || console.error;
  const execFn = dependencies.execFn;

  let output = resolve(rootDir, 'artifacts/security/supply-chain.json');
  let strict = false;
  let offline = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--output' || arg === '-o') {
      output = argv[++i];
    } else if (arg === '--strict') {
      strict = true;
    } else if (arg === '--offline') {
      offline = true;
    } else if (arg === '--help' || arg === '-h') {
      logFn('Usage: node run-supply-chain.mjs [--output <path>] [--strict] [--offline]');
      return exitFn(0);
    } else {
      errFn(`Unknown option: ${arg}`);
      return exitFn(1);
    }
  }

  logFn('===============================================================');
  logFn('           SUPPLY CHAIN & SECRET SCANNING DRIVER               ');
  logFn('===============================================================');
  logFn(`Output:   ${output}`);
  logFn(`Strict:   ${strict}`);
  logFn(`Offline:  ${offline}`);

  const scanOptions = {
    rootDir,
    output,
    strict,
    offline,
  };
  if (execFn) scanOptions.execFn = execFn;

  const result = runSupplyChainScan(scanOptions);

  logFn('---------------------------------------------------------------');
  logFn(`Total Findings:       ${result.findings?.length ?? 0}`);
  logFn(`Critical:             ${result.counts?.Critical ?? 0}`);
  logFn(`High:                 ${result.counts?.High ?? 0}`);
  logFn(`Medium:               ${result.counts?.Medium ?? 0}`);
  logFn(`Low:                  ${result.counts?.Low ?? 0}`);
  logFn(`Informational:        ${result.counts?.Informational ?? 0}`);
  logFn('---------------------------------------------------------------');

  if (result.passed) {
    logFn('>>> [SUPPLY CHAIN VERDICT]: PASSED (exit code 0)');
    logFn('===============================================================');
    return exitFn(0);
  } else {
    errFn('>>> [SUPPLY CHAIN VERDICT]: FAILED (exit code 1)');
    for (const err of result.errors) {
      errFn(`  - ${err}`);
    }
    logFn('===============================================================');
    return exitFn(1);
  }
}

const isMain =
  process.argv[1] &&
  (import.meta.url === pathToFileURL(process.argv[1]).href ||
    resolve(process.argv[1]) === resolve(__filename));

if (isMain) {
  main();
}
