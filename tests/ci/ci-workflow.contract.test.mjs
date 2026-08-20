import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { evaluateCiStatus } from '../../scripts/ci/evaluate-ci-status.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const evaluatorPath = resolve(root, 'scripts/ci/evaluate-ci-status.mjs');
const workflowPath = resolve(root, '.github/workflows/ci.yml');
const services = {
  api: ['api-gate', 'api-unit-tests', 'api-e2e-tests'],
  web: ['web-gate', 'web-build'],
  agent: ['agent-gate', 'agent-tests'],
};
const jobIds = ['detect-changes', ...Object.values(services).flat()];

function validResults(changes = {}) {
  const results = {
    api: changes.api ? 'true' : 'false',
    web: changes.web ? 'true' : 'false',
    agent: changes.agent ? 'true' : 'false',
    'detect-changes': 'success',
  };

  for (const [service, jobs] of Object.entries(services)) {
    for (const job of jobs) {
      results[job] = changes[service] ? 'success' : 'skipped';
    }
  }
  return results;
}

function workflow() {
  assert.ok(existsSync(workflowPath), 'expected .github/workflows/ci.yml to exist');
  return readFileSync(workflowPath, 'utf8');
}

function jobBlock(source, jobId) {
  const match = source.match(new RegExp(`^  ${jobId}:[ \\t]*\\n([\\s\\S]*?)(?=^  [\\w-]+:[ \\t]*$|^(?!\\s)|$(?![\\s\\S]))`, 'm'));
  assert.ok(match, `expected ${jobId} job`);
  return match[0];
}

function assertContains(block, pattern, description) {
  assert.match(block, pattern, description);
}

test('truth table accepts every valid API, Web, and Agent routing combination', () => {
  for (const api of [false, true]) {
    for (const web of [false, true]) {
      for (const agent of [false, true]) {
        const result = evaluateCiStatus(validResults({ api, web, agent }));
        assert.deepEqual(result, {
          passed: true,
          reason: 'all required CI jobs reached their expected conclusions',
        });
      }
    }
  }
});

test('evaluator rejects malformed or failed change detection', () => {
  for (const malformed of [true, false, 'TRUE', 'yes', '', undefined]) {
    const result = evaluateCiStatus({ ...validResults(), api: malformed });
    assert.equal(result.passed, false, `api=${String(malformed)} must be rejected`);
  }

  for (const conclusion of ['failure', 'cancelled', 'skipped', undefined]) {
    const result = evaluateCiStatus({ ...validResults(), 'detect-changes': conclusion });
    assert.equal(result.passed, false, `detect-changes=${String(conclusion)} must be rejected`);
  }
});

test('evaluator rejects every false-green job result', () => {
  for (const [service, jobs] of Object.entries(services)) {
    for (const job of jobs) {
      for (const conclusion of ['failure', 'cancelled', 'skipped', undefined]) {
        const result = evaluateCiStatus({ ...validResults({ [service]: true }), [job]: conclusion });
        assert.equal(result.passed, false, `${job}=${String(conclusion)} must fail an active chain`);
      }

      for (const conclusion of ['success', 'failure', 'cancelled', undefined]) {
        const result = evaluateCiStatus({ ...validResults(), [job]: conclusion });
        assert.equal(result.passed, false, `${job}=${String(conclusion)} must fail an inactive chain`);
      }
    }
  }
});

test('evaluator accepts nested GitHub-summary shaped results and never throws for invalid input', () => {
  const flat = validResults({ api: true, agent: true });
  const nested = {
    outputs: { api: flat.api, web: flat.web, agent: flat.agent },
    jobs: Object.fromEntries(jobIds.map((job) => [job, flat[job]])),
  };
  assert.equal(evaluateCiStatus(nested).passed, true);

  for (const invalid of [null, undefined, [], '', 1]) {
    assert.doesNotThrow(() => evaluateCiStatus(invalid));
    assert.equal(evaluateCiStatus(invalid).passed, false);
  }
});

test('evaluator CLI emits JSON and fails closed', () => {
  const passing = spawnSync(process.execPath, [evaluatorPath, JSON.stringify(validResults())], { encoding: 'utf8' });
  assert.equal(passing.status, 0);
  assert.deepEqual(JSON.parse(passing.stdout), evaluateCiStatus(validResults()));

  const failing = spawnSync(process.execPath, [evaluatorPath, '{'], { encoding: 'utf8' });
  assert.equal(failing.status, 1);
  assert.equal(JSON.parse(failing.stdout).passed, false);
});

test('evaluator CLI prints usage for --help without parsing it as JSON', () => {
  const help = spawnSync(process.execPath, [evaluatorPath, '--help'], { encoding: 'utf8' });

  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: node scripts\/ci\/evaluate-ci-status\.mjs/i);
  assert.equal(help.stderr, '');
});

test('workflow envelope uses the stable event, permissions, concurrency, and timeouts', () => {
  const source = workflow();
  assertContains(source, /^on:\s*\n\s+pull_request:\s*\n\s+branches:\s*(?:\[development\]|\n\s+- development)\s*$/m, 'workflow must target development pull requests only');
  assert.doesNotMatch(source, /^\s*(push|schedule|workflow_dispatch|workflow_call):/m, 'workflow must not have another trigger');
  assertContains(source, /^permissions:\s*\n\s+contents:\s+read\s*$/m, 'default permissions must be contents: read');
  assertContains(source, /^concurrency:\s*\n\s+group:\s+.*github\.event\.pull_request\.number.*\n\s+cancel-in-progress:\s+true\s*$/m, 'workflow must cancel superseded PR runs');

  for (const job of [...jobIds, 'ci-status']) {
    const block = jobBlock(source, job);
    assertContains(block, /^    runs-on:\s+ubuntu-latest\s*$/m, `${job} must use a fresh Ubuntu runner`);
    assertContains(block, /^    timeout-minutes:\s+\d+\s*$/m, `${job} must declare a timeout`);
  }

  const detect = jobBlock(source, 'detect-changes');
  assertContains(detect, /^    permissions:\s*\n\s+contents:\s+read\s*\n\s+pull-requests:\s+read\s*$/m, 'only detection may add pull-request read access');
});

test('workflow pins actions, disables credential persistence, and avoids unsafe caches', () => {
  const source = workflow();
  const actionUses = [...source.matchAll(/^\s+uses:\s+([^\s#]+)@([\w.-]+)(?:\s+#.*)?$/gm)];
  assert.ok(actionUses.length > 0, 'workflow must use pinned actions');
  for (const [, action, ref] of actionUses) {
    assert.match(ref, /^[a-f0-9]{40}$/i, `${action} must use a 40-character SHA`);
  }
  for (const [action, sha] of Object.entries({
    'actions/checkout': '3d3c42e5aac5ba805825da76410c181273ba90b1',
    'actions/setup-node': '820762786026740c76f36085b0efc47a31fe5020',
    'pnpm/action-setup': '0977fd99725f1db4007ccb2928dbb4e90d06cc86',
    'dorny/paths-filter': 'fbd0ab8f3e69293af611ebaee6363fc25e6d187d',
    'astral-sh/setup-uv': 'c771a70e6277c0a99b617c7a806ffedaca235ff9',
  })) {
    assertContains(source, new RegExp(`^\\s+uses:\\s+${action.replace('/', '\\/')}@${sha}\\s+#\\s+.+$`, 'm'), `${action} must use the reviewed release SHA`);
  }

  const checkoutCount = actionUses.filter(([, action]) => action === 'actions/checkout').length;
  const persistedCredentialCount = (source.match(/^\s+persist-credentials:\s+false\s*$/gm) ?? []).length;
  assert.ok(checkoutCount > 0, 'workflow must check out source explicitly');
  assert.equal(persistedCredentialCount, checkoutCount, 'every checkout must disable persisted credentials');
  assert.doesNotMatch(source, /(?:node_modules|\.next|\.venv)(?:\/|\b)/i, 'workflow must never cache dependency or build directories');
});

test('workflow preserves service-specific validation and network boundaries', () => {
  const source = workflow();
  const apiE2e = jobBlock(source, 'api-e2e-tests');
  for (const requirement of [/postgres:16-alpine/, /redis:7-alpine/, /prisma migrate deploy/, /test:e2e/, /node-network-guard\.cjs/]) {
    assertContains(apiE2e, requirement, `API E2E must include ${requirement}`);
  }

  const webGate = jobBlock(source, 'web-gate');
  const webBuild = jobBlock(source, 'web-build');
  for (const requirement of [/lint/, /route/, /typecheck/]) {
    assertContains(webGate, requirement, `Web gate must include ${requirement}`);
  }
  assertContains(webBuild, /node-network-guard\.cjs/, 'Web build must preload the Node network guard');
  assertContains(webBuild, /NEXT_PUBLIC_API_URL/, 'Web build must supply non-production API configuration');

  const agentGate = jobBlock(source, 'agent-gate');
  const agentTests = jobBlock(source, 'agent-tests');
  for (const requirement of [/uv sync --locked --package agent/, /ruff check/, /ruff format --check/]) {
    assertContains(agentGate, requirement, `Agent gate must include ${requirement}`);
  }
  for (const requirement of [/redis:7-alpine/, /CI_REQUIRE_REDIS_TESTS:\s*['"]?1['"]?/, /redis_integration/, /PYTHONPATH.*tests\/ci\/python/]) {
    assertContains(agentTests, requirement, `Agent tests must include ${requirement}`);
  }
});

test('workflow defines the required job graph, routing matrix, and fail-closed summary', () => {
  const source = workflow();
  for (const job of [...jobIds, 'ci-status']) {
    jobBlock(source, job);
  }

  const detect = jobBlock(source, 'detect-changes');
  for (const output of Object.keys(services)) {
    assertContains(detect, new RegExp(`^\\s+${output}:\\s+\\$\\{\\{\\s*steps\\..*\\.outputs\\.${output}\\s*\\}\\}`, 'm'), `detect-changes must publish ${output}`);
  }
  for (const path of ['apps/api/**', 'apps/web/**', 'apps/agent/**', 'packages/shared/**', 'tests/ci/**', 'scripts/ci/**']) {
    assert.ok(source.includes(path), `routing filters must include ${path}`);
  }
  for (const path of ['package.json', 'pyproject.toml', 'uv.lock']) {
    assert.ok(source.includes(path), `routing filters must account for ${path}`);
  }

  for (const [job, dependency] of [
    ['api-gate', 'detect-changes'],
    ['api-unit-tests', 'api-gate'],
    ['api-e2e-tests', 'api-gate'],
    ['web-gate', 'detect-changes'],
    ['web-build', 'web-gate'],
    ['agent-gate', 'detect-changes'],
    ['agent-tests', 'agent-gate'],
  ]) {
    assertContains(jobBlock(source, job), new RegExp(`^    needs:\\s+(?:${dependency}|\\[[^\\]]*${dependency}[^\\]]*\\])\\s*$`, 'm'), `${job} must depend on ${dependency}`);
  }

  const summary = jobBlock(source, 'ci-status');
  assertContains(summary, /^    if:\s+\$\{\{\s*always\(\)\s*\}\}\s*$/m, 'ci-status must always evaluate all results');
  for (const job of jobIds) {
    assertContains(summary, new RegExp(`^    needs:\\s+\\[[^\\]]*${job}[^\\]]*\\]\\s*$|^\\s+- ${job}\\s*$`, 'm'), `ci-status must need ${job}`);
  }
  assertContains(summary, /evaluate-ci-status\.mjs/, 'ci-status must invoke the shared evaluator');
});
