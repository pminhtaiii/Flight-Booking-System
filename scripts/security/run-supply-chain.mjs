import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { redactSensitiveText, stripDisallowedFields } from './write-report.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const defaultRepoRoot = resolve(__dirname, '..', '..');

const REPORT_VERSION = '1.0.0';
const PIP_AUDIT_VERSION = '2.7.3';
const DEFAULT_OUTPUT = 'artifacts/security/supply-chain.json';
const DEFAULT_PIP_CACHE = '.pip-audit-cache';
const PIP_MAX_ADVISORY_AGE_HOURS = 24;

function emptyCounts() {
  return {
    Critical: 0,
    High: 0,
    Medium: 0,
    Low: 0,
    Informational: 0,
  };
}

function makeCounts(findings = []) {
  const counts = emptyCounts();
  for (const finding of findings) {
    if (finding && Object.hasOwn(counts, finding.severity)) counts[finding.severity] += 1;
  }
  return counts;
}

function parseJson(raw, label) {
  if (raw && typeof raw === 'object') return { value: raw, error: null };
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { value: null, error: `[${label} Parse Error] Scanner returned no JSON evidence` };
  }

  const text = raw.trim();
  try {
    return { value: JSON.parse(text), error: null };
  } catch {
    // Scanner loggers sometimes prefix a JSON report. Only parse a bounded JSON
    // slice; no raw scanner output is ever copied into the resulting report.
    const starts = [text.indexOf('['), text.indexOf('{')]
      .filter((index) => index >= 0)
      .sort((a, b) => a - b);
    const start = starts[0];
    const end = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
    if (start >= 0 && end > start) {
      try {
        return { value: JSON.parse(text.slice(start, end + 1)), error: null };
      } catch {
        // Fall through to the safe generic error below.
      }
    }
    return {
      value: null,
      error: `[${label} Parse Error] Scanner returned malformed JSON evidence`,
    };
  }
}

function isoTimestamp(value) {
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function safeNow(nowFn) {
  return (
    isoTimestamp(typeof nowFn === 'function' ? nowFn() : new Date()) || new Date().toISOString()
  );
}

function normalizeSeverity(value, fallback = 'Informational') {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value >= 9) return 'Critical';
    if (value >= 7) return 'High';
    if (value >= 4) return 'Medium';
    if (value > 0) return 'Low';
    return 'Informational';
  }

  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (normalized.includes('critical') || normalized === 'crit') return 'Critical';
  if (normalized.includes('high') || normalized === 'error') return 'High';
  if (normalized.includes('moderate') || normalized.includes('medium') || normalized === 'warning')
    return 'Medium';
  if (normalized.includes('low')) return 'Low';
  if (normalized.includes('info')) return 'Informational';
  return fallback;
}

function safeText(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  const text = redactSensitiveText(String(value));
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

function safeFile(value, fallback = 'unknown-file') {
  const text = safeText(value, fallback).replaceAll('\\', '/');
  return text || fallback;
}

function safeLine(value) {
  const line = Number(value);
  return Number.isInteger(line) && line > 0 ? line : 1;
}

function fingerprintFor(scanner, id, file, line, message) {
  return createHash('sha256').update(`${scanner}|${id}|${file}|${line}|${message}`).digest('hex');
}

function normalizedFinding({ scanner, id, severity, file, line, message }) {
  const ruleId = safeText(id, 'unknown-rule');
  const normalizedFile = safeFile(file);
  const normalizedLine = safeLine(line);
  const normalizedMessage = safeText(message, `${scanner} finding`);
  return {
    id: ruleId,
    ruleId,
    scanner,
    severity: normalizeSeverity(severity),
    file: normalizedFile,
    line: normalizedLine,
    message: normalizedMessage,
    fingerprint: fingerprintFor(scanner, ruleId, normalizedFile, normalizedLine, normalizedMessage),
  };
}

function advisoryTimestampFrom(value) {
  if (!value || typeof value !== 'object') return null;
  const candidates = [
    value.advisoryDatabaseTimestamp,
    value.advisory_database_timestamp,
    value.databaseTimestamp,
    value.database_timestamp,
    value.auditTimestamp,
    value.audit_timestamp,
    value.generatedAt,
    value.generated_at,
    value.metadata?.advisoryDatabaseTimestamp,
    value.metadata?.advisory_database_timestamp,
    value.metadata?.databaseTimestamp,
    value.metadata?.database_timestamp,
    value.metadata?.auditTimestamp,
    value.metadata?.audit_timestamp,
  ];
  for (const candidate of candidates) {
    const timestamp = isoTimestamp(candidate);
    if (timestamp) return timestamp;
  }
  return null;
}

function freshnessRecord({
  source,
  mode,
  checkedAt,
  maxAdvisoryAgeHours,
  advisoryDatabaseTimestamp,
  usedOfflineCache,
}) {
  const freshness = {
    source,
    mode,
    checkedAt,
    usedOfflineCache: usedOfflineCache === true,
  };
  if (maxAdvisoryAgeHours !== undefined) freshness.maxAdvisoryAgeHours = maxAdvisoryAgeHours;
  if (advisoryDatabaseTimestamp) freshness.advisoryDatabaseTimestamp = advisoryDatabaseTimestamp;
  return freshness;
}

function normalisePipAudit(raw, options = {}) {
  const parsed = parseJson(raw, 'pip-audit');
  if (parsed.error) {
    return {
      valid: false,
      counts: emptyCounts(),
      findings: [],
      errors: [parsed.error],
      freshness: null,
    };
  }
  const data = parsed.value;
  const dependencies = Array.isArray(data)
    ? data
    : data && Array.isArray(data.dependencies)
      ? data.dependencies
      : null;
  if (!dependencies) {
    return {
      valid: false,
      counts: emptyCounts(),
      findings: [],
      errors: ['[pip-audit Parse Error] Expected a dependencies array'],
      freshness: null,
    };
  }

  const findings = [];
  for (const dependency of dependencies) {
    if (!dependency || typeof dependency !== 'object') continue;
    const vulnerabilities = Array.isArray(dependency.vulns)
      ? dependency.vulns
      : Array.isArray(dependency.vulnerabilities)
        ? dependency.vulnerabilities
        : [];
    for (const vulnerability of vulnerabilities) {
      if (!vulnerability || typeof vulnerability !== 'object') continue;
      const id =
        vulnerability.id ||
        vulnerability.aliases?.[0] ||
        `pip-audit:${dependency.name || 'unknown'}`;
      const description =
        vulnerability.description ||
        `Known vulnerability in ${dependency.name || 'Python dependency'}`;
      findings.push(
        normalizedFinding({
          scanner: 'pip-audit',
          id,
          severity: vulnerability.severity ?? vulnerability.cvss,
          fallback: 'High',
          file: 'apps/agent/pyproject.toml',
          line: 1,
          message: `${dependency.name || 'Python dependency'}: ${description}`,
        }),
      );
      findings[findings.length - 1].severity = normalizeSeverity(
        vulnerability.severity ?? vulnerability.cvss,
        'High',
      );
    }
  }

  const advisoryDatabaseTimestamp =
    advisoryTimestampFrom(data) || isoTimestamp(options.advisoryDatabaseTimestamp);
  const freshness = freshnessRecord({
    source: 'PyPI advisory database via pip-audit',
    mode: data?.freshness?.mode || 'live',
    checkedAt: options.checkedAt,
    maxAdvisoryAgeHours: PIP_MAX_ADVISORY_AGE_HOURS,
    advisoryDatabaseTimestamp,
    usedOfflineCache: data?.freshness?.usedOfflineCache,
  });
  return { valid: true, counts: makeCounts(findings), findings, errors: [], freshness };
}

function advisoryEntries(data) {
  const entries = [];
  if (data && typeof data.advisories === 'object' && data.advisories !== null) {
    for (const [key, value] of Object.entries(data.advisories)) {
      const values = Array.isArray(value) ? value : [value];
      for (const advisory of values) entries.push({ key, advisory });
    }
  }
  if (data && typeof data.vulnerabilities === 'object' && data.vulnerabilities !== null) {
    for (const [key, value] of Object.entries(data.vulnerabilities)) {
      const values = Array.isArray(value) ? value : [value];
      for (const advisory of values) entries.push({ key, advisory });
    }
  }
  return entries;
}

function normalisePnpmAudit(raw, options = {}) {
  const parsed = parseJson(raw, 'pnpm audit');
  if (parsed.error) {
    return {
      valid: false,
      counts: emptyCounts(),
      findings: [],
      errors: [parsed.error],
      freshness: null,
    };
  }
  const data = parsed.value;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return {
      valid: false,
      counts: emptyCounts(),
      findings: [],
      errors: ['[pnpm audit Parse Error] Expected an audit object'],
      freshness: null,
    };
  }

  const findings = [];
  for (const { key, advisory } of advisoryEntries(data)) {
    if (!advisory || typeof advisory !== 'object') continue;
    const via = Array.isArray(advisory.via) ? advisory.via : [];
    const viaObject = via.find((item) => item && typeof item === 'object') || {};
    const id =
      advisory.id ||
      advisory.cve ||
      advisory.url ||
      viaObject.source ||
      key ||
      'pnpm-audit:advisory';
    const packageName = advisory.module_name || advisory.package || advisory.name || key;
    const message =
      advisory.title ||
      advisory.overview ||
      viaObject.title ||
      `Known vulnerability in ${packageName || 'Node dependency'}`;
    findings.push(
      normalizedFinding({
        scanner: 'pnpm-audit',
        id,
        severity: advisory.severity || viaObject.severity || 'Medium',
        file: 'package.json',
        line: 1,
        message: `${packageName || 'Node dependency'}: ${message}`,
      }),
    );
  }

  const metadataCounts = data.metadata?.vulnerabilities;
  if (metadataCounts && typeof metadataCounts === 'object') {
    const targets = [
      ['critical', 'Critical'],
      ['high', 'High'],
      ['moderate', 'Medium'],
      ['medium', 'Medium'],
      ['low', 'Low'],
      ['info', 'Informational'],
      ['informational', 'Informational'],
    ];
    const represented = makeCounts(findings);
    for (const [sourceKey, severity] of targets) {
      const total = Number(metadataCounts[sourceKey]);
      if (!Number.isInteger(total) || total <= represented[severity]) continue;
      for (let index = represented[severity]; index < total; index += 1) {
        findings.push(
          normalizedFinding({
            scanner: 'pnpm-audit',
            id: `pnpm-audit:${severity.toLowerCase()}:${index + 1}`,
            severity,
            file: 'package.json',
            line: 1,
            message: `${severity} advisory reported by npm registry`,
          }),
        );
      }
      represented[severity] = total;
    }
  }

  const advisoryDatabaseTimestamp =
    advisoryTimestampFrom(data) || isoTimestamp(options.advisoryDatabaseTimestamp);
  const freshness = freshnessRecord({
    source: 'npm advisory registry via pnpm audit',
    mode: data?.freshness?.mode || 'live',
    checkedAt: options.checkedAt,
    advisoryDatabaseTimestamp,
    usedOfflineCache: data?.freshness?.usedOfflineCache,
  });
  return { valid: true, counts: makeCounts(findings), findings, errors: [], freshness };
}

function normaliseGitleaks(raw, options = {}) {
  const parsed = parseJson(raw, 'gitleaks');
  if (parsed.error) {
    return { valid: false, counts: emptyCounts(), findings: [], errors: [parsed.error] };
  }
  const data = parsed.value;
  const records = Array.isArray(data)
    ? data
    : Array.isArray(data?.findings)
      ? data.findings
      : Array.isArray(data?.Leaks)
        ? data.Leaks
        : Array.isArray(data?.leaks)
          ? data.leaks
          : null;
  if (!records) {
    return {
      valid: false,
      counts: emptyCounts(),
      findings: [],
      errors: ['[gitleaks Parse Error] Expected a findings array'],
    };
  }

  const findings = [];
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const ruleId = record.RuleID || record.ruleID || record.ruleId || 'gitleaks-secret';
    const file = record.File || record.file || 'unknown-file';
    const line = record.StartLine || record.startLine || 1;
    // Never copy Secret, Match, Author, Email, Commit, or Message into a report.
    findings.push(
      normalizedFinding({
        scanner: 'gitleaks',
        id: ruleId,
        severity: 'Critical',
        file,
        line,
        message: `Secret detected by gitleaks rule ${ruleId}`,
      }),
    );
  }

  return {
    valid: true,
    counts: makeCounts(findings),
    findings,
    errors: [],
    freshness: freshnessRecord({
      source: 'Gitleaks static detection rules',
      mode: options.mode || 'local',
      checkedAt: options.checkedAt,
      usedOfflineCache: false,
    }),
  };
}

function commandResult(execFn, command, args, rootDir) {
  try {
    const result = execFn(command, args, {
      cwd: rootDir,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    if (!result || typeof result !== 'object') {
      return { status: null, stdout: '', stderr: '', error: new Error('invalid scanner result') };
    }
    return {
      status: Number.isInteger(result.status) ? result.status : null,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
      error: result.error || null,
    };
  } catch (error) {
    return { status: null, stdout: '', stderr: '', error };
  }
}

function executionError(label, result) {
  if (result.error?.code === 'ENOENT')
    return `[${label} Execution Error] Scanner executable unavailable`;
  if (result.error?.code === 'ETIMEDOUT')
    return `[${label} Execution Error] Scanner execution timed out`;
  if (result.error) return `[${label} Execution Error] Scanner execution failed`;
  if (result.status === null || result.status === undefined)
    return `[${label} Execution Error] Scanner did not return an exit status`;
  return `[${label} Execution Error] Scanner exited without parseable evidence (status ${result.status})`;
}

function readReportFile(path) {
  if (!path || !existsSync(path)) return '';
  try {
    const content = readFileSync(path, 'utf8');
    unlinkSync(path);
    return content;
  } catch {
    return '';
  }
}

function prepareRawReportDir(rootDir, requested) {
  if (requested) {
    const dir = isAbsolute(requested) ? requested : resolve(rootDir, requested);
    mkdirSync(dir, { recursive: true });
    return { dir, cleanup: false };
  }
  const dir = mkdtempSync(join(tmpdir(), 'flight-booking-supply-chain-'));
  return { dir, cleanup: true };
}

function runPipAudit(options = {}) {
  const rootDir = resolve(options.rootDir || defaultRepoRoot);
  const execFn = options.execFn || spawnSync;
  const checkedAt = options.checkedAt || new Date().toISOString();
  const rawReportDir =
    options.rawReportDir || mkdtempSync(join(tmpdir(), 'flight-booking-pip-audit-'));
  const ownsReportDir = !options.rawReportDir;
  mkdirSync(rawReportDir, { recursive: true });
  const requirementsPath = join(rawReportDir, 'agent-requirements.txt');
  const reportPath = join(rawReportDir, 'pip-audit.json');
  const errors = [];
  let parsed = null;

  try {
    const exportResult = commandResult(
      execFn,
      'uv',
      [
        'export',
        '--package',
        'agent',
        '--locked',
        '--no-dev',
        '--format',
        'requirements-txt',
        '--output-file',
        requirementsPath,
      ],
      rootDir,
    );
    if (exportResult.error || exportResult.status !== 0) {
      errors.push(executionError('pip-audit lock export', exportResult));
    } else {
      if (!existsSync(requirementsPath) && exportResult.stdout) {
        writeFileSync(requirementsPath, exportResult.stdout, 'utf8');
      }
      const auditResult = commandResult(
        execFn,
        'uv',
        [
          'tool',
          'run',
          `--from`,
          `pip-audit==${PIP_AUDIT_VERSION}`,
          'pip-audit',
          '--requirement',
          requirementsPath,
          '--format',
          'json',
          '--output',
          reportPath,
          '--cache-dir',
          resolve(rootDir, DEFAULT_PIP_CACHE),
        ],
        rootDir,
      );
      const raw = readReportFile(reportPath) || auditResult.stdout;
      parsed = normalisePipAudit(raw, {
        checkedAt,
        advisoryDatabaseTimestamp: options.advisoryDatabaseTimestamp,
      });
      if (!parsed.valid) errors.push(...parsed.errors);
      if (auditResult.error || (auditResult.status !== 0 && auditResult.status !== 1)) {
        errors.push(executionError('pip-audit', auditResult));
      }
      if ((auditResult.status === 0 || auditResult.status === 1) && !raw.trim()) {
        errors.push('[pip-audit Error] Scanner returned no report evidence');
      }
    }
  } catch {
    errors.push('[pip-audit Execution Error] Scanner execution failed');
  } finally {
    if (ownsReportDir) rmSync(rawReportDir, { recursive: true, force: true });
  }

  return {
    timestamp: checkedAt,
    advisoryDatabaseTimestamp: parsed?.freshness?.advisoryDatabaseTimestamp || null,
    freshness:
      parsed?.freshness ||
      freshnessRecord({
        source: 'PyPI advisory database via pip-audit',
        mode: 'live',
        checkedAt,
        maxAdvisoryAgeHours: PIP_MAX_ADVISORY_AGE_HOURS,
        advisoryDatabaseTimestamp: null,
        usedOfflineCache: false,
      }),
    counts: parsed?.counts || emptyCounts(),
    findings: parsed?.findings || [],
    errors,
  };
}

function runPnpmAudit(options = {}) {
  const rootDir = resolve(options.rootDir || defaultRepoRoot);
  const execFn = options.execFn || spawnSync;
  const checkedAt = options.checkedAt || new Date().toISOString();
  const result = commandResult(
    execFn,
    'pnpm',
    ['audit', '--audit-level', 'moderate', '--json'],
    rootDir,
  );
  const parsed = normalisePnpmAudit(result.stdout, {
    checkedAt,
    advisoryDatabaseTimestamp: options.advisoryDatabaseTimestamp,
  });
  const errors = parsed.errors ? [...parsed.errors] : [];
  if (result.error || (result.status !== 0 && result.status !== 1))
    errors.push(executionError('pnpm audit', result));
  if ((result.status === 0 || result.status === 1) && !result.stdout.trim()) {
    errors.push('[pnpm audit Error] Scanner returned no report evidence');
  }
  return {
    timestamp: checkedAt,
    advisoryDatabaseTimestamp: parsed.freshness?.advisoryDatabaseTimestamp || null,
    freshness:
      parsed.freshness ||
      freshnessRecord({
        source: 'npm advisory registry via pnpm audit',
        mode: 'live',
        checkedAt,
        advisoryDatabaseTimestamp: null,
        usedOfflineCache: false,
      }),
    counts: parsed.counts,
    findings: parsed.findings,
    errors,
  };
}

function runSecretScan(options = {}) {
  const rootDir = resolve(options.rootDir || defaultRepoRoot);
  const execFn = options.execFn || spawnSync;
  const checkedAt = options.checkedAt || new Date().toISOString();
  const rawReportDir =
    options.rawReportDir || mkdtempSync(join(tmpdir(), 'flight-booking-gitleaks-'));
  const ownsReportDir = !options.rawReportDir;
  mkdirSync(rawReportDir, { recursive: true });
  const errors = [];
  const findings = [];
  const scanDefinitions = [
    {
      label: 'gitleaks history',
      reportPath: join(rawReportDir, 'gitleaks-history.json'),
      args: [
        'detect',
        '--source',
        rootDir,
        '--verbose',
        '--report-format',
        'json',
        '--report-path',
        join(rawReportDir, 'gitleaks-history.json'),
        '--redact',
        '--log-opts=--all',
      ],
      mode: 'history',
    },
    {
      label: 'gitleaks working tree',
      reportPath: join(rawReportDir, 'gitleaks-working-tree.json'),
      args: [
        'detect',
        '--source',
        rootDir,
        '--verbose',
        '--report-format',
        'json',
        '--report-path',
        join(rawReportDir, 'gitleaks-working-tree.json'),
        '--redact',
        '--no-git',
      ],
      mode: 'working-tree',
    },
  ];

  try {
    for (const definition of scanDefinitions) {
      const result = commandResult(execFn, 'gitleaks', definition.args, rootDir);
      // Gitleaks writes a JSON file, while logs remain on stdout/stderr. Read,
      // normalize, and delete the redacted intermediate immediately.
      const raw = readReportFile(definition.reportPath) || result.stdout;
      const parsed = normaliseGitleaks(raw, { checkedAt, mode: definition.mode });
      const hasEvidence = parsed.valid && (raw.trim() !== '' || result.status === 0);
      if (!hasEvidence) {
        if (parsed.errors.length > 0) errors.push(...parsed.errors);
        else errors.push(`[${definition.label} Error] Scanner returned no report evidence`);
      }
      if (result.error || (result.status !== 0 && result.status !== 1))
        errors.push(executionError(definition.label, result));
      findings.push(...parsed.findings);
    }
  } finally {
    if (ownsReportDir) rmSync(rawReportDir, { recursive: true, force: true });
  }

  const dedupedFindings = [
    ...new Map(findings.map((finding) => [finding.fingerprint, finding])).values(),
  ];
  return {
    timestamp: checkedAt,
    freshness: freshnessRecord({
      source: 'Gitleaks static detection rules',
      mode: 'history-and-working-tree',
      checkedAt,
      usedOfflineCache: false,
    }),
    counts: makeCounts(dedupedFindings),
    findings: dedupedFindings,
    errors,
  };
}

function deepSanitize(value) {
  const stripped = stripDisallowedFields(value);
  if (typeof stripped === 'string') return redactSensitiveText(stripped);
  if (Array.isArray(stripped)) return stripped.map((item) => deepSanitize(item));
  if (stripped && typeof stripped === 'object') {
    return Object.fromEntries(
      Object.entries(stripped).map(([key, item]) => [key, deepSanitize(item)]),
    );
  }
  return stripped;
}

function staleFreshnessError(scanner, freshness, checkedAt) {
  const timestamp = freshness?.advisoryDatabaseTimestamp;
  const maxHours = Number(freshness?.maxAdvisoryAgeHours);
  if (!timestamp || !Number.isFinite(maxHours)) return null;
  const advisoryMs = Date.parse(timestamp);
  const checkedMs = Date.parse(checkedAt);
  if (!Number.isFinite(advisoryMs) || !Number.isFinite(checkedMs))
    return `[${scanner} Freshness Error] Advisory timestamp is invalid`;
  if (advisoryMs > checkedMs || checkedMs - advisoryMs > maxHours * 60 * 60 * 1000) {
    return `[${scanner} Freshness Error] Advisory data is stale or from the future`;
  }
  return null;
}

export function runSupplyChainScan(options = {}) {
  const rootDir = resolve(options.rootDir || defaultRepoRoot);
  const strict = options.strict !== false;
  const nowFn = options.now || (() => new Date());
  const timestamp = safeNow(nowFn);
  const outputPath = resolve(rootDir, options.output || DEFAULT_OUTPUT);
  const temp = prepareRawReportDir(rootDir, options.rawReportDir);

  let pipAudit;
  let pnpmAudit;
  let gitleaks;
  try {
    pipAudit = runPipAudit({
      ...options,
      rootDir,
      checkedAt: timestamp,
      rawReportDir: temp.dir,
    });
    pnpmAudit = runPnpmAudit({ ...options, rootDir, checkedAt: timestamp });
    gitleaks = runSecretScan({
      ...options,
      rootDir,
      checkedAt: timestamp,
      rawReportDir: temp.dir,
    });
  } finally {
    if (temp.cleanup) rmSync(temp.dir, { recursive: true, force: true });
  }

  const findings = [pipAudit, pnpmAudit, gitleaks]
    .flatMap((scanner) => scanner.findings || [])
    .map((finding) => deepSanitize(finding));
  const dedupedFindings = [
    ...new Map(findings.map((finding) => [finding.fingerprint, finding])).values(),
  ];
  const counts = makeCounts(dedupedFindings);
  const errors = [pipAudit, pnpmAudit, gitleaks].flatMap((scanner) => scanner.errors || []);
  for (const [name, scanner] of [
    ['pip-audit', pipAudit],
    ['pnpm audit', pnpmAudit],
  ]) {
    const staleError = staleFreshnessError(name, scanner.freshness, timestamp);
    if (staleError) errors.push(staleError);
    if (
      strict &&
      scanner.freshness?.usedOfflineCache &&
      !scanner.freshness.advisoryDatabaseTimestamp
    ) {
      errors.push(`[${name} Freshness Error] Offline advisory cache has no verifiable timestamp`);
    }
  }
  if (counts.Critical > 0)
    errors.push(`[Supply Chain Policy Failure] Found ${counts.Critical} Critical finding(s)`);
  if (counts.High > 0)
    errors.push(`[Supply Chain Policy Failure] Found ${counts.High} High finding(s)`);

  const report = deepSanitize({
    version: REPORT_VERSION,
    timestamp,
    counts,
    findings: dedupedFindings,
    pipAudit,
    pnpmAudit,
    gitleaks,
    exceptions: [],
    errors,
  });

  let writeError = null;
  try {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  } catch {
    writeError = '[Supply Chain Report Error] Failed to write sanitized report';
    errors.push(writeError);
  }

  const passed = errors.length === 0 && counts.Critical === 0 && counts.High === 0;
  return {
    passed,
    exitCode: passed && !writeError ? 0 : 1,
    counts,
    findings: dedupedFindings,
    errors,
    report: deepSanitize({ ...report, errors }),
    outputPath,
  };
}

/* eslint-disable no-console */
export function main(argv = process.argv.slice(2), dependencies = {}) {
  const logFn = dependencies.logFn || console.log;
  const errFn = dependencies.errFn || console.error;
  const exitFn = dependencies.exitFn || process.exit;
  let output;
  let strict = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      logFn('Usage: node scripts/security/run-supply-chain.mjs [--output <path>] [--strict]');
      return exitFn(0);
    }
    if (arg === '--strict') {
      strict = true;
      continue;
    }
    if (arg === '--output' || arg === '-o') {
      output = argv[index + 1];
      index += 1;
      if (!output) {
        errFn(`Missing output path after ${arg}`);
        return exitFn(1);
      }
      continue;
    }
    errFn(`Unknown option: ${arg}`);
    return exitFn(1);
  }

  const result = runSupplyChainScan({ ...dependencies, output, strict });
  logFn(`Supply-chain report: ${result.outputPath}`);
  logFn(
    `Findings: ${result.findings.length} (Critical ${result.counts.Critical}, High ${result.counts.High})`,
  );
  if (!result.passed) {
    for (const error of result.errors) errFn(error);
  }
  return exitFn(result.exitCode);
}
/* eslint-enable no-console */

const isMain =
  process.argv[1] &&
  (import.meta.url === pathToFileURL(process.argv[1]).href ||
    resolve(process.argv[1]) === resolve(__filename));

if (isMain) main();
