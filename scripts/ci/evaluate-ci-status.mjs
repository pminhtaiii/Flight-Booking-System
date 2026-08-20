import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVICE_CHAINS = {
  api: ['api-gate', 'api-unit-tests', 'api-e2e-tests'],
  web: ['web-gate', 'web-build'],
  agent: ['agent-gate', 'agent-tests'],
};

const DETECTION_OUTPUTS = Object.keys(SERVICE_CHAINS);

function fail(reason) {
  return { passed: false, reason };
}

function getDetectionOutput(results, service) {
  return results?.outputs?.[service] ?? results?.[service];
}

function getConclusion(results, job) {
  return results?.jobs?.[job] ?? results?.[job];
}

export function evaluateCiStatus(results) {
  if (results === null || typeof results !== 'object' || Array.isArray(results)) {
    return fail('results must be an object');
  }

  const detectionConclusion = getConclusion(results, 'detect-changes');
  if (detectionConclusion !== 'success') {
    return fail(`detect-changes concluded ${String(detectionConclusion)}, expected success`);
  }

  for (const service of DETECTION_OUTPUTS) {
    const output = getDetectionOutput(results, service);
    if (output !== 'true' && output !== 'false') {
      return fail(`${service} detection output must be the exact string true or false`);
    }
  }

  for (const [service, jobs] of Object.entries(SERVICE_CHAINS)) {
    const expectedConclusion = getDetectionOutput(results, service) === 'true' ? 'success' : 'skipped';

    for (const job of jobs) {
      const conclusion = getConclusion(results, job);
      if (conclusion !== expectedConclusion) {
        return fail(`${job} concluded ${String(conclusion)}, expected ${expectedConclusion} because ${service} is ${getDetectionOutput(results, service)}`);
      }
    }
  }

  return { passed: true, reason: 'all required CI jobs reached their expected conclusions' };
}

function parseCliInput(argv, stdin) {
  const input = argv[2] ?? stdin.trim();
  if (!input) {
    throw new Error('provide a JSON result object as the first argument or via stdin');
  }
  return JSON.parse(input);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--help' || process.argv[2] === '-h') {
    process.stdout.write('Usage: node scripts/ci/evaluate-ci-status.mjs [results-json]\n');
  } else {
    try {
      const stdin = process.argv[2] === undefined ? readFileSync(0, 'utf8') : '';
      const result = evaluateCiStatus(parseCliInput(process.argv, stdin));
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exitCode = result.passed ? 0 : 1;
    } catch (error) {
      process.stdout.write(`${JSON.stringify(fail(error instanceof Error ? error.message : String(error)))}\n`);
      process.exitCode = 1;
    }
  }
}
