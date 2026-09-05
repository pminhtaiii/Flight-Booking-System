import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..', '..');
const defaultToolchainPath = resolve(repoRoot, 'tests/security/toolchain.json');

const DEFAULT_TOOL_VERSIONS = {
  semgrep: '1.88.0',
  zap: '2.15.0',
  gitleaks: 'v8.18.4',
  pipAudit: '2.7.3',
  pnpmAudit: '9.15.4',
  pytestCov: '7.1.0',
};

const FORBIDDEN_KEY_NAMES = new Set([
  'rawpayload',
  'prompt',
  'responsebody',
  'requestbody',
  'usermessage',
  'rawtext',
  'payload',
  'attackinput',
  'token',
  'secret',
  'authorization',
  'cookie',
  'cookies',
  'credentials',
  'password',
  'apikey',
  'privatekey',
  'accesstoken',
  'refreshtoken',
  'claimtoken',
  'jwt',
]);

/**
 * Redacts secrets, customer PII, and raw attack payloads from text.
 * @param {string} text
 * @returns {string}
 */
export function redactSensitiveText(text) {
  if (typeof text !== 'string') {
    return text;
  }

  let res = text;

  // 1. Secrets & Tokens
  res = res.replace(/Bearer\s+[a-zA-Z0-9._~+/-]+=*/gi, 'Bearer [REDACTED_SECRET]');
  res = res.replace(/\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9._~+/-]+\b/g, '[REDACTED_SECRET]');
  res = res.replace(/\bsk-[a-zA-Z0-9_-]{16,}\b/g, '[REDACTED_SECRET]');
  res = res.replace(/\bAIza[a-zA-Z0-9_-]{20,}\b/g, '[REDACTED_SECRET]');
  res = res.replace(/AGENT_SERVICE_API_KEY\s*[:=]\s*[^\s,;]+/gi, 'AGENT_SERVICE_API_KEY=[REDACTED_SECRET]');
  res = res.replace(/CLAIM_TOKEN_SECRET\s*[:=]\s*[^\s,;]+/gi, 'CLAIM_TOKEN_SECRET=[REDACTED_SECRET]');
  res = res.replace(/JWT_SECRET\s*[:=]\s*[^\s,;]+/gi, 'JWT_SECRET=[REDACTED_SECRET]');
  res = res.replace(/\bghp_[a-zA-Z0-9]{30,}\b/g, '[REDACTED_SECRET]');
  res = res.replace(/\bgithub_pat_[a-zA-Z0-9_]{30,}\b/g, '[REDACTED_SECRET]');

  // 2. Attack payloads (prompt injection, XSS, SQLi, raw HTTP)
  res = res.replace(
    /ignore\s+(?:all\s+)?(?:previous|above|prior)\s+(?:instructions|prompts|directions)[^\n.,;]*/gi,
    '[REDACTED_ATTACK_PAYLOAD]',
  );
  res = res.replace(
    /(?:system\s+prompt|dump\s+secrets|reveal\s+(?:all\s+)?(?:system|hidden)\s+(?:prompts|keys|instructions))[^\n.,;]*/gi,
    '[REDACTED_ATTACK_PAYLOAD]',
  );
  res = res.replace(/<\s*script[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, '[REDACTED_ATTACK_PAYLOAD]');
  res = res.replace(/<\s*script[^>]*>/gi, '[REDACTED_ATTACK_PAYLOAD]');
  res = res.replace(/<\s*img[^>]+onerror[^>]*>/gi, '[REDACTED_ATTACK_PAYLOAD]');
  res = res.replace(/javascript:\s*[^\s"']+/gi, '[REDACTED_ATTACK_PAYLOAD]');
  res = res.replace(
    /(?:SELECT\s+[\s\S]+?\s+FROM\s+[\s\S]+?|UNION\s+SELECT\s+[\s\S]+?|DROP\s+TABLE\s+\S+|INSERT\s+INTO\s+\S+|DELETE\s+FROM\s+\S+|['"]\s*OR\s*['"]?1['"]?\s*=\s*['"]?1(?:\s*--)?)/gi,
    '[REDACTED_ATTACK_PAYLOAD]',
  );
  res = res.replace(/(?:GET|POST|PUT|DELETE|PATCH)\s+\/[^\r\n]*\s+HTTP\/1\.[01][\s\S]*/gi, '[REDACTED_PAYLOAD]');
  res = res.replace(/HTTP\/1\.[01]\s+\d{3}\s+[\s\S]*/gi, '[REDACTED_PAYLOAD]');

  // 3. Customer PII
  res = res.replace(/\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g, '[REDACTED_PII]');
  res = res.replace(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '[REDACTED_PII]');
  res = res.replace(
    /\b(?:4[0-9]{3}|5[1-5][0-9]{2}|6011|3[47][0-9]{2})(?:[ -]?[0-9]{4}){3}\b/g,
    '[REDACTED_PII]',
  );
  res = res.replace(/\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4}\b/g, '[REDACTED_PII]');
  res = res.replace(/\b[A-Z][0-9]{8}\b/g, '[REDACTED_PII]');
  res = res.replace(/(?:passport(?: number)?[:\s]+)([A-Z0-9]{6,9})\b/gi, 'passport: [REDACTED_PII]');

  return res;
}

/**
 * Checks if key is considered forbidden by privacy invariants.
 * @param {string} key
 * @returns {boolean}
 */
function isForbiddenKey(key) {
  if (typeof key !== 'string') return false;
  const norm = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (FORBIDDEN_KEY_NAMES.has(norm)) return true;
  if (
    norm.includes('rawpayload') ||
    norm.includes('requestbody') ||
    norm.includes('responsebody') ||
    norm.includes('attackinput') ||
    norm.includes('usermessage')
  ) {
    return true;
  }
  return false;
}

/**
 * Recursively strips forbidden fields from objects and arrays.
 * @param {any} data
 * @returns {any}
 */
export function stripDisallowedFields(data) {
  if (data === null || typeof data !== 'object') {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => stripDisallowedFields(item));
  }

  const result = {};
  for (const [k, v] of Object.entries(data)) {
    if (isForbiddenKey(k)) {
      continue;
    }
    result[k] = stripDisallowedFields(v);
  }
  return result;
}

/**
 * Calculates 95% Wilson score confidence interval for a proportion.
 * Supports calculateConfidenceInterval(successes, total, confidence)
 * or calculateConfidenceInterval({ tp, fn }) / calculateConfidenceInterval({ successes, total }).
 *
 * @param {number|object} successesOrObj
 * @param {number} [total]
 * @param {number} [confidence=0.95]
 * @returns {{ lower: number, upper: number }}
 */
export function calculateConfidenceInterval(successesOrObj, total, confidence = 0.95) {
  let s = 0;
  let t = 0;

  if (typeof successesOrObj === 'object' && successesOrObj !== null) {
    if ('tp' in successesOrObj) {
      s = Number(successesOrObj.tp) || 0;
      t = s + (Number(successesOrObj.fn) || 0);
    } else if ('fp' in successesOrObj) {
      s = Number(successesOrObj.fp) || 0;
      t = s + (Number(successesOrObj.tn) || 0);
    } else if ('successes' in successesOrObj) {
      s = Number(successesOrObj.successes) || 0;
      t = Number(successesOrObj.total) || 0;
    }
  } else {
    s = Number(successesOrObj) || 0;
    t = Number(total) || 0;
  }

  if (!Number.isFinite(s) || !Number.isFinite(t) || t <= 0 || s < 0) {
    return { lower: 0, upper: 0 };
  }

  const z = confidence === 0.99 ? 2.57583 : confidence === 0.9 ? 1.64485 : 1.95996;
  const p = s / t;
  const denom = 1 + (z * z) / t;
  const center = (p + (z * z) / (2 * t)) / denom;
  const spread = (z * Math.sqrt((p * (1 - p)) / t + (z * z) / (4 * t * t))) / denom;

  const lower = Math.max(0, Math.round((center - spread) * 10000) / 10000);
  const upper = Math.min(1, Math.round((center + spread) * 10000) / 10000);

  return { lower, upper };
}

/**
 * Recursively applies text redaction to all strings in data structure.
 * @param {any} val
 * @returns {any}
 */
function deepRedactStrings(val) {
  if (typeof val === 'string') {
    return redactSensitiveText(val);
  }
  if (Array.isArray(val)) {
    return val.map(deepRedactStrings);
  }
  if (val !== null && typeof val === 'object') {
    const res = {};
    for (const [k, v] of Object.entries(val)) {
      res[k] = deepRedactStrings(v);
    }
    return res;
  }
  return val;
}

/**
 * Sanitizes an evidence record according to strict allowlist and privacy invariants.
 *
 * @param {any} rawRecord
 * @param {object} [options]
 * @param {string} [options.commitSha]
 * @param {string} [options.timestamp]
 * @param {string} [options.toolchainPath]
 * @returns {object} Strictly allowlisted, sanitized evidence record.
 */
export function sanitizeEvidenceRecord(rawRecord, options = {}) {
  const stripped = stripDisallowedFields(rawRecord || {});

  // 1. timestamp
  let timestamp = options.timestamp || stripped.timestamp;
  if (!timestamp || isNaN(Date.parse(timestamp))) {
    timestamp = new Date().toISOString();
  } else {
    timestamp = new Date(timestamp).toISOString();
  }

  // 2. commitSha
  let commitSha = options.commitSha || stripped.commitSha || 'unknown';
  if (typeof commitSha !== 'string') {
    commitSha = String(commitSha);
  }
  commitSha = redactSensitiveText(commitSha);

  // 3. toolVersions
  let defaultVersions = { ...DEFAULT_TOOL_VERSIONS };
  const toolchainFile = options.toolchainPath || defaultToolchainPath;
  if (existsSync(toolchainFile)) {
    try {
      const tc = JSON.parse(readFileSync(toolchainFile, 'utf8'));
      if (tc.scanners) {
        if (tc.scanners.semgrep?.cliVersion) defaultVersions.semgrep = tc.scanners.semgrep.cliVersion;
        if (tc.scanners.zap?.containerImage) {
          const m = tc.scanners.zap.containerImage.match(/:([0-9.]+)/);
          defaultVersions.zap = m ? m[1] : tc.scanners.zap.containerImage;
        }
        if (tc.scanners.gitleaks?.version) defaultVersions.gitleaks = tc.scanners.gitleaks.version;
        if (tc.scanners.pipAudit?.cliVersion) defaultVersions.pipAudit = tc.scanners.pipAudit.cliVersion;
        if (tc.scanners.pnpmAudit?.cliVersion) defaultVersions.pnpmAudit = tc.scanners.pnpmAudit.cliVersion;
        if (tc.scanners.pytestCov?.version) defaultVersions.pytestCov = tc.scanners.pytestCov.version;
      }
    } catch (err) {
      // Fallback to DEFAULT_TOOL_VERSIONS on parse or read error
      // eslint-disable-next-line no-console
      console.warn(`[write-report] Could not read toolchain file at ${toolchainFile}, using defaults: ${err?.message || err}`);
    }
  }

  const rawTools = stripped.toolVersions || {};
  const toolVersions = {
    semgrep: redactSensitiveText(String(rawTools.semgrep || defaultVersions.semgrep)),
    zap: redactSensitiveText(String(rawTools.zap || defaultVersions.zap)),
    gitleaks: redactSensitiveText(String(rawTools.gitleaks || defaultVersions.gitleaks)),
    pipAudit: redactSensitiveText(String(rawTools.pipAudit || defaultVersions.pipAudit)),
    pnpmAudit: redactSensitiveText(String(rawTools.pnpmAudit || defaultVersions.pnpmAudit)),
    pytestCov: redactSensitiveText(String(rawTools.pytestCov || defaultVersions.pytestCov)),
  };

  // 4. testCounts
  const rawCounts = stripped.testCounts || {};
  const testCounts = {
    total: Number(rawCounts.total) || 0,
    passed: Number(rawCounts.passed) || 0,
    failed: Number(rawCounts.failed) || 0,
    skipped: Number(rawCounts.skipped) || 0,
    durationMs: Number(rawCounts.durationMs) || 0,
  };

  // 5. detectorEvaluation
  const rawDet = stripped.detectorEvaluation || {};
  const rawStages = rawDet.stages || {};
  const defaultStage = {
    tp: 0,
    fp: 0,
    tn: 0,
    fn: 0,
    tpr: 0,
    fpr: 0,
    precision: 0,
    recall: 0,
  };

  function sanitizeStage(stageData) {
    if (!stageData || typeof stageData !== 'object') return { ...defaultStage };
    const tp = Number(stageData.tp) || 0;
    const fp = Number(stageData.fp) || 0;
    const tn = Number(stageData.tn) || 0;
    const fn = Number(stageData.fn) || 0;

    const tpr = tp + fn > 0 ? Math.round((tp / (tp + fn)) * 10000) / 10000 : 0;
    const fpr = fp + tn > 0 ? Math.round((fp / (fp + tn)) * 10000) / 10000 : 0;
    const precision = tp + fp > 0 ? Math.round((tp / (tp + fp)) * 10000) / 10000 : 0;
    const recall = tpr;

    return { tp, fp, tn, fn, tpr, fpr, precision, recall };
  }

  const stages = {
    input: sanitizeStage(rawStages.input),
    tool: sanitizeStage(rawStages.tool),
    output: sanitizeStage(rawStages.output),
  };

  const tp = stages.input.tp + stages.tool.tp + stages.output.tp;
  const fp = stages.input.fp + stages.tool.fp + stages.output.fp;
  const tn = stages.input.tn + stages.tool.tn + stages.output.tn;
  const fn = stages.input.fn + stages.tool.fn + stages.output.fn;

  if (rawDet.aggregate && typeof rawDet.aggregate === 'object') {
    const rawTp = Number(rawDet.aggregate.tp) || 0;
    const rawFp = Number(rawDet.aggregate.fp) || 0;
    const rawTn = Number(rawDet.aggregate.tn) || 0;
    const rawFn = Number(rawDet.aggregate.fn) || 0;

    if (rawTp !== tp || rawFp !== fp || rawTn !== tn || rawFn !== fn) {
      throw new Error(
        `[Contradictory Evidence] detectorEvaluation.aggregate counts contradict per-stage sums: derived (tp=${tp}, fp=${fp}, tn=${tn}, fn=${fn}) vs aggregate (tp=${rawTp}, fp=${rawFp}, tn=${rawTn}, fn=${rawFn})`,
      );
    }
  }

  const tpr = tp + fn > 0 ? Math.round((tp / (tp + fn)) * 10000) / 10000 : 0;
  const fpr = fp + tn > 0 ? Math.round((fp / (fp + tn)) * 10000) / 10000 : 0;
  const aggregate = { tp, fp, tn, fn, tpr, fpr };

  const confidenceIntervals = {
    tpr: calculateConfidenceInterval(aggregate.tp, aggregate.tp + aggregate.fn, 0.95),
    fpr: calculateConfidenceInterval(aggregate.fp, aggregate.fp + aggregate.tn, 0.95),
  };

  const detectorEvaluation = {
    stages,
    aggregate,
    confidenceIntervals,
  };

  // 6. invariantEvaluation
  const rawInv = stripped.invariantEvaluation || {};
  const invTotal = Number(rawInv.total) || 0;
  const invPassed = Number(rawInv.passed) || 0;
  const invFailed = Number(rawInv.failed) || 0;
  const passRate =
    rawInv.passRate !== undefined
      ? Number(rawInv.passRate)
      : invTotal > 0
        ? Math.round((invPassed / invTotal) * 10000) / 10000
        : 1.0;

  const invariantEvaluation = {
    total: invTotal,
    passed: invPassed,
    failed: invFailed,
    passRate,
  };

  // 7. scannerSummary
  const rawScanner = stripped.scannerSummary || {};
  const rawFindings = Array.isArray(rawScanner.findings) ? rawScanner.findings : [];

  const sanitizedFindings = [];
  const severityCounts = {
    Critical: 0,
    High: 0,
    Medium: 0,
    Low: 0,
    Informational: 0,
  };

  for (const f of rawFindings) {
    if (!f || typeof f !== 'object') continue;
    let severity = f.severity || 'Medium';
    // Normalize severity label
    const sevNorm = String(severity).toLowerCase();
    if (sevNorm.includes('crit')) severity = 'Critical';
    else if (sevNorm.includes('high') || sevNorm === 'error') severity = 'High';
    else if (sevNorm.includes('med') || sevNorm === 'warning') severity = 'Medium';
    else if (sevNorm.includes('low')) severity = 'Low';
    else severity = 'Informational';

    if (severity in severityCounts) {
      severityCounts[severity]++;
    }

    const finding = {
      ruleId: redactSensitiveText(String(f.ruleId || f.id || 'unknown-rule')),
      severity,
      scanner: redactSensitiveText(String(f.scanner || 'unknown')),
      fingerprint: redactSensitiveText(String(f.fingerprint || 'unknown-fingerprint')),
      file: redactSensitiveText(String(f.file || f.path || 'unknown-file')),
    };

    sanitizedFindings.push(finding);
  }

  // Validate or populate explicit counts from rawScanner if present
  if (rawScanner.counts && typeof rawScanner.counts === 'object') {
    if (sanitizedFindings.length > 0) {
      for (const [k, rawV] of Object.entries(rawScanner.counts)) {
        if (k in severityCounts) {
          const v = typeof rawV === 'number' ? rawV : Number(rawV);
          if (Number.isFinite(v) && severityCounts[k] !== v) {
            throw new Error(
              `[Contradictory Evidence] scannerSummary.counts.${k} contradicts sanitized findings: explicit count ${v} does not match findings count ${severityCounts[k]}`,
            );
          }
        }
      }
    } else {
      for (const [k, rawV] of Object.entries(rawScanner.counts)) {
        if (k in severityCounts) {
          const v = typeof rawV === 'number' ? rawV : Number(rawV);
          if (Number.isFinite(v)) {
            severityCounts[k] = v;
          }
        }
      }
    }
  }

  const scannerSummary = {
    counts: severityCounts,
    Critical: severityCounts.Critical,
    High: severityCounts.High,
    Medium: severityCounts.Medium,
    Low: severityCounts.Low,
    Informational: severityCounts.Informational,
    findings: sanitizedFindings,
  };

  const finalRecord = {
    timestamp,
    commitSha,
    toolVersions,
    testCounts,
    detectorEvaluation,
    invariantEvaluation,
    scannerSummary,
  };

  return deepRedactStrings(finalRecord);
}

/**
 * Writes sanitized evidence report to JSON file.
 *
 * @param {string|object} rawInput Path to raw report file, or parsed raw object.
 * @param {string} outputPath Target path to write sanitized report.
 * @param {object} [options] Options including commitSha, timestamp.
 * @returns {object} Sanitized evidence report.
 */
export function writeSanitizedReport(rawInput, outputPath, options = {}) {
  let rawData = rawInput;
  if (typeof rawInput === 'string') {
    if (!existsSync(rawInput)) {
      throw new Error(`Input report file does not exist: ${rawInput}`);
    }
    const content = readFileSync(rawInput, 'utf8');
    rawData = JSON.parse(content);
  }

  const sanitized = sanitizeEvidenceRecord(rawData, options);

  const targetDir = dirname(resolve(outputPath));
  mkdirSync(targetDir, { recursive: true });

  writeFileSync(resolve(outputPath), JSON.stringify(sanitized, null, 2) + '\n', 'utf8');

  return sanitized;
}

// CLI Execution
/* eslint-disable no-console */
const isMain =
  process.argv[1] &&
  (import.meta.url === pathToFileURL(process.argv[1]).href ||
    resolve(process.argv[1]) === resolve(__filename));

if (isMain) {
  const args = process.argv.slice(2);
  let inputPath = null;
  let outputPath = null;
  let commitSha = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--input' || arg === '-i') {
      inputPath = args[++i];
    } else if (arg === '--output' || arg === '-o') {
      outputPath = args[++i];
    } else if (arg === '--commit-sha' || arg === '--sha' || arg === '-c') {
      commitSha = args[++i];
    }
  }

  if (!inputPath || !outputPath) {
    console.error('Usage: node write-report.mjs --input <input-path> --output <output-path> [--commit-sha <sha>]');
    process.exit(1);
  }

  try {
    const result = writeSanitizedReport(inputPath, outputPath, { commitSha });
    console.log(`[Evidence Writer] Successfully wrote sanitized evidence report to ${outputPath}`);
    console.log(`  Commit SHA: ${result.commitSha}`);
    console.log(`  Timestamp: ${result.timestamp}`);
    console.log(`  Total tests: ${result.testCounts.total}`);
    console.log(
      `  Detector TPR: ${(result.detectorEvaluation.aggregate.tpr * 100).toFixed(2)}%, FPR: ${(result.detectorEvaluation.aggregate.fpr * 100).toFixed(2)}%`,
    );
    console.log(`  Invariants pass rate: ${(result.invariantEvaluation.passRate * 100).toFixed(2)}%`);
    console.log(`  Sanitized findings: ${result.scannerSummary.findings.length}`);
    process.exit(0);
  } catch (err) {
    console.error(`[Evidence Writer Error] ${err.message}`);
    process.exit(1);
  }
}
