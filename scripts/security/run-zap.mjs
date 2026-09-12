import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { writeSanitizedReport } from './write-report.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..', '..');

const defaultToolchainPath = resolve(repoRoot, 'tests/security/toolchain.json');
const defaultZapDir = resolve(repoRoot, 'tests/security/zap');
const defaultConfigFile = 'automation.yaml';
const defaultOutputPath = resolve(repoRoot, 'artifacts/security/zap-report.json');
const defaultRawReportPath = resolve(defaultZapDir, 'zap-raw-report.json');

export const ALLOWED_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
export const ALLOWED_PORTS = new Set([3000, 3001, 3002, 3301, 3302, 3400]);

/**
 * Validates target URLs to enforce strict loopback scope boundaries.
 * Targets must be on 127.0.0.1 or localhost and on allowed ports: 3000, 3001, 3002, 3301, 3302, 3400.
 *
 * @param {string|string[]|object} targets
 * @returns {boolean} true if all targets are in scope, false otherwise
 */
export function validateScope(targets) {
  if (!targets) return false;

  let list = [];
  if (typeof targets === 'string') {
    const trimmed = targets.trim();
    if (!trimmed) return false;
    list = [trimmed];
  } else if (Array.isArray(targets)) {
    if (targets.length === 0) return false;
    list = targets;
  } else if (typeof targets === 'object' && Array.isArray(targets.targets)) {
    if (targets.targets.length === 0) return false;
    list = targets.targets;
  } else {
    return false;
  }

  for (const item of list) {
    if (typeof item !== 'string' || !item.trim()) return false;
    try {
      const parsed = new URL(item);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return false;
      }
      const host = parsed.hostname.toLowerCase();
      if (!ALLOWED_LOOPBACK_HOSTS.has(host)) {
        return false;
      }
      if (!parsed.port) {
        return false;
      }
      const portNum = parseInt(parsed.port, 10);
      if (!ALLOWED_PORTS.has(portNum)) {
        return false;
      }
    } catch {
      return false;
    }
  }

  return true;
}

/**
 * Validates a redirect target URL to ensure it satisfies loopback scope boundaries.
 * Relative redirect paths are resolved against baseUrl (defaulting to loopback).
 * Absolute redirect targets must be on an allowed loopback host and port.
 *
 * @param {string} redirectTarget URL or path from redirect Location header
 * @param {string} [baseUrl] Base URL to resolve relative redirects against
 * @returns {boolean} true if redirect destination is in scope, false otherwise
 */
export function validateRedirectScope(redirectTarget, baseUrl) {
  if (!redirectTarget || typeof redirectTarget !== 'string') return false;
  const trimmed = redirectTarget.trim();
  if (!trimmed) return false;

  try {
    const base = baseUrl ? new URL(baseUrl) : new URL('http://127.0.0.1:3000');
    if (baseUrl && !validateScope(baseUrl)) {
      return false;
    }
    const resolved = new URL(trimmed, base);
    return validateScope(resolved.href);
  } catch {
    return false;
  }
}

/**
 * Reads pinned ZAP image digest from toolchain.json and builds docker execution arguments.
 *
 * @param {object} [options]
 * @param {string} [options.toolchainPath]
 * @param {string} [options.zapDir]
 * @param {string} [options.configFile]
 * @param {string} [options.user]
 * @param {string} [options.network]
 * @param {string[]} [options.extraDockerArgs]
 * @returns {string[]} Docker run argument array
 */
export function buildZapDockerArgs(options = {}) {
  const toolchainFile = options.toolchainPath || defaultToolchainPath;
  let pinnedImage =
    'zaproxy/zap-stable:2.15.0@sha256:2d184081c7ff8be2ad7500599a0d4c82c3cfa5d95b542013fbe40d346ffc0303';

  if (existsSync(toolchainFile)) {
    try {
      const toolchain = JSON.parse(readFileSync(toolchainFile, 'utf8'));
      if (toolchain.scanners?.zap?.pinnedImage) {
        pinnedImage = toolchain.scanners.zap.pinnedImage;
      }
    } catch {
      // Fallback to default pinned image
    }
  }

  const zapDir = resolve(options.zapDir || options.workDir || defaultZapDir);
  const configFile = options.configFile || defaultConfigFile;

  const args = ['run', '--rm', '-t'];

  if (options.user) {
    args.push('--user', options.user);
  }

  if (options.network) {
    args.push('--network', options.network);
  }

  if (Array.isArray(options.extraDockerArgs)) {
    args.push(...options.extraDockerArgs);
  }

  args.push(
    '-v',
    `${zapDir}:/zap/wrk/:rw`,
    pinnedImage,
    'zap.sh',
    '-cmd',
    '-autorun',
    `/zap/wrk/${configFile}`,
  );

  return args;
}

/**
 * Evaluates raw ZAP report findings and determines exit code and counts.
 *
 * Exit codes:
 * 0: Clean scan (0 High/Critical findings)
 * 1: Policy failure (>= 1 High or Critical alert detected)
 * 2: Report evaluation error (missing, empty, unparseable, or invalid report)
 *
 * @param {string|object} rawReportPathOrObject
 * @returns {object} Evaluation results with exitCode, counts, and findings
 */
export function evaluateZapReport(rawReportPathOrObject) {
  if (rawReportPathOrObject === null || rawReportPathOrObject === undefined) {
    return { exitCode: 2, error: 'Report input is null or undefined' };
  }

  let data = rawReportPathOrObject;
  if (typeof rawReportPathOrObject === 'string') {
    const trimmed = rawReportPathOrObject.trim();
    if (!trimmed) {
      return { exitCode: 2, error: 'Report path or content is empty' };
    }

    if (existsSync(rawReportPathOrObject)) {
      try {
        const content = readFileSync(rawReportPathOrObject, 'utf8');
        if (!content.trim()) {
          return { exitCode: 2, error: `Report file is empty: ${rawReportPathOrObject}` };
        }
        data = JSON.parse(content);
      } catch (err) {
        return { exitCode: 2, error: `Failed to read or parse report file: ${err.message}` };
      }
    } else {
      try {
        data = JSON.parse(trimmed);
      } catch {
        return { exitCode: 2, error: `Report file does not exist: ${rawReportPathOrObject}` };
      }
    }
  }

  if (!data || typeof data !== 'object') {
    return { exitCode: 2, error: 'Invalid report data structure' };
  }

  if (
    data.authFailed === true ||
    data.authFailure === true ||
    data.authenticationFailed === true ||
    data.authenticationStatus === 'failed'
  ) {
    return { exitCode: 2, error: 'Authentication failure reported during scan' };
  }

  if (Array.isArray(data.authErrors) && data.authErrors.length > 0) {
    return { exitCode: 2, error: `Authentication errors during scan: ${data.authErrors.join(', ')}` };
  }

  if (Array.isArray(data.authenticatedEndpoints) && data.authenticatedEndpoints.length > 0) {
    const allAuthFailed = data.authenticatedEndpoints.every((ep) => {
      const status = Number(ep.status || ep.statusCode || ep.responseCode);
      return status === 401 || status === 403;
    });
    if (allAuthFailed) {
      return { exitCode: 2, error: 'All authenticated endpoints returned 401 or 403 status codes' };
    }
  }

  if (Array.isArray(data.messages) && data.messages.length > 0) {
    const authMessages = data.messages.filter((m) => m.authenticated === true || m.auth === true);
    if (authMessages.length > 0) {
      const allAuthFailed = authMessages.every((m) => {
        const status = Number(m.status || m.statusCode || m.responseCode);
        return status === 401 || status === 403;
      });
      if (allAuthFailed) {
        return { exitCode: 2, error: 'All authenticated endpoints returned 401 or 403 status codes' };
      }
    }
  }

  if (data.scannedUrls !== undefined && Number(data.scannedUrls) === 0) {
    return { exitCode: 2, error: 'Scan completed with 0 scanned URLs' };
  }
  if (data.totalScannedUrls !== undefined && Number(data.totalScannedUrls) === 0) {
    return { exitCode: 2, error: 'Scan completed with 0 scanned URLs' };
  }
  if (data.urlCount !== undefined && Number(data.urlCount) === 0) {
    return { exitCode: 2, error: 'Scan completed with 0 scanned URLs' };
  }
  if (Array.isArray(data.urls) && data.urls.length === 0) {
    return { exitCode: 2, error: 'Scan completed with 0 scanned URLs' };
  }
  if (Array.isArray(data.site) && data.site.length === 0) {
    return { exitCode: 2, error: 'Scan report contains empty sites array (0 URLs scanned)' };
  }

  const hasSite = Boolean(data.site);
  const hasAlerts = Array.isArray(data.alerts) && data.alerts.length > 0;
  const hasFindings = Array.isArray(data.findings) && data.findings.length > 0;
  const hasRuns = Array.isArray(data.runs) && data.runs.length > 0;
  const hasSummary = Boolean(data.scannerSummary && Array.isArray(data.scannerSummary.findings) && data.scannerSummary.findings.length > 0);
  const hasArrayRoot = Array.isArray(data) && data.length > 0;
  const hasUrls = Array.isArray(data.urls) && data.urls.length > 0;

  if (!hasSite && !hasAlerts && !hasFindings && !hasRuns && !hasSummary && !hasArrayRoot && !hasUrls) {
    return { exitCode: 2, error: 'Empty scan report with no scanned sites, URLs, or findings' };
  }

  let rawAlerts = [];
  if (data.site) {
    const sites = Array.isArray(data.site) ? data.site : [data.site];
    for (const s of sites) {
      if (s?.alerts) {
        const siteAlerts = Array.isArray(s.alerts) ? s.alerts : [s.alerts];
        for (const a of siteAlerts) {
          rawAlerts.push({ ...a, siteName: s['@name'] || s.name || '' });
        }
      }
    }
  } else if (Array.isArray(data.alerts)) {
    rawAlerts = data.alerts;
  } else if (Array.isArray(data.findings)) {
    rawAlerts = data.findings;
  } else if (data.scannerSummary && Array.isArray(data.scannerSummary.findings)) {
    rawAlerts = data.scannerSummary.findings;
  } else if (Array.isArray(data.runs) && data.runs[0]?.results) {
    rawAlerts = data.runs[0].results.map((r) => ({
      ruleId: r.ruleId,
      alert: r.message?.text,
      level: r.level,
      uri: r.locations?.[0]?.physicalLocation?.artifactLocation?.uri,
    }));
  } else if (Array.isArray(data)) {
    rawAlerts = data;
  }

  let criticalCount = 0;
  let highCount = 0;
  let mediumCount = 0;
  let lowCount = 0;
  let infoCount = 0;
  const findings = [];

  for (const alert of rawAlerts) {
    if (!alert || typeof alert !== 'object') continue;

    let severity = 'Informational';
    const riskCode = alert.riskcode !== undefined ? String(alert.riskcode) : '';

    if (riskCode === '4') {
      severity = 'Critical';
      criticalCount++;
    } else if (riskCode === '3') {
      severity = 'High';
      highCount++;
    } else if (riskCode === '2') {
      severity = 'Medium';
      mediumCount++;
    } else if (riskCode === '1') {
      severity = 'Low';
      lowCount++;
    } else if (riskCode === '0') {
      severity = 'Informational';
      infoCount++;
    } else {
      // Parse from riskDesc or severity string without confidence in parentheses (e.g. "Medium (High)")
      const primaryRisk = String(
        alert.severity || alert.level || alert.riskdesc || alert.risk || '',
      )
        .split('(')[0]
        .trim()
        .toLowerCase();

      if (primaryRisk.includes('crit')) {
        severity = 'Critical';
        criticalCount++;
      } else if (primaryRisk.includes('high') || primaryRisk === 'error') {
        severity = 'High';
        highCount++;
      } else if (primaryRisk.includes('med') || primaryRisk === 'warning') {
        severity = 'Medium';
        mediumCount++;
      } else if (primaryRisk.includes('low')) {
        severity = 'Low';
        lowCount++;
      } else {
        severity = 'Informational';
        infoCount++;
      }
    }

    const ruleId = String(
      alert.alertRef || alert.pluginid || alert.ruleId || alert.id || 'zap-alert',
    );
    const name = String(alert.alert || alert.name || alert.title || ruleId);
    const file = String(
      alert.uri || alert.url || alert.file || alert.siteName || 'http://127.0.0.1:3000',
    );
    const fingerprint = alert.fingerprint || `${ruleId}:${file}`;

    findings.push({
      ruleId,
      name,
      severity,
      scanner: 'zap',
      fingerprint,
      file,
      description: alert.desc || alert.description || '',
      solution: alert.solution || '',
      cweid: alert.cweid || '',
      wascid: alert.wascid || '',
    });
  }

  const exitCode = criticalCount > 0 || highCount > 0 ? 1 : 0;

  return {
    exitCode,
    criticalCount,
    highCount,
    mediumCount,
    lowCount,
    infoCount,
    findings,
  };
}

/**
 * Executes a docker command with bounded timeout, Windows taskkill, and POSIX SIGKILL termination.
 *
 * @param {string[]} args
 * @param {object} [options]
 * @returns {Promise<void>}
 */
export function runDockerCommand(args, { timeoutMs = 600000, signal, cwd = repoRoot, env } = {}) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn('docker', args, {
      cwd,
      env: env || process.env,
      shell: false,
      stdio: 'inherit',
      windowsHide: true,
      detached: process.platform !== 'win32',
    });

    let failure = null;
    let killer = null;

    const terminate = () => {
      failure = new Error('ZAP_EXECUTION_ABORTED_OR_TIMED_OUT');
      if (child.pid) {
        if (process.platform === 'win32') {
          killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
          killer.on('error', () => child.kill());
        } else {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }
      }
    };

    const timer = setTimeout(terminate, timeoutMs);
    signal?.addEventListener('abort', terminate, { once: true });

    const finish = (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', terminate);
      if (error) reject(error);
      else resolveCommand();
    };

    child.once('error', (err) => finish(new Error(`Docker execution error: ${err.message}`)));
    child.once('close', (code) => {
      finish(failure || (code === 0 ? undefined : new Error(`Docker exited with code ${code}`)));
    });

    if (signal?.aborted) terminate();
  });
}

/**
 * Runs the OWASP ZAP scan orchestration, evaluating results and outputting sanitized reports.
 *
 * @param {object} [options]
 * @param {string|string[]} [options.scope] Target scope URLs
 * @param {boolean} [options.dryRun]
 * @param {string} [options.configFile]
 * @param {string} [options.rawReportPath]
 * @param {string} [options.output]
 * @param {number} [options.timeout]
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal]
 * @param {string} [options.commitSha]
 * @param {string} [options.toolchainPath]
 * @param {object} [dependencies] Injected dependencies for testing
 * @returns {Promise<object>} Orchestration results with exitCode and findings
 */
export async function runZap(options = {}, dependencies = {}) {
  const scope =
    options.scope || [
      'http://127.0.0.1:3000',
      'http://127.0.0.1:3001',
      'http://127.0.0.1:3002',
    ];

  if (!validateScope(scope)) {
    return {
      exitCode: 2,
      error: `Invalid scope: targets must be local loopback addresses (127.0.0.1 or localhost on ports 3000, 3001, 3002, 3301, 3302, 3400). Got: ${JSON.stringify(scope)}`,
    };
  }

  const toolchainPath = options.toolchainPath || defaultToolchainPath;
  const dockerArgs = buildZapDockerArgs({ ...options, toolchainPath });

  if (options.dryRun) {
    return {
      exitCode: 0,
      dryRun: true,
      dockerArgs,
      scope,
    };
  }

  const runner = dependencies.dockerRunner || dependencies.command || runDockerCommand;
  const evaluator = dependencies.reportEvaluator || evaluateZapReport;
  const reportWriter = dependencies.reportWriter || writeSanitizedReport;

  let timeoutMs = 600000;
  if (options.timeoutMs !== undefined && options.timeoutMs !== null) {
    timeoutMs = Number(options.timeoutMs);
  } else if (options.timeout !== undefined && options.timeout !== null) {
    timeoutMs = Number(options.timeout) * 1000;
  }

  const controller = new AbortController();
  if (options.signal) {
    options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const startedAt = Date.now();

  try {
    await runner(dockerArgs, {
      timeoutMs,
      signal: controller.signal,
      cwd: repoRoot,
    });
  } catch (err) {
    return {
      exitCode: 3,
      error: err.message || 'ZAP docker runner failed or timed out',
      durationMs: Date.now() - startedAt,
    };
  }

  const rawReportPath = options.rawReportPath || defaultRawReportPath;
  const rawReportInput = options.rawReport !== undefined ? options.rawReport : rawReportPath;
  const evaluation = evaluator(rawReportInput);

  if (evaluation.exitCode === 2) {
    return {
      exitCode: 2,
      error: evaluation.error || 'Failed to evaluate ZAP report',
      durationMs: Date.now() - startedAt,
    };
  }

  const outputPath = options.output || defaultOutputPath;
  const durationMs = Date.now() - startedAt;

  const evidenceRecord = {
    timestamp: new Date().toISOString(),
    commitSha: options.commitSha,
    testCounts: {
      total: evaluation.findings.length,
      passed:
        evaluation.criticalCount + evaluation.highCount === 0
          ? evaluation.findings.length
          : 0,
      failed: evaluation.criticalCount + evaluation.highCount,
      skipped: 0,
      durationMs,
    },
    scannerSummary: {
      counts: {
        Critical: evaluation.criticalCount,
        High: evaluation.highCount,
        Medium: evaluation.mediumCount,
        Low: evaluation.lowCount,
        Informational: evaluation.infoCount,
      },
      findings: evaluation.findings.map((f) => ({
        ruleId: f.ruleId,
        severity: f.severity,
        scanner: 'zap',
        fingerprint: f.fingerprint || `${f.ruleId}:${f.file}`,
        file: f.file,
      })),
    },
  };

  let sanitized = null;
  try {
    sanitized = reportWriter(evidenceRecord, outputPath, {
      commitSha: options.commitSha,
      toolchainPath,
    });
  } catch (err) {
    return {
      exitCode: 2,
      error: `Failed to write sanitized evidence report: ${err.message}`,
      durationMs,
    };
  }

  return {
    exitCode: evaluation.exitCode,
    criticalCount: evaluation.criticalCount,
    highCount: evaluation.highCount,
    mediumCount: evaluation.mediumCount,
    lowCount: evaluation.lowCount,
    infoCount: evaluation.infoCount,
    findings: evaluation.findings,
    reportPath: outputPath,
    sanitized,
    durationMs,
  };
}

/**
 * Parses command-line arguments into an options object.
 *
 * @param {string[]} args
 * @returns {object} Parsed CLI options
 */
export function parseCliArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--scope') {
      const val = args[++i];
      if (val) {
        options.scope = val
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      }
    } else if (arg === '--config' || arg === '-c') {
      options.configFile = args[++i];
    } else if (arg === '--output' || arg === '-o') {
      options.output = args[++i];
    } else if (arg === '--raw-report') {
      options.rawReportPath = args[++i];
    } else if (arg === '--timeout') {
      options.timeout = args[++i];
    } else if (arg === '--toolchain') {
      options.toolchainPath = args[++i];
    }
  }
  return options;
}

const USAGE_TEXT = `Usage: node scripts/security/run-zap.mjs [options]

OWASP ZAP DAST scan runner for local loopback verification.

Options:
  --help, -h          Show help and usage information
  --dry-run           Validate configuration and arguments without running container
  --scope <urls>      Comma-separated loopback URLs (must be 127.0.0.1 or localhost on allowed ports: 3000-3002, 3301, 3302, 3400)
  --config, -c <path> Path to automation.yaml config file
  --output, -o <path> Output path for sanitized report (default: artifacts/security/zap-report.json)
  --raw-report <path> Path where raw ZAP JSON report is written
  --timeout <sec>     Execution timeout in seconds (default: 600)
  --toolchain <path>  Path to toolchain.json configuration

Exit Codes:
  0: Clean scan (0 High/Critical findings)
  1: Policy failure (>= 1 High/Critical findings detected)
  2: Report evaluation error or invalid scope
  3: ZAP container runner execution crash or timeout
`;

/* eslint-disable no-console */
async function main() {
  const options = parseCliArgs(process.argv.slice(2));

  if (options.help) {
    console.log(USAGE_TEXT);
    process.exit(0);
  }

  const controller = new AbortController();
  const handleInterrupt = () => controller.abort();
  process.once('SIGINT', handleInterrupt);
  process.once('SIGTERM', handleInterrupt);

  try {
    const result = await runZap({ ...options, signal: controller.signal });

    if (result.dryRun) {
      console.log('[ZAP Runner] Dry-run parameter validation succeeded.');
      console.log(`[ZAP Runner] Docker command args: ${result.dockerArgs.join(' ')}`);
      process.exit(0);
    }

    if (result.exitCode === 0) {
      console.log('[ZAP Runner] Clean scan: 0 High/Critical findings detected.');
      console.log(`[ZAP Runner] Sanitized report written to: ${result.reportPath}`);
      process.exit(0);
    } else if (result.exitCode === 1) {
      console.error(
        `[ZAP Runner Policy Failure] Detected ${result.highCount} High and ${result.criticalCount} Critical alerts.`,
      );
      if (result.reportPath) {
        console.error(`[ZAP Runner] Sanitized report written to: ${result.reportPath}`);
      }
      process.exit(1);
    } else if (result.exitCode === 2) {
      console.error(`[ZAP Runner Report/Scope Error] ${result.error}`);
      process.exit(2);
    } else {
      console.error(`[ZAP Runner Execution Crash/Timeout] ${result.error}`);
      process.exit(3);
    }
  } catch (err) {
    console.error(`[ZAP Runner Fatal] ${err.message}`);
    process.exit(3);
  } finally {
    process.removeListener('SIGINT', handleInterrupt);
    process.removeListener('SIGTERM', handleInterrupt);
  }
}

const isMain =
  process.argv[1] &&
  (import.meta.url === pathToFileURL(process.argv[1]).href ||
    resolve(process.argv[1]) === resolve(__filename));

if (isMain) {
  main();
}
