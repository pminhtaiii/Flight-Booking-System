import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);

function coverageModuleName(filePath) {
  let normalized = String(filePath).replaceAll('\\', '/');
  const sourceMarker = normalized.lastIndexOf('/src/');
  if (sourceMarker >= 0) normalized = normalized.slice(sourceMarker + 5);
  else {
    const agentMarker = normalized.indexOf('agent/');
    if (agentMarker >= 0) normalized = normalized.slice(agentMarker);
  }
  normalized = normalized.replace(/\.[^.\/]+$/, '').replace(/\/__init__$/, '');
  return normalized.replaceAll('/', '.');
}

function coverageScopeMatches(scope, moduleName) {
  if (scope.endsWith('.*')) return moduleName.startsWith(`${scope.slice(0, -1)}`);
  return moduleName === scope;
}

function coverageFileRecords(coverageData) {
  if (coverageData && typeof coverageData === 'object' && coverageData.files && typeof coverageData.files === 'object') {
    return Object.entries(coverageData.files).map(([filePath, file]) => ({
      moduleName: coverageModuleName(filePath),
      summary: file?.summary && typeof file.summary === 'object' ? file.summary : file,
    }));
  }
  if (typeof coverageData === 'string') {
    return [...coverageData.matchAll(/<class\b([^>]*?)>/g)].map((match) => {
      const attrs = match[1];
      const read = (name) => attrs.match(new RegExp(`${name}="([0-9.]+|[^\"]*)"`))?.[1];
      const lineRate = Number(read('line-rate'));
      const branchRate = Number(read('branch-rate'));
      return {
        moduleName: coverageModuleName(read('filename') || read('name') || ''),
        summary: {
          percent_covered: Number.isFinite(lineRate) ? lineRate * 100 : undefined,
          branch_percent_covered: Number.isFinite(branchRate) ? branchRate * 100 : undefined,
        },
      };
    });
  }
  return [];
}

function ratioOrPercent(summary, coveredNames, totalNames, percentNames, zeroTotalPercent = null) {
  const covered = coveredNames.map((name) => summary?.[name]).find((value) => Number.isFinite(value));
  const total = totalNames.map((name) => summary?.[name]).find((value) => Number.isFinite(value));
  if (Number.isFinite(covered) && Number.isFinite(total) && total >= 0) {
    if (total === 0 && zeroTotalPercent === null) return null;
    if (total === 0) return { covered: 0, total: 1, percent: zeroTotalPercent };
    return { covered, total, percent: (covered / total) * 100 };
  }
  const percent = percentNames.map((name) => summary?.[name]).find((value) => Number.isFinite(value));
  if (Number.isFinite(percent)) return { covered: percent, total: 1, percent };
  return null;
}

function evaluateCoverageScopes(coverageData, policy) {
  const errors = [];
  const scopes = {};
  const records = coverageFileRecords(coverageData);
  for (const scope of policy.modules) {
    const matching = records.filter(({ moduleName }) => coverageScopeMatches(scope, moduleName));
    if (matching.length === 0) {
      errors.push(`[Coverage Failure] Scope ${scope} has no covered files`);
      continue;
    }
    const statement = matching.map(({ summary }) => ratioOrPercent(summary, ['covered_lines', 'covered_statements'], ['num_statements', 'num_lines'], ['percent_covered'], 100));
    const branch = matching.map(({ summary }) => ratioOrPercent(summary, ['covered_branches'], ['num_branches'], ['branch_percent_covered', 'percent_covered_branches'], 100));
    if (statement.some((value) => value === null) || branch.some((value) => value === null)) {
      errors.push(`[Coverage Failure] Scope ${scope} is missing measurable statement or branch coverage`);
      continue;
    }
    const statementTotal = statement.reduce((sum, value) => sum + value.total, 0);
    const statementCovered = statement.reduce((sum, value) => sum + value.covered, 0);
    const branchTotal = branch.reduce((sum, value) => sum + value.total, 0);
    const branchCovered = branch.reduce((sum, value) => sum + value.covered, 0);
    for (let index = 0; index < matching.length; index += 1) {
      const moduleName = matching[index].moduleName;
      if (statement[index].percent < policy.thresholds.statements) {
        errors.push(`[Coverage Failure] Scope ${scope} module ${moduleName} statement coverage ${statement[index].percent.toFixed(1)}% is below required minimum ${policy.thresholds.statements.toFixed(1)}%`);
      }
      if (branch[index].percent < policy.thresholds.branches) {
        errors.push(`[Coverage Failure] Scope ${scope} module ${moduleName} branch coverage ${branch[index].percent.toFixed(1)}% is below required minimum ${policy.thresholds.branches.toFixed(1)}%`);
      }
    }
    const metrics = {
      statementCoverage: (statementCovered / statementTotal) * 100,
      branchCoverage: (branchCovered / branchTotal) * 100,
      files: matching.length,
    };
    scopes[scope] = metrics;
    if (metrics.statementCoverage < policy.thresholds.statements) errors.push(`[Coverage Failure] Scope ${scope} statement coverage ${metrics.statementCoverage.toFixed(1)}% is below required minimum ${policy.thresholds.statements.toFixed(1)}%`);
    if (metrics.branchCoverage < policy.thresholds.branches) errors.push(`[Coverage Failure] Scope ${scope} branch coverage ${metrics.branchCoverage.toFixed(1)}% is below required minimum ${policy.thresholds.branches.toFixed(1)}%`);
  }
  return { passed: errors.length === 0, errors, metrics: scopes };
}

function aggregateCoverageFromFiles(coverageData) {
  const records = coverageFileRecords(coverageData);
  if (records.length === 0) return null;
  const statements = records.map(({ summary }) => ratioOrPercent(summary, ['covered_lines', 'covered_statements'], ['num_statements', 'num_lines'], ['percent_covered'], 100));
  const branches = records.map(({ summary }) => ratioOrPercent(summary, ['covered_branches'], ['num_branches'], ['branch_percent_covered', 'percent_covered_branches'], 100));
  if (statements.some((value) => value === null) || branches.some((value) => value === null)) return null;
  const statementTotal = statements.reduce((sum, value) => sum + value.total, 0);
  const branchTotal = branches.reduce((sum, value) => sum + value.total, 0);
  return {
    statementCoverage: statements.reduce((sum, value) => sum + value.covered, 0) / statementTotal * 100,
    branchCoverage: branches.reduce((sum, value) => sum + value.covered, 0) / branchTotal * 100,
  };
}

export function normalizeCoveragePolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) || !policy.thresholds || !Array.isArray(policy.modules) || policy.modules.length === 0) {
    return { policy: null, errors: ['[Fail-Closed] Invalid coverage policy shape'] };
  }
  const { statements, branches } = policy.thresholds;
  if (!Number.isFinite(statements) || !Number.isFinite(branches) || statements < 0 || statements > 100 || branches < 0 || branches > 100) {
    return { policy: null, errors: ['[Fail-Closed] Invalid coverage policy thresholds'] };
  }
  if (policy.modules.some((scope) => typeof scope !== 'string' || !scope.trim())) {
    return { policy: null, errors: ['[Fail-Closed] Invalid coverage policy scope'] };
  }
  return {
    policy: {
      ...policy,
      thresholds: { statements, branches },
      modules: [...policy.modules],
    },
    errors: [],
  };
}

export function loadCoveragePolicy(policyPath = resolve(fileURLToPath(new URL('../../tests/security/coverage-policy.json', import.meta.url)))) {
  try {
    return normalizeCoveragePolicy(JSON.parse(readFileSync(policyPath, 'utf8')));
  } catch (error) {
    return { policy: null, errors: [`[Fail-Closed] Failed to load coverage policy: ${error.message}`] };
  }
}

/**
 * Evaluates test coverage metrics against thresholds:
 * statement coverage >= 95.0%, branch coverage >= 90.0%.
 *
 * @param {object|string} coverageData JSON object or Cobertura XML string
 * @returns {{ passed: boolean, errors: string[], metrics: { statementCoverage: number, branchCoverage: number } }}
 */
export function evaluateCoverage(coverageData, options = {}) {
  const errors = [];
  let stmt = 0;
  let branch = 0;

  if (typeof coverageData === 'string') {
    // Parse Cobertura XML format
    const lineRateMatch = coverageData.match(/line-rate="([0-9.]+)"/);
    const branchRateMatch = coverageData.match(/branch-rate="([0-9.]+)"/);

    if (!lineRateMatch && !branchRateMatch) {
      errors.push('[Coverage Error] Could not parse line-rate or branch-rate from coverage XML');
    } else {
      if (lineRateMatch) {
        stmt = Math.round(parseFloat(lineRateMatch[1]) * 1000) / 10;
      }
      if (branchRateMatch) {
        branch = Math.round(parseFloat(branchRateMatch[1]) * 1000) / 10;
      }
    }
  } else if (coverageData && typeof coverageData === 'object') {
    // Extract statement coverage
    if (typeof coverageData.statementCoverage === 'number') {
      stmt = coverageData.statementCoverage;
    } else if (coverageData.statements && typeof coverageData.statements.pct === 'number') {
      stmt = coverageData.statements.pct;
    } else if (coverageData.totals && typeof coverageData.totals.percent_covered === 'number') {
      stmt = coverageData.totals.percent_covered;
    } else if (coverageData.total && coverageData.total.statements && typeof coverageData.total.statements.pct === 'number') {
      stmt = coverageData.total.statements.pct;
    } else if (coverageData.total && coverageData.total.lines && typeof coverageData.total.lines.pct === 'number') {
      stmt = coverageData.total.lines.pct;
    }

    // Extract branch coverage
    if (typeof coverageData.branchCoverage === 'number') {
      branch = coverageData.branchCoverage;
    } else if (coverageData.branches && typeof coverageData.branches.pct === 'number') {
      branch = coverageData.branches.pct;
    } else if (coverageData.totals && typeof coverageData.totals.branch_percent_covered === 'number') {
      branch = coverageData.totals.branch_percent_covered;
    } else if (coverageData.total && coverageData.total.branches && typeof coverageData.total.branches.pct === 'number') {
      branch = coverageData.total.branches.pct;
    }
  } else {
    return {
      passed: false,
      errors: ['[Coverage Error] Invalid coverage report format'],
      metrics: { statementCoverage: 0, branchCoverage: 0 },
    };
  }

  // coverage.py JSON reports expose the authoritative per-file counts under
  // `files`; derive aggregate rates when the report has no top-level totals.
  if (coverageData && typeof coverageData === 'object' && coverageData.files && typeof coverageData.files === 'object') {
    const aggregate = aggregateCoverageFromFiles(coverageData);
    const hasStatementTotal = coverageData.statementCoverage !== undefined || coverageData.statements || coverageData.totals?.percent_covered !== undefined || coverageData.total?.statements || coverageData.total?.lines;
    const hasBranchTotal = coverageData.branchCoverage !== undefined || coverageData.branches || coverageData.totals?.branch_percent_covered !== undefined || coverageData.total?.branches;
    if (aggregate && !hasStatementTotal) stmt = aggregate.statementCoverage;
    if (aggregate && !hasBranchTotal) branch = aggregate.branchCoverage;
  }

  if (stmt < 95.0) {
    errors.push(`[Coverage Failure] Statement (statement) coverage ${stmt.toFixed(1)}% is below required minimum 95.0%`);
  }
  if (branch < 90.0) {
    errors.push(`[Coverage Failure] Branch (branch) coverage ${branch.toFixed(1)}% is below required minimum 90.0%`);
  }

  let scopes = {};
  if (options.policy) {
    const scoped = evaluateCoverageScopes(coverageData, options.policy);
    errors.push(...scoped.errors);
    scopes = scoped.metrics;
  }

  return {
    passed: errors.length === 0,
    errors,
    metrics: {
      statementCoverage: stmt,
      branchCoverage: branch,
      ...(options.policy ? { scopes } : {}),
    },
  };
}

export const RECOGNIZED_SEVERITY_KEYS = new Set([
  'Critical',
  'High',
  'Medium',
  'Low',
  'Informational',
  'Info',
]);

/**
 * Validates whether counts object contains valid severity counts.
 *
 * @param {any} counts
 * @returns {boolean}
 */
export function hasValidSeverityCounts(counts) {
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) {
    return false;
  }
  if (!Number.isInteger(counts.Critical) || counts.Critical < 0) {
    return false;
  }
  if (!Number.isInteger(counts.High) || counts.High < 0) {
    return false;
  }
  for (const [key, val] of Object.entries(counts)) {
    if (!RECOGNIZED_SEVERITY_KEYS.has(key) || !Number.isInteger(val) || val < 0) {
      return false;
    }
  }
  return true;
}

/**
 * Validates explicit counts object and returns list of error messages.
 *
 * @param {any} counts
 * @param {string} prefix
 * @returns {string[]}
 */
export function validateExplicitCounts(counts, prefix) {
  if (counts === undefined) {
    return [];
  }
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) {
    return [`[${prefix} Error] Explicit counts must be an object`];
  }

  const errors = [];
  for (const [key, val] of Object.entries(counts)) {
    if (!RECOGNIZED_SEVERITY_KEYS.has(key)) {
      errors.push(
        `[${prefix} Error] Unrecognized count key "${key}" in counts. Expected severity keys: Critical, High, Medium, Low, Informational`,
      );
    }
    if (!Number.isInteger(val) || val < 0) {
      errors.push(`[${prefix} Error] Explicit count for "${key}" must be a non-negative integer`);
    }
  }

  if (!('Critical' in counts)) {
    errors.push(`[${prefix} Error] Explicit counts must specify non-negative integer for "Critical"`);
  }
  if (!('High' in counts)) {
    errors.push(`[${prefix} Error] Explicit counts must specify non-negative integer for "High"`);
  }

  return errors;
}

/**
 * Evaluates SAST results (Semgrep SARIF or JSON):
 * 0 Critical, 0 High findings. No scanner crashes or errors.
 *
 * @param {object} sastData
 * @returns {{ passed: boolean, errors: string[], counts: object, findings: any[] }}
 */
export function evaluateSast(sastData) {
  const errors = [];
  if (!sastData || typeof sastData !== 'object') {
    return {
      passed: false,
      errors: ['[SAST Error] Invalid SAST report format'],
      counts: { Critical: 0, High: 0, Medium: 0, Low: 0 },
      findings: [],
    };
  }

  // Require scanner execution evidence
  const hasEvidence =
    Array.isArray(sastData.runs) ||
    Array.isArray(sastData.findings) ||
    Array.isArray(sastData.results) ||
    hasValidSeverityCounts(sastData.counts);
  if (!hasEvidence) {
    errors.push('[SAST Error] Missing scanner execution evidence (runs, findings, results, or counts required)');
  }

  // Check scanner execution errors / crash
  if (sastData.errors && Array.isArray(sastData.errors) && sastData.errors.length > 0) {
    errors.push(`[SAST Error] Scanner reported execution error(s): ${JSON.stringify(sastData.errors)}`);
  }
  if (sastData.crashed) {
    errors.push('[SAST Error] SAST scanner crashed during execution');
  }

  let criticalCount = 0;
  let highCount = 0;
  let mediumCount = 0;
  let lowCount = 0;
  const findings = [];

  // Parse SARIF format
  if (Array.isArray(sastData.runs)) {
    for (const run of sastData.runs) {
      const results = run.results || [];
      for (const res of results) {
        findings.push(res);
        const level = (res.level || 'warning').toLowerCase();
        const secSeverity = parseFloat(res.properties?.['security-severity'] || 0);

        if (level === 'error' || secSeverity >= 7.0) {
          if (secSeverity >= 9.0) {
            criticalCount++;
          } else {
            highCount++;
          }
        } else if (level === 'warning' || secSeverity >= 4.0) {
          mediumCount++;
        } else {
          lowCount++;
        }
      }
    }
  } else if (Array.isArray(sastData.findings)) {
    // Direct findings array
    for (const f of sastData.findings) {
      findings.push(f);
      const sev = String(f.severity || '').toLowerCase();
      if (sev.includes('crit')) criticalCount++;
      else if (sev.includes('high') || sev === 'error') highCount++;
      else if (sev.includes('med') || sev === 'warning') mediumCount++;
      else lowCount++;
    }
  } else if (Array.isArray(sastData.results)) {
    // Semgrep JSON results
    for (const r of sastData.results) {
      findings.push(r);
      const sev = String(r.extra?.severity || '').toLowerCase();
      if (sev.includes('crit')) criticalCount++;
      else if (sev.includes('high') || sev === 'error') highCount++;
      else if (sev.includes('med') || sev === 'warning') mediumCount++;
      else lowCount++;
    }
  }

  // Explicit counts validation
  if (sastData.counts !== undefined) {
    errors.push(...validateExplicitCounts(sastData.counts, 'SAST'));
  }

  // If finding objects are present, they are the source of truth for severity counts.
  if (findings.length === 0 && sastData.counts && typeof sastData.counts === 'object') {
    if (typeof sastData.counts.Critical === 'number') criticalCount = sastData.counts.Critical;
    if (typeof sastData.counts.High === 'number') highCount = sastData.counts.High;
    if (typeof sastData.counts.Medium === 'number') mediumCount = sastData.counts.Medium;
    if (typeof sastData.counts.Low === 'number') lowCount = sastData.counts.Low;
  }

  if (criticalCount > 0) {
    errors.push(`[SAST Policy Failure] Found ${criticalCount} Critical vulnerability finding(s). Maximum allowed is 0.`);
  }
  if (highCount > 0) {
    errors.push(`[SAST Policy Failure] Found ${highCount} High vulnerability finding(s). Maximum allowed is 0.`);
  }

  return {
    passed: errors.length === 0,
    errors,
    counts: {
      Critical: criticalCount,
      High: highCount,
      Medium: mediumCount,
      Low: lowCount,
    },
    findings,
  };
}

/**
 * Evaluates supply chain (pip-audit, pnpm audit, Gitleaks) findings:
 * 0 Critical, 0 High findings; expired exceptions cause failure.
 *
 * @param {object} supplyChainData
 * @param {object} [options]
 * @param {string} [options.currentDate]
 * @returns {{ passed: boolean, errors: string[], counts: object, exceptions: any[] }}
 */
export function evaluateSupplyChain(supplyChainData, options = {}) {
  const errors = [];
  if (!supplyChainData || typeof supplyChainData !== 'object') {
    return {
      passed: false,
      errors: ['[Supply Chain Error] Invalid supply chain report format'],
      counts: { Critical: 0, High: 0 },
      exceptions: [],
    };
  }

  // Require scanner execution evidence
  const hasEvidence =
    Array.isArray(supplyChainData.findings) ||
    Boolean(supplyChainData.pipAudit) ||
    Boolean(supplyChainData.pnpmAudit) ||
    Boolean(supplyChainData.gitleaks) ||
    hasValidSeverityCounts(supplyChainData.counts);
  if (!hasEvidence) {
    errors.push('[Supply Chain Error] Missing scanner execution evidence (findings, sub-scanner reports, or counts required)');
  }

  const currentDateMs = options.currentDate ? Date.parse(options.currentDate) : Date.now();

  // Check exceptions for expiry
  const exceptions = Array.isArray(supplyChainData.exceptions) ? supplyChainData.exceptions : [];
  const validExceptionIds = new Set();

  for (const exc of exceptions) {
    const excId = exc.id || exc.fingerprint || 'unknown-exception';
    if (!exc.expiry) {
      errors.push(`[Supply Chain Exception Error] Exception "${excId}" missing required expiry date`);
      continue;
    }
    const expiryMs = Date.parse(exc.expiry);
    if (isNaN(expiryMs)) {
      errors.push(`[Supply Chain Exception Error] Exception "${excId}" has invalid expiry format: ${exc.expiry}`);
      continue;
    }
    if (expiryMs < currentDateMs) {
      errors.push(
        `[Expired Security Exception] Exception "${excId}" expired on ${exc.expiry} (evaluated as of ${options.currentDate || new Date(currentDateMs).toISOString()})`,
      );
    } else {
      validExceptionIds.add(excId);
      if (exc.id) validExceptionIds.add(exc.id);
      if (exc.fingerprint) validExceptionIds.add(exc.fingerprint);
    }
  }

  let criticalCount = 0;
  let highCount = 0;

  const rawFindings = Array.isArray(supplyChainData.findings)
    ? supplyChainData.findings
    : [
        ...(supplyChainData.pipAudit?.findings || []),
        ...(supplyChainData.pnpmAudit?.findings || []),
        ...(supplyChainData.gitleaks?.findings || []),
      ];

  for (const f of rawFindings) {
    const id = f.id || f.fingerprint || f.ruleId || '';
    if (validExceptionIds.has(id)) {
      // Finding suppressed by valid active exception
      continue;
    }
    const sev = String(f.severity || '').toLowerCase();
    if (sev.includes('crit')) criticalCount++;
    else if (sev.includes('high') || sev === 'error') highCount++;
  }

  // Explicit counts validation
  if (supplyChainData.counts !== undefined) {
    errors.push(...validateExplicitCounts(supplyChainData.counts, 'Supply Chain'));
  }

  // If finding objects are present, they are the source of truth for severity counts and suppression.
  if (rawFindings.length === 0 && supplyChainData.counts && typeof supplyChainData.counts === 'object') {
    if (typeof supplyChainData.counts.Critical === 'number') criticalCount = supplyChainData.counts.Critical;
    if (typeof supplyChainData.counts.High === 'number') highCount = supplyChainData.counts.High;
  }

  if (criticalCount > 0) {
    errors.push(`[Supply Chain Policy Failure] Found ${criticalCount} unsuppressed Critical vulnerability finding(s).`);
  }
  if (highCount > 0) {
    errors.push(`[Supply Chain Policy Failure] Found ${highCount} unsuppressed High vulnerability finding(s).`);
  }

  return {
    passed: errors.length === 0,
    errors,
    counts: { Critical: criticalCount, High: highCount },
    exceptions,
  };
}

/**
 * Evaluates DAST (ZAP & runtime) report:
 * 0 High/Critical findings; exitCode 0; no execution error (code 3);
 * no code 1; no auth failure (401/403); no scanner crash; no timeout;
 * no empty unexpected scope.
 *
 * @param {object} dastData
 * @returns {{ passed: boolean, errors: string[], metrics: object }}
 */
export function evaluateDast(dastData) {
  const errors = [];
  if (!dastData || typeof dastData !== 'object') {
    return {
      passed: false,
      errors: ['[DAST Error] Invalid DAST report format'],
      metrics: {},
    };
  }

  // Check scanner crash
  if (dastData.crashed || dastData.status === 'crash' || dastData.status === 'crashed') {
    errors.push('[DAST Failure] DAST scanner crashed during execution');
  }

  // Check timeout
  if (dastData.timedOut || dastData.status === 'timeout' || dastData.status === 'timed_out') {
    errors.push('[DAST Failure] DAST execution timed out (timeout)');
  }

  // Check exit code
  let exitCode = null;
  if (dastData.exitCode === undefined || dastData.exitCode === null) {
    errors.push('Missing exitCode in DAST report');
  } else {
    exitCode = Number(dastData.exitCode);
    if (isNaN(exitCode)) {
      errors.push(`[DAST Failure] Invalid exitCode in DAST report: ${dastData.exitCode}`);
    } else if (exitCode === 1) {
      errors.push('[DAST Failure] ZAP / DAST scanner exited with code 1 (failure)');
    } else if (exitCode === 3) {
      errors.push('[DAST Failure] ZAP execution error (exit code 3)');
    } else if (exitCode !== 0 && exitCode !== 2) {
      errors.push(`[DAST Failure] DAST scanner exited with non-zero exit code: ${exitCode}`);
    }
  }

  // Require execution evidence
  const hasExecutionEvidence =
    dastData.exitCode !== undefined &&
    dastData.exitCode !== null &&
    (Array.isArray(dastData.findings) || hasValidSeverityCounts(dastData.counts));
  if (!hasExecutionEvidence) {
    errors.push('[DAST Error] Missing scanner execution evidence (findings or counts required)');
  }

  // Check auth failures (unexpected 401/403)
  if (
    dastData.authFailure === true ||
    dastData.hasAuthFailure === true ||
    (typeof dastData.authErrors === 'number' && dastData.authErrors > 0)
  ) {
    errors.push('[DAST Failure] Scanner encountered authentication failure (unexpected 401/403)');
  }

  // Check test scope
  const endpointsChecked =
    dastData.endpointsChecked !== undefined
      ? Number(dastData.endpointsChecked)
      : dastData.routesChecked !== undefined
        ? Number(dastData.routesChecked)
        : dastData.totalTests !== undefined
          ? Number(dastData.totalTests)
          : null;

  if (endpointsChecked === null) {
    errors.push('[DAST Failure] Unknown test scope: endpointsChecked, routesChecked, or totalTests must be specified');
  } else if (!Number.isInteger(endpointsChecked) || endpointsChecked <= 0) {
    errors.push('[DAST Failure] Empty unexpected test scope: 0 endpoints/routes checked');
  }

  // Check findings for High / Critical
  let criticalCount = 0;
  let highCount = 0;
  const rawFindings = Array.isArray(dastData.findings) ? dastData.findings : [];

  for (const f of rawFindings) {
    const sev = String(f.severity || '').toLowerCase();
    if (sev.includes('crit')) criticalCount++;
    else if (sev.includes('high') || sev === 'error') highCount++;
  }

  // Explicit counts validation
  if (dastData.counts !== undefined) {
    errors.push(...validateExplicitCounts(dastData.counts, 'DAST'));
  }

  // If finding objects are present, they are the source of truth for severity counts.
  if (rawFindings.length === 0 && dastData.counts && typeof dastData.counts === 'object') {
    if (typeof dastData.counts.Critical === 'number') criticalCount = dastData.counts.Critical;
    if (typeof dastData.counts.High === 'number') highCount = dastData.counts.High;
  }

  if (criticalCount > 0) {
    errors.push(`[DAST Policy Failure] Found ${criticalCount} Critical vulnerability finding(s).`);
  }
  if (highCount > 0) {
    errors.push(`[DAST Policy Failure] Found ${highCount} High vulnerability finding(s).`);
  }

  return {
    passed: errors.length === 0,
    errors,
    metrics: {
      exitCode,
      endpointsChecked: Number.isInteger(endpointsChecked) ? endpointsChecked : 0,
      criticalCount,
      highCount,
    },
  };
}

/**
 * Evaluates detector corpus metrics against TPR/FPR thresholds,
 * stage-local denominators, and SEC28 stage-reachability.
 *
 * @param {object} detectorData
 * @returns {{ passed: boolean, errors: string[], metrics: object }}
 */
export function evaluateDetectorMetrics(detectorData) {
  const errors = [];
  if (!detectorData || typeof detectorData !== 'object') {
    return {
      passed: false,
      errors: ['[Detector Corpus Error] Invalid detector corpus report format'],
      metrics: {},
    };
  }

  const stages = detectorData.stages || {};
  const stageNames = ['input', 'tool', 'output'];

  // Minimum denominator requirements per stage
  const quotaMinimums = {
    input: { malicious: 100, benign: 250 },
    tool: { malicious: 50, benign: 125 },
    output: { malicious: 50, benign: 125 },
  };

  const stageMetrics = {};

  for (const name of stageNames) {
    const s = stages[name];
    if (!s || typeof s !== 'object') {
      errors.push(`[Detector Corpus Error] Missing confusion matrix for stage: "${name}"`);
      continue;
    }

    const isValidCount = (x) => Number.isInteger(x) && x >= 0;
    if (!isValidCount(s.tp) || !isValidCount(s.fn) || !isValidCount(s.fp) || !isValidCount(s.tn)) {
      errors.push(`[Detector Corpus Failure] Stage "${name}" counts must be non-negative integers`);
    }

    const tp = Number(s.tp) || 0;
    const fn = Number(s.fn) || 0;
    const fp = Number(s.fp) || 0;
    const tn = Number(s.tn) || 0;

    const malDenom = tp + fn;
    const benDenom = fp + tn;

    // Check empty or zero denominators
    if (malDenom === 0 || benDenom === 0) {
      errors.push(
        `[Detector Corpus Failure] Stage "${name}" has empty or zero denominator: malicious=${malDenom}, benign=${benDenom}`,
      );
    }

    // Check stage minimum quotas
    const mins = quotaMinimums[name];
    if (mins) {
      if (malDenom < mins.malicious) {
        errors.push(
          `[Detector Corpus Failure] Stage "${name}" malicious denominator (${malDenom}) below minimum quota (${mins.malicious})`,
        );
      }
      if (benDenom < mins.benign) {
        errors.push(
          `[Detector Corpus Failure] Stage "${name}" benign denominator (${benDenom}) below minimum quota (${mins.benign})`,
        );
      }
    }

    const tpr = malDenom > 0 ? tp / malDenom : 0;
    const fpr = benDenom > 0 ? fp / benDenom : 0;

    stageMetrics[name] = { tp, fn, fp, tn, tpr, fpr, malDenom, benDenom };

    // Threshold checks (TPR >= 95%, FPR <= 2%)
    if (tpr < 0.95) {
      errors.push(
        `[Detector Metric Failure] Stage "${name}" TPR ${(tpr * 100).toFixed(2)}% below required minimum 95.0%`,
      );
    }
    if (fpr > 0.02) {
      errors.push(
        `[Detector Metric Failure] Stage "${name}" FPR ${(fpr * 100).toFixed(2)}% exceeds maximum allowed 2.0%`,
      );
    }
  }

  // Derive aggregate counts from stage metrics
  const derivedTp = (stageMetrics.input?.tp || 0) + (stageMetrics.tool?.tp || 0) + (stageMetrics.output?.tp || 0);
  const derivedFn = (stageMetrics.input?.fn || 0) + (stageMetrics.tool?.fn || 0) + (stageMetrics.output?.fn || 0);
  const derivedFp = (stageMetrics.input?.fp || 0) + (stageMetrics.tool?.fp || 0) + (stageMetrics.output?.fp || 0);
  const derivedTn = (stageMetrics.input?.tn || 0) + (stageMetrics.tool?.tn || 0) + (stageMetrics.output?.tn || 0);

  if (detectorData.aggregate && typeof detectorData.aggregate === 'object') {
    if (
      Number(detectorData.aggregate.tp) !== derivedTp ||
      Number(detectorData.aggregate.fn) !== derivedFn ||
      Number(detectorData.aggregate.fp) !== derivedFp ||
      Number(detectorData.aggregate.tn) !== derivedTn
    ) {
      errors.push(
        `[Detector Metric Failure] Aggregate counts contradict per-stage sums: derived (tp=${derivedTp}, fn=${derivedFn}, fp=${derivedFp}, tn=${derivedTn}) vs aggregate (tp=${detectorData.aggregate.tp}, fn=${detectorData.aggregate.fn}, fp=${detectorData.aggregate.fp}, tn=${detectorData.aggregate.tn})`,
      );
    }
  }

  // Always use the derived sums derivedTp, derivedFn, derivedFp, derivedTn for computing aggTpr and aggFpr
  const aggMal = derivedTp + derivedFn;
  const aggBen = derivedFp + derivedTn;

  const aggTpr = aggMal > 0 ? derivedTp / aggMal : 0;
  const aggFpr = aggBen > 0 ? derivedFp / aggBen : 0;

  if (aggTpr < 0.95) {
    errors.push(`[Detector Metric Failure] Aggregate TPR ${(aggTpr * 100).toFixed(2)}% below required minimum 95.0%`);
  }
  if (aggFpr > 0.02) {
    errors.push(`[Detector Metric Failure] Aggregate FPR ${(aggFpr * 100).toFixed(2)}% exceeds maximum allowed 2.0%`);
  }

  // SEC28 Stage-reachability & upstream block checks
  const hasToolOrOutput = Boolean(stages.tool || stages.output);
  if (
    hasToolOrOutput &&
    (detectorData.stageReachability === undefined ||
      detectorData.stageReachability === null ||
      typeof detectorData.stageReachability !== 'object')
  ) {
    errors.push('Missing stageReachability in detector report');
  }

  const sr = detectorData.stageReachability || {};
  if (sr.upstreamBlocksAsDownstreamTp > 0) {
    errors.push(
      `[SEC28 Stage-Reachability Violation] ${sr.upstreamBlocksAsDownstreamTp} upstream block(s) falsely credited as downstream True Positive(s)`,
    );
  }
  if (sr.missingStageMarkers > 0) {
    errors.push(
      `[SEC28 Stage-Reachability Violation] ${sr.missingStageMarkers} downstream stage test case(s) missing required reachedStageMarker`,
    );
  }
  if (sr.incompleteRuns > 0) {
    errors.push(`[SEC28 Stage-Reachability Violation] ${sr.incompleteRuns} incomplete or invalid run(s) detected`);
  }

  return {
    passed: errors.length === 0,
    errors,
    metrics: {
      stages: stageMetrics,
      aggregate: { tp: derivedTp, fn: derivedFn, fp: derivedFp, tn: derivedTn, tpr: aggTpr, fpr: aggFpr },
    },
  };
}

/**
 * Evaluates invariant corpus results:
 * Separate from detector metrics, 100% pass requirement, 0 failures allowed.
 *
 * @param {object} invariantData
 * @returns {{ passed: boolean, errors: string[], metrics: object }}
 */
export function evaluateInvariants(invariantData) {
  const errors = [];
  if (!invariantData || typeof invariantData !== 'object') {
    return {
      passed: false,
      errors: ['[Invariant Corpus Error] Invalid invariant corpus report format'],
      metrics: {},
    };
  }

  const isValidCount = (x) => Number.isInteger(x) && x >= 0;
  if (
    !isValidCount(invariantData.total) ||
    !isValidCount(invariantData.passed) ||
    !isValidCount(invariantData.failed)
  ) {
    errors.push('[Invariant Corpus Failure] Invariant counts must be non-negative integers');
  }

  const total = Number(invariantData.total) || 0;
  const passed = Number(invariantData.passed) || 0;
  const failed = Number(invariantData.failed) || 0;
  const passRate = total > 0 ? passed / total : 0;

  if (passed + failed !== total) {
    errors.push(
      `[Invariant Corpus Failure] Invariant counts contradictory: passed (${passed}) + failed (${failed}) !== total (${total})`,
    );
  }

  if (total === 0) {
    errors.push('[Invariant Corpus Failure] Invariant corpus evaluation scope is empty (0 tests executed)');
  }

  if (failed > 0 || passed < total || passRate < 1.0) {
    errors.push(
      `[Invariant Corpus Failure] Invariants require 100% pass rate with 0 failures. Got ${passed}/${total} passed (${failed} failed, pass rate: ${(passRate * 100).toFixed(1)}%)`,
    );
  }

  return {
    passed: errors.length === 0,
    errors,
    metrics: { total, passed, failed, passRate },
  };
}

/**
 * Verifies that the union of shards in a multi-shard run covers
 * all required case IDs without omissions.
 *
 * @param {object} manifest
 * @returns {{ valid: boolean, errors: string[], coveredCases: Set<string>, missingCases: string[] }}
 */
export function verifyShardUnion(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') {
    return {
      valid: false,
      errors: ['[Shard Union Error] Invalid manifest object'],
      coveredCases: new Set(),
      missingCases: [],
    };
  }

  const totalShards = Number(manifest.totalShards);
  if (!Number.isInteger(totalShards) || totalShards < 1) {
    errors.push('[Shard Union Error] Manifest must specify totalShards as a positive integer >= 1');
  }

  if (!Array.isArray(manifest.shards) || manifest.shards.length === 0) {
    errors.push('[Shard Union Error] Manifest missing shards array or contains 0 shards');
  }

  if (!Array.isArray(manifest.requiredCaseIds) || manifest.requiredCaseIds.length === 0) {
    errors.push('[Shard Union Error] Manifest missing requiredCaseIds array or contains 0 required cases');
  }

  const shards = Array.isArray(manifest.shards) ? manifest.shards : [];

  if (Number.isInteger(totalShards) && shards.length !== totalShards) {
    errors.push(
      `[Shard Union Error] Manifest specifies totalShards=${totalShards}, but only ${shards.length} shard(s) present`,
    );
  }

  const coveredCases = new Set();
  const seenCaseIds = new Set();
  const reportedDuplicates = new Set();

  for (const shard of shards) {
    const caseIds = shard.caseIds || [];
    for (const cid of caseIds) {
      if (seenCaseIds.has(cid)) {
        if (!reportedDuplicates.has(cid)) {
          errors.push(`Duplicate case ID across shards: ${cid}`);
          reportedDuplicates.add(cid);
        }
      } else {
        seenCaseIds.add(cid);
      }
      coveredCases.add(cid);
    }
  }

  const requiredCaseIds = Array.isArray(manifest.requiredCaseIds) ? manifest.requiredCaseIds : [];
  const missingCases = [];

  for (const reqId of requiredCaseIds) {
    if (!coveredCases.has(reqId)) {
      missingCases.push(reqId);
    }
  }

  if (missingCases.length > 0) {
    errors.push(
      `[Shard Union Failure] Missing ${missingCases.length} required case ID(s) from shard union: ${missingCases.slice(0, 5).join(', ')}${missingCases.length > 5 ? '...' : ''}`,
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    coveredCases,
    missingCases,
  };
}

function hasValidReportVersion(report) {
  if (typeof report === 'string') {
    const vMatch = report.match(/version="([^"]+)"/i);
    return Boolean(vMatch && vMatch[1] && vMatch[1].trim() !== '');
  }
  if (report && typeof report === 'object') {
    const v = report.version ?? report.meta?.version;
    if (typeof v === 'string') return v.trim() !== '';
    if (typeof v === 'number') return !isNaN(v);
  }
  return false;
}

/**
 * Validates report schemas.
 *
 * @param {object} reports
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateReportSchemas(reports) {
  const errors = [];
  if (!reports || typeof reports !== 'object') {
    return { valid: false, errors: ['[Schema Error] Reports must be an object'] };
  }

  const requiredReports = [
    'coverage',
    'sast',
    'supplyChain',
    'dast',
    'detectorCorpus',
    'invariantCorpus',
  ];

  for (const req of requiredReports) {
    if (!(req in reports) || reports[req] === undefined || reports[req] === null) {
      errors.push(`[Schema Error] Missing required report: "${req}"`);
    } else if (req === 'coverage' && typeof reports[req] !== 'object' && typeof reports[req] !== 'string') {
      errors.push(`[Schema Error] Invalid report type for "${req}": must be object or XML string`);
    } else if (req !== 'coverage' && typeof reports[req] !== 'object') {
      errors.push(`[Schema Error] Invalid report type for "${req}": must be an object`);
    } else if (!hasValidReportVersion(reports[req])) {
      errors.push(`[Schema Error] Missing or invalid version in "${req}" report`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Top-level evaluation function aggregating and evaluating reports from directory.
 * Returns verdict and exit code (0 for pass, 1 for fail).
 *
 * @param {string|object} optionsOrDir Directory path or options object
 * @returns {{ passed: boolean, exitCode: 0|1, errors: string[], summary: object, reports: object }}
 */
export function evaluateSecurityResults(optionsOrDir) {
  let targetDir = 'artifacts/security';
  let manifestPath = null;
  let currentDate = new Date().toISOString();
  let coveragePolicyPath;
  let coveragePolicyOverride;
  let hasCoveragePolicyOverride = false;

  if (typeof optionsOrDir === 'string') {
    targetDir = optionsOrDir;
  } else if (optionsOrDir && typeof optionsOrDir === 'object') {
    if (optionsOrDir.directory) targetDir = optionsOrDir.directory;
    if (optionsOrDir.manifest) manifestPath = optionsOrDir.manifest;
    else if (optionsOrDir.manifestPath) manifestPath = optionsOrDir.manifestPath;
    if (optionsOrDir.currentDate) currentDate = optionsOrDir.currentDate;
    if (Object.prototype.hasOwnProperty.call(optionsOrDir, 'coveragePolicy')) {
      coveragePolicyOverride = optionsOrDir.coveragePolicy;
      hasCoveragePolicyOverride = true;
    } else if (optionsOrDir.coveragePolicyPath) {
      coveragePolicyPath = optionsOrDir.coveragePolicyPath;
    }
  }

  const resolvedDir = resolve(targetDir);
  const errors = [];
  const reports = {};
  const policyResult = hasCoveragePolicyOverride
    ? (() => {
        const normalized = normalizeCoveragePolicy(coveragePolicyOverride);
        return { policy: normalized.policy, errors: normalized.errors };
      })()
    : loadCoveragePolicy(coveragePolicyPath);
  if (policyResult.errors.length > 0) errors.push(...policyResult.errors);

  if (!existsSync(resolvedDir)) {
    return {
      passed: false,
      exitCode: 1,
      errors: [`[Fail-Closed] Security reports directory does not exist: ${resolvedDir}`],
      summary: {},
      reports: {},
    };
  }

  // 1. Read coverage report
  const covJsonPath = join(resolvedDir, 'coverage.json');
  const covXmlPath = join(resolvedDir, 'coverage.xml');
  if (existsSync(covJsonPath)) {
    try {
      reports.coverage = JSON.parse(readFileSync(covJsonPath, 'utf8'));
      if (!hasValidReportVersion(reports.coverage)) {
        errors.push('[Fail-Closed] Missing or invalid version in coverage report');
      }
    } catch (err) {
      errors.push(`[Fail-Closed] Failed to parse coverage.json: ${err.message}`);
    }
  } else if (existsSync(covXmlPath)) {
    try {
      reports.coverage = readFileSync(covXmlPath, 'utf8');
      if (!hasValidReportVersion(reports.coverage)) {
        errors.push('[Fail-Closed] Missing or invalid version in coverage report');
      }
    } catch (err) {
      errors.push(`[Fail-Closed] Failed to read coverage.xml: ${err.message}`);
    }
  } else {
    errors.push('[Fail-Closed] Missing required report: coverage.json or coverage.xml');
  }

  // 2. Read SAST report
  const sastPath = join(resolvedDir, 'sast.json');
  if (existsSync(sastPath)) {
    try {
      reports.sast = JSON.parse(readFileSync(sastPath, 'utf8'));
      if (!hasValidReportVersion(reports.sast)) {
        errors.push('[Fail-Closed] Missing or invalid version in sast report');
      }
    } catch (err) {
      errors.push(`[Fail-Closed] Failed to parse sast.json: ${err.message}`);
    }
  } else {
    errors.push('[Fail-Closed] Missing required report: sast.json');
  }

  // 3. Read Supply Chain report
  const scPath = join(resolvedDir, 'supply-chain.json');
  if (existsSync(scPath)) {
    try {
      reports.supplyChain = JSON.parse(readFileSync(scPath, 'utf8'));
      if (!hasValidReportVersion(reports.supplyChain)) {
        errors.push('[Fail-Closed] Missing or invalid version in supply chain report');
      }
    } catch (err) {
      errors.push(`[Fail-Closed] Failed to parse supply-chain.json: ${err.message}`);
    }
  } else {
    errors.push('[Fail-Closed] Missing required report: supply-chain.json');
  }

  // 4. Read DAST report
  const dastPath = join(resolvedDir, 'dast.json');
  if (existsSync(dastPath)) {
    try {
      reports.dast = JSON.parse(readFileSync(dastPath, 'utf8'));
      if (!hasValidReportVersion(reports.dast)) {
        errors.push('[Fail-Closed] Missing or invalid version in dast report');
      }
    } catch (err) {
      errors.push(`[Fail-Closed] Failed to parse dast.json: ${err.message}`);
    }
  } else {
    errors.push('[Fail-Closed] Missing required report: dast.json');
  }

  // 5. Read Detector Corpus report
  const detPath = join(resolvedDir, 'detector-corpus.json');
  if (existsSync(detPath)) {
    try {
      reports.detectorCorpus = JSON.parse(readFileSync(detPath, 'utf8'));
      if (!hasValidReportVersion(reports.detectorCorpus)) {
        errors.push('[Fail-Closed] Missing or invalid version in detector corpus report');
      }
    } catch (err) {
      errors.push(`[Fail-Closed] Failed to parse detector-corpus.json: ${err.message}`);
    }
  } else {
    errors.push('[Fail-Closed] Missing required report: detector-corpus.json');
  }

  // 6. Read Invariant Corpus report
  const invPath = join(resolvedDir, 'invariant-corpus.json');
  if (existsSync(invPath)) {
    try {
      reports.invariantCorpus = JSON.parse(readFileSync(invPath, 'utf8'));
      if (!hasValidReportVersion(reports.invariantCorpus)) {
        errors.push('[Fail-Closed] Missing or invalid version in invariant corpus report');
      }
    } catch (err) {
      errors.push(`[Fail-Closed] Failed to parse invariant-corpus.json: ${err.message}`);
    }
  } else {
    errors.push('[Fail-Closed] Missing required report: invariant-corpus.json');
  }

  // If any report missing or corrupt, fail closed immediately
  if (errors.length > 0) {
    return {
      passed: false,
      exitCode: 1,
      errors,
      summary: {},
      reports,
    };
  }

  // Validate report schemas
  const schemaValidation = validateReportSchemas(reports);
  if (!schemaValidation.valid) {
    errors.push(...schemaValidation.errors);
    return {
      passed: false,
      exitCode: 1,
      errors,
      summary: {},
      reports,
    };
  }

  // Evaluate Coverage
  const covEval = evaluateCoverage(reports.coverage, { policy: policyResult.policy });
  if (!covEval.passed) errors.push(...covEval.errors);

  // Evaluate SAST
  const sastEval = evaluateSast(reports.sast);
  if (!sastEval.passed) errors.push(...sastEval.errors);

  // Evaluate Supply Chain & Exceptions
  const scEval = evaluateSupplyChain(reports.supplyChain, { currentDate });
  if (!scEval.passed) errors.push(...scEval.errors);

  // Evaluate DAST
  const dastEval = evaluateDast(reports.dast);
  if (!dastEval.passed) errors.push(...dastEval.errors);

  // Evaluate Detector Corpus
  const detEval = evaluateDetectorMetrics(reports.detectorCorpus);
  if (!detEval.passed) errors.push(...detEval.errors);

  // Evaluate Invariant Corpus
  const invEval = evaluateInvariants(reports.invariantCorpus);
  if (!invEval.passed) errors.push(...invEval.errors);

  // Multi-shard manifest verification
  if (manifestPath) {
    if (!existsSync(manifestPath)) {
      errors.push('[Shard Manifest Error] Specified manifest file does not exist: ' + manifestPath);
    } else {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        const shardEval = verifyShardUnion(manifest);
        if (!shardEval.valid) errors.push(...shardEval.errors);
      } catch (err) {
        errors.push(`[Shard Manifest Error] Failed to read shard manifest: ${err.message}`);
      }
    }
  } else {
    const autoManifestPath = join(resolvedDir, 'manifest.json');
    if (existsSync(autoManifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(autoManifestPath, 'utf8'));
        const shardEval = verifyShardUnion(manifest);
        if (!shardEval.valid) errors.push(...shardEval.errors);
      } catch (err) {
        errors.push(`[Shard Manifest Error] Failed to read shard manifest: ${err.message}`);
      }
    }
  }

  const passed = errors.length === 0;
  const exitCode = passed ? 0 : 1;

  const summary = {
    coverage: covEval.metrics,
    sast: sastEval.counts,
    supplyChain: scEval.counts,
    dast: dastEval.metrics,
    detectorCorpus: detEval.metrics,
    invariants: invEval.metrics,
  };

  return {
    passed,
    exitCode,
    errors,
    summary,
    reports,
  };
}

// CLI Execution
/* eslint-disable no-console */
const isMain =
  process.argv[1] &&
  (import.meta.url === pathToFileURL(process.argv[1]).href ||
    resolve(process.argv[1]) === resolve(__filename));

if (isMain) {
  const args = process.argv.slice(2);
  let directory = 'artifacts/security';
  let manifest = null;
  let date = new Date().toISOString();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--directory' || arg === '-d') {
      directory = args[++i];
    } else if (arg === '--manifest' || arg === '-m') {
      manifest = args[++i];
    } else if (arg === '--date') {
      date = args[++i];
    }
  }

  console.log('===============================================================');
  console.log('         SECURITY RESULTS EVALUATION ENGINE & GATE             ');
  console.log('===============================================================');
  console.log(`Directory:   ${directory}`);
  console.log(`Eval Date:   ${date}`);
  if (manifest) console.log(`Manifest:    ${manifest}`);
  console.log('---------------------------------------------------------------');

  const result = evaluateSecurityResults({ directory, manifest, currentDate: date });

  if (result.summary && result.summary.coverage) {
    console.log('\n--- EVALUATION SUMMARY ---');
    console.log(
      `Statement Coverage: ${result.summary.coverage.statementCoverage}% (min 95.0%) | Branch: ${result.summary.coverage.branchCoverage}% (min 90.0%)`,
    );
    console.log(
      `SAST Findings:      Critical: ${result.summary.sast?.Critical ?? 0}, High: ${result.summary.sast?.High ?? 0}`,
    );
    console.log(
      `Supply Chain:       Critical: ${result.summary.supplyChain?.Critical ?? 0}, High: ${result.summary.supplyChain?.High ?? 0}`,
    );
    console.log(
      `DAST Exit Code:     ${result.summary.dast?.exitCode ?? 'N/A'}, Endpoints Checked: ${result.summary.dast?.endpointsChecked ?? 0}`,
    );
    if (result.summary.detectorCorpus?.aggregate) {
      const agg = result.summary.detectorCorpus.aggregate;
      console.log(
        `Detector Aggregate: TPR ${(agg.tpr * 100).toFixed(2)}% (min 95.0%) | FPR ${(agg.fpr * 100).toFixed(2)}% (max 2.0%)`,
      );
    }
    if (result.summary.invariants) {
      const inv = result.summary.invariants;
      console.log(`Invariants:         ${inv.passed}/${inv.total} passed (${(inv.passRate * 100).toFixed(1)}%)`);
    }
  }

  console.log('\n---------------------------------------------------------------');
  if (result.passed) {
    console.log('>>> [SECURITY EVALUATION VERDICT]: PASSED (exit code 0)');
    console.log('===============================================================');
    process.exit(0);
  } else {
    console.error('>>> [SECURITY EVALUATION VERDICT]: FAILED (exit code 1)');
    console.error(`\nFound ${result.errors.length} failure(s):`);
    for (const err of result.errors) {
      console.error(`  - ${err}`);
    }
    console.log('===============================================================');
    process.exit(1);
  }
}
