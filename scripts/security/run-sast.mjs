import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const defaultRepoRoot = resolve(__dirname, '..', '..');

export const DEFAULT_WORKSPACES = ['apps/agent', 'apps/api', 'apps/web', 'packages/shared'];

export const DEFAULT_MIN_COUNTS = {
  'apps/agent': 30,
  'apps/api': 20,
  'apps/web': 20,
  'packages/shared': 1,
};

export const DEFAULT_EXTENSIONS = new Set(['.py', '.ts', '.tsx', '.js', '.mjs']);

export const DEFAULT_IGNORED_DIRS = new Set([
  'node_modules',
  'dist',
  '.next',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.git',
]);

export const DEFAULT_STANDARD_RULESETS = [
  'p/default@v1.88.0',
  'p/owasp-top-ten@v1.88.0',
  'p/security-audit@v1.88.0',
  'p/secrets@v1.88.0',
];

export const NON_BYPASSABLE_RULES = new Set([
  'no-llm-in-guardrails',
  'no-unshielded-tool-execution',
]);

/**
 * Computes deterministic finding fingerprint.
 */
export function computeFindingFingerprint(ruleId, file, line, message = '') {
  const normFile = String(file || '').replaceAll('\\', '/');
  return createHash('sha256')
    .update(`${ruleId || ''}:${normFile}:${line || 1}:${message || ''}`)
    .digest('hex');
}

/**
 * Recursively counts target source files across target workspaces.
 * Fails closed if any workspace falls below expected file count.
 */
export function calculateFileCensus(options = {}) {
  const rootDir = options.rootDir ? resolve(options.rootDir) : defaultRepoRoot;
  const workspaces = options.workspaces || DEFAULT_WORKSPACES;
  const minCounts = options.minCounts || DEFAULT_MIN_COUNTS;
  const targetExtensions = options.targetExtensions
    ? new Set(options.targetExtensions)
    : DEFAULT_EXTENSIONS;
  const ignoredDirs = options.ignoredDirs ? new Set(options.ignoredDirs) : DEFAULT_IGNORED_DIRS;

  const workspaceCounts = {};
  const fileList = [];
  const errors = [];

  for (const ws of workspaces) {
    const wsDir = resolve(rootDir, ws);
    if (!existsSync(wsDir)) {
      errors.push(`[Census Failure] Workspace directory does not exist: ${ws}`);
      workspaceCounts[ws] = 0;
      continue;
    }

    let count = 0;

    function walk(currentDir) {
      let entries;
      try {
        entries = readdirSync(currentDir, { withFileTypes: true });
      } catch (err) {
        errors.push(`[Census Error] Cannot read directory ${currentDir}: ${err.message}`);
        return;
      }

      for (const entry of entries) {
        const name = entry.name;
        if (ignoredDirs.has(name)) continue;

        const fullPath = join(currentDir, name);
        const relToRoot = relative(rootDir, fullPath).replaceAll('\\', '/');

        // Exclude test fixture directory
        if (relToRoot.includes('tests/security/sast/fixtures')) continue;

        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile()) {
          const ext = extname(name).toLowerCase();
          if (targetExtensions.has(ext)) {
            count += 1;
            fileList.push(relToRoot);
          }
        }
      }
    }

    walk(wsDir);
    workspaceCounts[ws] = count;

    const minRequired = minCounts[ws];
    if (minRequired !== undefined && count < minRequired) {
      errors.push(
        `[Census Failure] Workspace ${ws} file count (${count}) is below required minimum (${minRequired})`,
      );
    }
  }

  const totalFiles = Object.values(workspaceCounts).reduce((sum, c) => sum + c, 0);
  const passed = errors.length === 0;

  return {
    passed,
    totalFiles,
    workspaceCounts,
    errors,
    fileList,
  };
}

/**
 * Resolves target files for SAST scan in either 'full' or 'diff' mode.
 */
export function resolveTargetFiles(options = {}) {
  const rootDir = options.rootDir ? resolve(options.rootDir) : defaultRepoRoot;
  const mode = options.mode || 'full';
  const workspaces = options.workspaces || DEFAULT_WORKSPACES;
  const targetExtensions = options.targetExtensions
    ? new Set(options.targetExtensions)
    : DEFAULT_EXTENSIONS;
  const ignoredDirs = options.ignoredDirs ? new Set(options.ignoredDirs) : DEFAULT_IGNORED_DIRS;

  if (mode === 'diff') {
    let diffOutput = options.gitDiffOutput;
    const errors = [];
    if (diffOutput === undefined) {
      const execFn = options.execFn || spawnSync;
      const base = options.diffBase || 'origin/development...HEAD';
      let res;
      let gitSuccess = false;
      try {
        res = execFn('git', ['diff', '--name-only', '--diff-filter=ACMRTUXB', base], {
          cwd: rootDir,
          encoding: 'utf8',
        });
        if (res && res.status === 0 && !res.error) {
          gitSuccess = true;
          diffOutput = res.stdout || '';
        }
      } catch {
        // Fall back to HEAD
      }

      if (!gitSuccess) {
        try {
          res = execFn('git', ['diff', '--name-only', '--diff-filter=ACMRTUXB', 'HEAD'], {
            cwd: rootDir,
            encoding: 'utf8',
          });
          if (res && res.status === 0 && !res.error) {
            gitSuccess = true;
            diffOutput = res.stdout || '';
          }
        } catch (err) {
          res = { error: err };
        }
      }

      if (!gitSuccess) {
        const errMsg =
          res?.error?.message ||
          res?.stderr?.trim() ||
          `git command exited with status ${res?.status ?? 'unknown'}`;
        errors.push(`[Git Diff Error] Failed to determine git diff files: ${errMsg}`);
        return {
          mode: 'diff',
          files: [],
          workspaces,
          passed: false,
          errors,
        };
      }
    }

    const lines = (diffOutput || '')
      .split(/\r?\n/)
      .map((l) => l.trim().replaceAll('\\', '/'))
      .filter((l) => l.length > 0);

    const filtered = lines.filter((relPath) => {
      const inWorkspace = workspaces.some((ws) => relPath === ws || relPath.startsWith(`${ws}/`));
      if (!inWorkspace) return false;

      const ext = extname(relPath).toLowerCase();
      if (!targetExtensions.has(ext)) return false;

      const pathParts = relPath.split('/');
      if (pathParts.some((part) => ignoredDirs.has(part))) return false;

      if (relPath.includes('tests/security/sast/fixtures')) return false;

      return true;
    });

    return {
      mode: 'diff',
      files: filtered,
      workspaces,
      passed: true,
      errors: [],
    };
  }

  const census = calculateFileCensus({
    rootDir,
    workspaces,
    targetExtensions,
    ignoredDirs,
  });

  return {
    mode: 'full',
    files: census.fileList,
    workspaces,
    passed: census.passed,
    errors: census.errors,
  };
}

/**
 * Parses SARIF v2.1.0 output and extracts normalized findings.
 */
export function parseSarifResults(sarifData) {
  if (sarifData === null || sarifData === undefined) return [];

  let data = sarifData;
  if (typeof data === 'string') {
    data = JSON.parse(data);
  }

  if (
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data) &&
    Object.keys(data).length === 0
  ) {
    return [];
  }

  if (typeof data !== 'object' || data === null || !Array.isArray(data.runs)) {
    throw new Error('Invalid SARIF format: expected an object with a "runs" array');
  }

  const findings = [];

  for (const run of data.runs) {
    if (!Array.isArray(run?.results)) continue;

    const rulesMap = new Map();
    const driverRules = run?.tool?.driver?.rules;
    if (Array.isArray(driverRules)) {
      driverRules.forEach((r, idx) => {
        if (r?.id) rulesMap.set(r.id, r);
        rulesMap.set(idx, r);
      });
    }
    const extRules = run?.tool?.extensions;
    if (Array.isArray(extRules)) {
      for (const ext of extRules) {
        if (Array.isArray(ext?.rules)) {
          ext.rules.forEach((r) => {
            if (r?.id) rulesMap.set(r.id, r);
          });
        }
      }
    }

    for (const result of run.results) {
      const ruleId = result.ruleId || result.rule?.id || 'unknown-rule';
      const rule =
        (result.ruleIndex !== undefined ? rulesMap.get(result.ruleIndex) : null) ||
        rulesMap.get(ruleId) ||
        result.rule;

      const rawSec =
        result.properties?.['security-severity'] ??
        rule?.properties?.['security-severity'] ??
        result.properties?.severity ??
        rule?.properties?.severity ??
        rule?.defaultConfiguration?.level;

      let severity = 'MEDIUM';
      if (rawSec !== undefined && rawSec !== null && String(rawSec).trim() !== '') {
        const num = Number(rawSec);
        if (!isNaN(num)) {
          if (num >= 9.0) severity = 'CRITICAL';
          else if (num >= 7.0) severity = 'HIGH';
          else if (num >= 4.0) severity = 'MEDIUM';
          else severity = 'LOW';
        } else {
          severity = String(rawSec).toUpperCase();
        }
      } else {
        const level = result.level || 'warning';
        if (level === 'error') severity = 'ERROR';
        else if (level === 'warning') severity = 'WARNING';
        else if (level === 'note' || level === 'none') severity = 'LOW';
      }

      const location = result.locations?.[0]?.physicalLocation;
      const fileUri = location?.artifactLocation?.uri || 'unknown-file';
      const normalizedFile = fileUri.replaceAll('\\', '/').replace(/^\/+/, '');
      const startLine = location?.region?.startLine ?? 1;
      const endLine = location?.region?.endLine ?? startLine;
      const message =
        typeof result.message === 'string' ? result.message : result.message?.text || '';

      const rawFp =
        result.fingerprint ||
        result.fingerprints?.['matchBasedId/v1'] ||
        (result.fingerprints ? Object.values(result.fingerprints)[0] : null) ||
        result.partialFingerprints?.primaryLocationLineHash ||
        (result.partialFingerprints ? Object.values(result.partialFingerprints)[0] : null);

      const fingerprint =
        typeof rawFp === 'string' && rawFp.trim() !== ''
          ? rawFp.trim()
          : computeFindingFingerprint(ruleId, normalizedFile, startLine, message);

      findings.push({
        ruleId,
        level: result.level || 'warning',
        severity,
        file: normalizedFile,
        startLine,
        endLine,
        message,
        fingerprint,
        raw: result,
      });
    }
  }

  return findings;
}

/**
 * Validates whether a string is a valid ISO 8601 representation.
 */
export function isValidIso8601(dateStr) {
  if (typeof dateStr !== 'string' || dateStr.trim() === '') return false;
  const isoRegex = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}(:\d{2})?)?)?$/i;
  if (!isoRegex.test(dateStr.trim())) return false;
  const d = new Date(dateStr.trim());
  return !isNaN(d.getTime());
}

/**
 * Validates an individual baseline finding record.
 */
export function validateBaselineFinding(finding, index = 0) {
  const errors = [];
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
    return { valid: false, errors: [`Baseline finding [${index}] must be an object`] };
  }

  if (typeof finding.ruleId !== 'string' || finding.ruleId.trim() === '') {
    errors.push(`Baseline finding [${index}] missing required field: ruleId`);
  }
  const filePath = finding.file || finding.path;
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    errors.push(`Baseline finding [${index}] missing required field: file`);
  }
  if (
    finding.line !== undefined &&
    finding.line !== null &&
    (typeof finding.line !== 'number' || finding.line < 1 || !Number.isInteger(finding.line))
  ) {
    errors.push(`Baseline finding [${index}] field 'line' must be a positive integer`);
  }

  const ruleId = typeof finding.ruleId === 'string' ? finding.ruleId.trim() : '';
  if (NON_BYPASSABLE_RULES.has(ruleId)) {
    errors.push(
      `[Non-Bypassable Rule Violation] Baseline finding [${index}] targets non-bypassable rule '${ruleId}' which cannot be baselined`,
    );
  }

  const severity = finding.severity ? String(finding.severity).toUpperCase() : null;
  if (severity && ['CRITICAL', 'HIGH', 'ERROR'].includes(severity)) {
    errors.push(
      `[Non-Bypassable Rule Violation] Baseline finding [${index}] targets non-bypassable severity '${severity}' which cannot be baselined`,
    );
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validates the structure and entries of a baseline findings document.
 */
export function validateBaselineSchema(baselineData, options = {}) {
  const errors = [];
  let data = baselineData;

  if (typeof data === 'string') {
    if (!existsSync(data)) {
      return { valid: false, errors: [`Baseline file does not exist: ${data}`], findings: [] };
    }
    try {
      data = JSON.parse(readFileSync(data, 'utf8'));
    } catch (err) {
      return { valid: false, errors: [`Failed to parse baseline JSON file: ${err.message}`], findings: [] };
    }
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, errors: ['Baseline root must be an object'], findings: [] };
  }

  if (typeof data.version !== 'string' || data.version.trim() === '') {
    errors.push("Baseline missing required 'version' string");
  }

  if (!Array.isArray(data.findings)) {
    errors.push("Baseline missing required 'findings' array");
    return { valid: false, errors, findings: [] };
  }

  const validatedFindings = [];
  for (let i = 0; i < data.findings.length; i++) {
    const fRes = validateBaselineFinding(data.findings[i], i);
    if (!fRes.valid) {
      errors.push(...fRes.errors);
    } else {
      validatedFindings.push(data.findings[i]);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    findings: validatedFindings,
  };
}

export const REQUIRED_EXCEPTION_FIELDS = [
  'id',
  'ruleId',
  'file',
  'owner',
  'rationale',
  'compensatingControl',
  'expiresAt',
];

/**
 * Validates a single exception against schema, expiration, and non-bypassable constraints.
 */
export function validateException(exception, options = {}) {
  const errors = [];
  const currentDate = options.currentDate ? new Date(options.currentDate) : new Date();
  const maxDurationDays = options.maxDurationDays ?? 30;

  if (!exception || typeof exception !== 'object' || Array.isArray(exception)) {
    return { valid: false, errors: ['Exception entry must be a valid object'] };
  }

  // 1. Required fields check
  for (const field of REQUIRED_EXCEPTION_FIELDS) {
    if (typeof exception[field] !== 'string' || exception[field].trim() === '') {
      errors.push(`Exception missing required field: ${field}`);
    }
  }

  // 2. Non-bypassable rule checks
  const ruleId = typeof exception.ruleId === 'string' ? exception.ruleId.trim() : '';
  if (NON_BYPASSABLE_RULES.has(ruleId)) {
    errors.push(
      `[Non-Bypassable Rule Violation] Non-bypassable rule '${ruleId}' cannot be suppressed by an exception and cannot be bypassed`,
    );
  }

  const severity = exception.severity ? String(exception.severity).toUpperCase() : null;
  if (severity && ['CRITICAL', 'HIGH', 'ERROR'].includes(severity)) {
    errors.push(
      `[Non-Bypassable Rule Violation] Non-bypassable rule or High/Critical/Error finding cannot be suppressed by exception and cannot be bypassed (${severity})`,
    );
  }

  // 3. Optional line and fingerprint validation
  const exLine = exception.line ?? exception.startLine;
  if (exLine !== undefined && exLine !== null) {
    if (typeof exLine !== 'number' || exLine < 1 || !Number.isInteger(exLine)) {
      errors.push("Exception field 'line' (or 'startLine') must be a positive integer");
    }
  }

  if (exception.fingerprint !== undefined && exception.fingerprint !== null) {
    if (typeof exception.fingerprint !== 'string' || exception.fingerprint.trim() === '') {
      errors.push("Exception field 'fingerprint' must be a non-empty string");
    }
  }

  // 4. Date & Duration checks
  let createdDate = null;
  if (exception.createdAt !== undefined && exception.createdAt !== null) {
    if (!isValidIso8601(exception.createdAt)) {
      errors.push(`createdAt must be a valid ISO 8601 date string, got: ${exception.createdAt}`);
    } else {
      createdDate = new Date(exception.createdAt);
    }
  } else {
    createdDate = currentDate;
  }

  let expiryDate = null;
  if (exception.expiresAt) {
    if (!isValidIso8601(exception.expiresAt)) {
      errors.push(`expiresAt must be a valid ISO 8601 date string, got: ${exception.expiresAt}`);
    } else {
      expiryDate = new Date(exception.expiresAt);
    }
  }

  if (createdDate && expiryDate && !isNaN(createdDate.getTime()) && !isNaN(expiryDate.getTime())) {
    const durationMs = expiryDate.getTime() - createdDate.getTime();
    const maxDurationMs = maxDurationDays * 24 * 60 * 60 * 1000;

    if (durationMs > maxDurationMs) {
      const durationDays = Math.ceil(durationMs / (24 * 60 * 60 * 1000));
      errors.push(
        `Exception duration (${durationDays} days) exceeds maximum allowed ${maxDurationDays} days (expiresAt - createdAt > 30 days)`,
      );
    }

    if (exception.createdAt && durationMs < 0) {
      errors.push('Exception expiresAt cannot be earlier than createdAt');
    }

    if (expiryDate.getTime() < currentDate.getTime()) {
      errors.push(
        `[Exception Expired] Exception '${exception.id || 'unknown'}' for rule '${ruleId}' expired at ${exception.expiresAt}`,
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validates an exceptions collection (document or array) against schema.
 */
export function validateExceptionsSchema(exceptionsData, options = {}) {
  const errors = [];
  let data = exceptionsData;

  if (typeof data === 'string') {
    if (!existsSync(data)) {
      return { valid: false, errors: [`Exceptions file does not exist: ${data}`], exceptions: [] };
    }
    try {
      data = JSON.parse(readFileSync(data, 'utf8'));
    } catch (err) {
      return { valid: false, errors: [`Failed to parse exceptions JSON file: ${err.message}`], exceptions: [] };
    }
  }

  let list = [];
  if (Array.isArray(data)) {
    list = data;
  } else if (data && typeof data === 'object') {
    if (typeof data.version !== 'string' || data.version.trim() === '') {
      errors.push("Exceptions schema missing required 'version' string");
    }
    if (!Array.isArray(data.exceptions)) {
      errors.push("Exceptions schema missing required 'exceptions' array");
      return { valid: false, errors, exceptions: [] };
    }
    list = data.exceptions;
  } else {
    return { valid: false, errors: ['Exceptions root must be an object or array'], exceptions: [] };
  }

  const validExceptions = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const valRes = validateException(item, options);
    if (!valRes.valid) {
      for (const err of valRes.errors) {
        errors.push(`Exception[${i}] (${item?.id || 'unnamed'}): ${err}`);
      }
    } else {
      validExceptions.push(item);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    exceptions: validExceptions,
  };
}

/**
 * Evaluates findings against baseline and exceptions with fail-closed rules.
 */
export function evaluateFindings(findings = [], options = {}) {
  const currentDate = options.currentDate ? new Date(options.currentDate) : new Date();
  const errors = [];

  let baselineList = [];
  if (options.baseline !== undefined && options.baseline !== null) {
    if (Array.isArray(options.baseline)) {
      baselineList = options.baseline;
      for (let i = 0; i < baselineList.length; i++) {
        const bRes = validateBaselineFinding(baselineList[i], i);
        if (!bRes.valid) errors.push(...bRes.errors);
      }
    } else {
      const bRes = validateBaselineSchema(options.baseline, options);
      if (!bRes.valid) errors.push(...bRes.errors);
      baselineList = bRes.findings || [];
    }
  }

  let exceptionList = [];
  if (options.exceptions !== undefined && options.exceptions !== null) {
    const exRes = validateExceptionsSchema(options.exceptions, { currentDate, ...options });
    if (!exRes.valid) {
      errors.push(...exRes.errors);
    }
    if (Array.isArray(options.exceptions)) {
      exceptionList = options.exceptions;
    } else if (options.exceptions && Array.isArray(options.exceptions.exceptions)) {
      exceptionList = options.exceptions.exceptions;
    } else {
      exceptionList = exRes.exceptions || [];
    }
  }

  let baselinedCount = 0;
  let exceptedCount = 0;
  const unbaselined = [];
  const usedExceptionIds = new Set();
  const usedExceptions = new Set();

  for (const finding of findings) {
    const findingFile = finding.file.replaceAll('\\', '/');

    // 1. Check baseline
    const inBaseline = baselineList.some((b) => {
      const bFile = (b.file || b.path || '').replaceAll('\\', '/');
      const fileMatches =
        bFile === findingFile || (bFile.length > 0 && findingFile.endsWith('/' + bFile));
      const ruleMatches = b.ruleId === finding.ruleId;
      const lineMatches = b.line === undefined || b.line === null || b.line === finding.startLine;
      return ruleMatches && fileMatches && lineMatches;
    });

    if (inBaseline) {
      const isHardRule = NON_BYPASSABLE_RULES.has(finding.ruleId);
      const isBlockingSeverity = ['CRITICAL', 'HIGH', 'ERROR'].includes(
        String(finding.severity || '').toUpperCase(),
      );
      if (isHardRule || isBlockingSeverity) {
        errors.push(
          `[Non-Bypassable Rule Violation] Non-bypassable rule or High/Critical/Error finding ${finding.ruleId} (${finding.severity}) in ${finding.file}:${finding.startLine} cannot be baselined`,
        );
        unbaselined.push(finding);
        continue;
      }
      baselinedCount += 1;
      continue;
    }

    // 2. Check exceptions
    const matchingException = exceptionList.find((ex) => {
      if (usedExceptions.has(ex) || (ex.id && usedExceptionIds.has(ex.id))) {
        return false;
      }

      if (ex.ruleId !== finding.ruleId) return false;

      const exFile = (ex.file || ex.path || '').replaceAll('\\', '/');
      const fileMatches =
        exFile === findingFile || (exFile.length > 0 && findingFile.endsWith('/' + exFile));
      if (!fileMatches) return false;

      const exLine = ex.line ?? ex.startLine;
      if (exLine !== undefined && exLine !== null && exLine !== finding.startLine) {
        return false;
      }

      if (
        ex.fingerprint !== undefined &&
        ex.fingerprint !== null &&
        ex.fingerprint !== finding.fingerprint
      ) {
        return false;
      }

      return true;
    });

    if (matchingException) {
      usedExceptions.add(matchingException);
      if (matchingException.id) {
        usedExceptionIds.add(matchingException.id);
      }

      // Non-bypassable rules and high/critical/error severities
      const isHardRule = NON_BYPASSABLE_RULES.has(finding.ruleId);
      const isBlockingSeverity = ['CRITICAL', 'HIGH', 'ERROR'].includes(
        String(finding.severity || '').toUpperCase(),
      );
      if (isHardRule || isBlockingSeverity) {
        errors.push(
          `[Non-Bypassable Rule Violation] Non-bypassable rule or High/Critical/Error finding ${finding.ruleId} (${finding.severity}) in ${finding.file}:${finding.startLine} cannot be bypassed by exception ${matchingException.id || 'N/A'}`,
        );
        unbaselined.push(finding);
        continue;
      }

      // Expired exceptions
      if (matchingException.expiresAt) {
        const expiryDate = new Date(matchingException.expiresAt);
        if (isNaN(expiryDate.getTime()) || expiryDate.getTime() < currentDate.getTime()) {
          errors.push(
            `[Exception Expired] Expired exception ${matchingException.id || 'unknown'} for rule ${finding.ruleId} expired at ${matchingException.expiresAt}`,
          );
          unbaselined.push(finding);
          continue;
        }
      }

      exceptedCount += 1;
      continue;
    }

    // Unbaselined finding
    unbaselined.push(finding);
    errors.push(
      `[SAST Violation] ${finding.ruleId} (${finding.severity}) at ${finding.file}:${finding.startLine}: ${finding.message}`,
    );
  }

  const passed = unbaselined.length === 0 && errors.length === 0;

  return {
    passed,
    totalFindings: findings.length,
    unbaselinedCount: unbaselined.length,
    baselinedCount,
    exceptedCount,
    errors,
    unbaselinedFindings: unbaselined,
  };
}

/**
 * Deterministic Python and TSX AST/semantic rule scanner when Semgrep CLI is unavailable.
 */
export function runAstFallbackScan(targetFiles, rootDir) {
  const findings = [];
  const errors = [];
  const pyFiles = targetFiles.filter((f) => f.endsWith('.py'));
  const tsxFiles = targetFiles.filter((f) => f.endsWith('.tsx') || f.endsWith('.jsx'));

  if (pyFiles.length > 0) {
    const pythonScript = `
import ast, sys, json, os

files = json.loads(sys.stdin.read())
findings = []
errors = []

tool_names = {
    'ToolNode', 'search_flights', 'booking_detail', 'booking_summaries',
    'get_preferences', 'check_booking_readiness', 'signal_checkout_intent', 'tool_function'
}
sensitive_tokens = {'prompt', 'user_input', 'raw_message', 'raw_payload', 'unredacted_output'}

for rel_path, full_path in files:
    norm_rel = rel_path.replace('\\\\', '/')
    is_test = '/tests/' in norm_rel or '/test/' in norm_rel or os.path.basename(norm_rel).startswith('test_') or norm_rel.endswith('.spec.ts') or norm_rel.endswith('.test.ts')
    if is_test:
        continue

    if not os.path.exists(full_path):
        errors.append(f"File not found: {norm_rel}")
        continue

    try:
        with open(full_path, 'rb') as f:
            tree = ast.parse(f.read())
    except Exception as e:
        errors.append(f"AST parse error in {norm_rel}: {str(e)}")
        continue

    is_guardrails = 'guardrails' in norm_rel
    is_agent = 'agent' in norm_rel

    class Visitor(ast.NodeVisitor):
        def visit_Call(self, node):
            func = node.func
            if is_guardrails:
                if isinstance(func, ast.Name) and func.id in ('ChatOpenAI', 'ChatAnthropic', 'ChatGoogleGenerativeAI', 'OpenAI'):
                    findings.append({'ruleId': 'no-llm-in-guardrails', 'file': norm_rel, 'line': node.lineno, 'message': 'LLM model initialization inside guardrails'})
                elif isinstance(func, ast.Attribute) and func.attr in ('invoke', 'ainvoke'):
                    findings.append({'ruleId': 'no-llm-in-guardrails', 'file': norm_rel, 'line': node.lineno, 'message': 'LLM invoke call inside guardrails'})

                if isinstance(func, ast.Name) and func.id in ('eval', 'exec', '__import__'):
                    findings.append({'ruleId': 'no-dynamic-imports-in-guardrails', 'file': norm_rel, 'line': node.lineno, 'message': 'Dynamic code execution/import in guardrails'})
                elif isinstance(func, ast.Attribute) and func.attr == 'import_module':
                    if isinstance(func.value, ast.Name) and func.value.id == 'importlib':
                        findings.append({'ruleId': 'no-dynamic-imports-in-guardrails', 'file': norm_rel, 'line': node.lineno, 'message': 'Dynamic importlib call in guardrails'})

            if is_guardrails or is_agent:
                if isinstance(func, ast.Name) and func.id in tool_names:
                    findings.append({'ruleId': 'no-unshielded-tool-execution', 'file': norm_rel, 'line': node.lineno, 'message': 'Direct unshielded tool invocation'})

            is_log = False
            if isinstance(func, ast.Attribute) and func.attr in ('debug', 'info', 'warning', 'error', 'critical', 'exception'):
                if (isinstance(func.value, ast.Name) and ('logger' in func.value.id.lower() or func.value.id == 'logging')) or \\
                   (isinstance(func.value, ast.Attribute) and 'logger' in func.value.attr.lower()):
                    is_log = True
            if is_log:
                found = False
                for arg in node.args:
                    arg_str = ast.unparse(arg).lower() if hasattr(ast, 'unparse') else str(arg)
                    if any(t in arg_str for t in sensitive_tokens):
                        found = True; break
                if not found:
                    for kw in node.keywords:
                        kw_str = ast.unparse(kw.value).lower() if hasattr(ast, 'unparse') else str(kw.value)
                        if any(t in kw_str for t in sensitive_tokens):
                            found = True; break
                if found:
                    findings.append({'ruleId': 'no-raw-payload-logging', 'file': norm_rel, 'line': node.lineno, 'message': 'Raw payload logging detected'})
            self.generic_visit(node)

    Visitor().visit(tree)

print(json.dumps({'findings': findings, 'errors': errors}))
`;
    try {
      const inputPayload = JSON.stringify(pyFiles.map((f) => [f, resolve(rootDir, f)]));
      const res = spawnSync('python', ['-c', pythonScript], {
        input: inputPayload,
        encoding: 'utf8',
      });
      if (res.error) {
        errors.push(`[AST Fallback Error] Python process failed to spawn: ${res.error.message}`);
      } else if (res.status !== 0) {
        errors.push(
          `[AST Fallback Error] Python process exited with status ${res.status}: ${res.stderr || res.stdout || 'Unknown error'}`,
        );
      } else if (res.stdout && res.stdout.trim()) {
        try {
          const parsed = JSON.parse(res.stdout);
          const pyMatches = Array.isArray(parsed) ? parsed : parsed.findings || [];
          const pyErrors = parsed.errors || [];
          for (const err of pyErrors) {
            errors.push(`[AST Fallback Error] ${err}`);
          }
          for (const m of pyMatches) {
            const normFile = m.file.replaceAll('\\', '/');
            const fp = computeFindingFingerprint(m.ruleId, normFile, m.line, m.message);
            findings.push({
              ruleId: m.ruleId,
              level: 'error',
              severity: 'ERROR',
              file: normFile,
              startLine: m.line,
              endLine: m.line,
              message: m.message,
              fingerprint: fp,
            });
          }
        } catch (jsonErr) {
          errors.push(
            `[AST Fallback Error] Failed to parse Python fallback JSON output: ${jsonErr.message}`,
          );
        }
      }
    } catch (err) {
      errors.push(`[AST Fallback Error] Python execution failed: ${err.message}`);
    }
  }

  for (const f of tsxFiles) {
    const fullPath = resolve(rootDir, f);
    const norm = f.replaceAll('\\', '/');
    if (
      norm.includes('/tests/') ||
      norm.includes('/test/') ||
      norm.endsWith('.spec.tsx') ||
      norm.endsWith('.test.tsx')
    ) {
      continue;
    }

    if (!existsSync(fullPath)) {
      errors.push(`[AST Fallback Error] TSX file does not exist: ${f}`);
      continue;
    }

    try {
      const content = readFileSync(fullPath, 'utf8');
      if (content.includes('dangerouslySetInnerHTML')) {
        const lines = content.split('\n');
        for (let l = 0; l < lines.length; l++) {
          if (lines[l].includes('dangerouslySetInnerHTML')) {
            const msg = 'Unsafe HTML interpolation via dangerouslySetInnerHTML';
            const fp = computeFindingFingerprint('safe-html-interpolation', norm, l + 1, msg);
            findings.push({
              ruleId: 'safe-html-interpolation',
              level: 'error',
              severity: 'ERROR',
              file: norm,
              startLine: l + 1,
              endLine: l + 1,
              message: msg,
              fingerprint: fp,
            });
          }
        }
      }
    } catch (err) {
      errors.push(`[AST Fallback Error] Failed to read TSX file ${f}: ${err.message}`);
    }
  }

  return { findings, errors };
}

/**
 * High-level SAST scan runner coordinating census, file resolution, Semgrep execution, and evaluation.
 */
export function runSastScan(options = {}) {
  const rootDir = options.rootDir ? resolve(options.rootDir) : defaultRepoRoot;
  const execFn = options.execFn || spawnSync;
  const mode = options.mode || 'full';
  const configs = options.configs || [
    resolve(rootDir, 'tests/security/sast/guardrails.yml'),
    resolve(rootDir, 'tests/security/sast/ruleset.yml'),
    ...DEFAULT_STANDARD_RULESETS,
  ];
  const sarifOutput = options.sarifOutput ? resolve(rootDir, options.sarifOutput) : null;

  const defaultBaselinePath = resolve(rootDir, 'tests/security/sast/baseline.json');
  const defaultExceptionsPath = resolve(rootDir, 'tests/security/exceptions.json');

  const baseline =
    options.baseline !== undefined
      ? options.baseline
        ? resolve(rootDir, options.baseline)
        : null
      : existsSync(defaultBaselinePath)
        ? defaultBaselinePath
        : null;

  const exceptions =
    options.exceptions !== undefined
      ? options.exceptions
        ? resolve(rootDir, options.exceptions)
        : null
      : existsSync(defaultExceptionsPath)
        ? defaultExceptionsPath
        : null;

  const errors = [];

  // Step 1: Run source file census
  const census = calculateFileCensus({
    rootDir,
    workspaces: options.workspaces,
    minCounts: options.minCounts,
  });

  if (!census.passed) {
    errors.push(...census.errors);
    return {
      passed: false,
      exitCode: 1,
      census,
      targetFiles: [],
      findings: [],
      unbaselinedFindings: [],
      errors,
    };
  }

  // Step 2: Resolve target files
  const targetResolution = resolveTargetFiles({
    rootDir,
    mode,
    workspaces: options.workspaces,
    gitDiffOutput: options.gitDiffOutput,
    execFn,
  });

  if (targetResolution.passed === false || (targetResolution.errors && targetResolution.errors.length > 0)) {
    errors.push(...(targetResolution.errors || ['[Git Diff Error] Failed to resolve target files']));
    return {
      passed: false,
      exitCode: 1,
      census,
      targetResolution,
      findings: [],
      unbaselinedFindings: [],
      errors,
    };
  }

  const targetFiles = targetResolution.files;

  // In diff mode with 0 files, pass immediately
  if (mode === 'diff' && targetFiles.length === 0) {
    return {
      passed: true,
      exitCode: 0,
      census,
      targetResolution,
      findings: [],
      unbaselinedFindings: [],
      errors: [],
    };
  }

  // Step 3: Check baseline and exceptions paths if specified
  if (options.baseline && !existsSync(baseline)) {
    errors.push(`[Baseline Error] Baseline file does not exist: ${baseline}`);
    return {
      passed: false,
      exitCode: 1,
      census,
      targetResolution,
      findings: [],
      unbaselinedFindings: [],
      errors,
    };
  }

  if (options.exceptions && !existsSync(exceptions)) {
    errors.push(`[Exceptions Error] Exceptions file does not exist: ${exceptions}`);
    return {
      passed: false,
      exitCode: 1,
      census,
      targetResolution,
      findings: [],
      unbaselinedFindings: [],
      errors,
    };
  }

  // Step 4: Build Semgrep CLI execution arguments
  const semgrepArgs = ['--sarif'];
  for (const cfg of configs) {
    const isRegistry = cfg.startsWith('p/') || cfg.startsWith('r/');
    if (!isRegistry && !existsSync(cfg)) {
      errors.push(`[SAST Config Error] Required config file does not exist: ${cfg}`);
      return {
        passed: false,
        exitCode: 1,
        census,
        targetResolution,
        findings: [],
        unbaselinedFindings: [],
        errors,
      };
    }
    semgrepArgs.push('--config', cfg);
  }

  semgrepArgs.push('--exclude', 'node_modules');
  semgrepArgs.push('--exclude', 'dist');
  semgrepArgs.push('--exclude', '.next');
  semgrepArgs.push('--exclude', '.venv');
  semgrepArgs.push('--exclude', '__pycache__');
  semgrepArgs.push('--exclude', '.pytest_cache');
  semgrepArgs.push('--exclude', 'fixtures');
  semgrepArgs.push('--exclude', 'tests/security/sast/fixtures');

  if (mode === 'diff') {
    semgrepArgs.push(...targetFiles);
  } else {
    const workspaces = options.workspaces || DEFAULT_WORKSPACES;
    semgrepArgs.push(...workspaces);
  }

  const strictScanner = options.strictScanner || options.strict || false;
  const canUseFallback =
    !strictScanner &&
    (options.allowAstFallback || (process.platform === 'win32' && !options.execFn));

  let scanRes;
  try {
    scanRes = execFn('semgrep', semgrepArgs, {
      cwd: rootDir,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
  } catch (err) {
    if (canUseFallback) {
      scanRes = null;
    } else {
      errors.push(
        `[SAST Execution Error] Semgrep CLI not found or failed to execute: ${err.message}`,
      );
      return {
        passed: false,
        exitCode: 1,
        census,
        targetResolution,
        findings: [],
        unbaselinedFindings: [],
        errors,
      };
    }
  }

  const scanStderr = (scanRes?.stderr || '').toLowerCase();
  const isMissingSemgrep =
    !scanRes ||
    scanRes.error ||
    scanStderr.includes('is not recognized') ||
    scanStderr.includes('command not found') ||
    scanStderr.includes('cannot find') ||
    scanStderr.includes('too long');

  if (isMissingSemgrep) {
    if (canUseFallback) {
      const fallbackResult = runAstFallbackScan(targetFiles, rootDir);
      const fallbackFindings = fallbackResult.findings || [];
      if (fallbackResult.errors && fallbackResult.errors.length > 0) {
        errors.push(...fallbackResult.errors);
      }

      const evalResult = evaluateFindings(fallbackFindings, {
        baseline,
        exceptions,
        currentDate: options.currentDate,
      });

      if (!evalResult.passed) {
        errors.push(...evalResult.errors);
      }

      const passed = evalResult.passed && errors.length === 0;
      return {
        passed,
        exitCode: passed ? 0 : 1,
        census,
        targetResolution,
        findings: fallbackFindings,
        unbaselinedFindings: evalResult.unbaselinedFindings || [],
        baselinedCount: evalResult.baselinedCount || 0,
        exceptedCount: evalResult.exceptedCount || 0,
        errors,
      };
    }

    const errMsg =
      scanRes?.error?.message || scanRes?.stderr?.trim() || 'Semgrep CLI not found in environment';
    errors.push(`[SAST Execution Error] Semgrep CLI not found or failed to execute: ${errMsg}`);
    return {
      passed: false,
      exitCode: 1,
      census,
      targetResolution,
      findings: [],
      unbaselinedFindings: [],
      errors,
    };
  }

  if (scanRes.status !== 0 && scanRes.status !== 1) {
    errors.push(
      `[SAST Crash] Semgrep crashed with exit status ${scanRes.status}:\n${scanRes.stderr || scanRes.stdout}`,
    );
    return {
      passed: false,
      exitCode: 1,
      census,
      targetResolution,
      findings: [],
      unbaselinedFindings: [],
      errors,
    };
  }

  const sarifRaw = scanRes.stdout || '';

  if (scanRes.status === 1 && sarifRaw.trim().length === 0) {
    errors.push(
      `[SAST Execution Error] Semgrep exited with status 1 without outputting results:\n${scanRes.stderr || 'No error output'}`,
    );
    return {
      passed: false,
      exitCode: 1,
      census,
      targetResolution,
      findings: [],
      unbaselinedFindings: [],
      errors,
    };
  }

  if (sarifOutput) {
    try {
      const sarifDir = dirname(sarifOutput);
      mkdirSync(sarifDir, { recursive: true });
      writeFileSync(sarifOutput, sarifRaw, 'utf8');
    } catch (err) {
      errors.push(
        `[SAST Output Error] Failed to write SARIF output to ${sarifOutput}: ${err.message}`,
      );
    }
  }

  let findings = [];
  try {
    findings = parseSarifResults(sarifRaw);
  } catch (err) {
    errors.push(`[SAST Parse Error] Failed to parse SARIF output: ${err.message}`);
    return {
      passed: false,
      exitCode: 1,
      census,
      targetResolution,
      findings: [],
      unbaselinedFindings: [],
      errors,
    };
  }

  const evalResult = evaluateFindings(findings, {
    baseline,
    exceptions,
    currentDate: options.currentDate,
  });

  if (!evalResult.passed) {
    errors.push(...evalResult.errors);
  }

  const passed = evalResult.passed && errors.length === 0;
  const exitCode = passed ? 0 : 1;

  return {
    passed,
    exitCode,
    census,
    targetResolution,
    findings,
    unbaselinedFindings: evalResult.unbaselinedFindings || [],
    baselinedCount: evalResult.baselinedCount || 0,
    exceptedCount: evalResult.exceptedCount || 0,
    errors,
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

  let mode = 'full';
  let sarifOutput = null;
  let baseline = undefined;
  let exceptions = undefined;
  let strictScanner = false;
  const configs = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--mode') {
      const val = argv[++i];
      if (val !== 'full' && val !== 'diff') {
        errFn(`Invalid mode "${val}". Must be "full" or "diff".`);
        return exitFn(1);
      }
      mode = val;
    } else if (arg === '--sarif-output') {
      sarifOutput = argv[++i];
    } else if (arg === '--baseline') {
      baseline = argv[++i];
    } else if (arg === '--exceptions') {
      exceptions = argv[++i];
    } else if (arg === '--config') {
      configs.push(argv[++i]);
    } else if (arg === '--strict-scanner') {
      strictScanner = true;
    } else {
      errFn(`Unknown option: ${arg}`);
      return exitFn(1);
    }
  }

  logFn('===============================================================');
  logFn('            STATIC APPLICATION SECURITY TESTING (SAST)         ');
  logFn('===============================================================');
  logFn(`Mode:        ${mode}`);
  if (sarifOutput) logFn(`SARIF Dest:  ${sarifOutput}`);
  if (baseline) logFn(`Baseline:    ${baseline}`);
  if (exceptions) logFn(`Exceptions:  ${exceptions}`);

  const scanOptions = {
    rootDir,
    mode,
    sarifOutput,
    baseline,
    exceptions,
    strictScanner,
    configs: configs.length > 0 ? configs : undefined,
  };
  if (execFn) scanOptions.execFn = execFn;

  const result = runSastScan(scanOptions);

  logFn('---------------------------------------------------------------');
  logFn(`Census Total: ${result.census?.totalFiles ?? 0} files scanned across workspaces`);
  for (const [ws, count] of Object.entries(result.census?.workspaceCounts ?? {})) {
    logFn(`  - ${ws}: ${count} files`);
  }
  logFn(`Total Findings:       ${result.findings?.length ?? 0}`);
  logFn(`Baselined Findings:   ${result.baselinedCount ?? 0}`);
  logFn(`Excepted Findings:    ${result.exceptedCount ?? 0}`);
  logFn(`Unbaselined Findings: ${result.unbaselinedFindings?.length ?? 0}`);
  logFn('---------------------------------------------------------------');

  if (result.passed) {
    logFn('>>> [SAST VERDICT]: PASSED (exit code 0)');
    logFn('===============================================================');
    return exitFn(0);
  } else {
    errFn('>>> [SAST VERDICT]: FAILED (exit code 1)');
    for (const err of result.errors) {
      errFn(`  - ${err}`);
    }
    logFn('===============================================================');
    return exitFn(1);
  }
}

// Direct CLI invocation
const isMain =
  process.argv[1] &&
  (import.meta.url === pathToFileURL(process.argv[1]).href ||
    resolve(process.argv[1]) === resolve(__filename));

if (isMain) {
  main();
}
