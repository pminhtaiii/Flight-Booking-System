import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const config = readFileSync(new URL('../../.gitleaks.toml', import.meta.url), 'utf8');

test('gitleaks synthetic exceptions remain exact and file/rule scoped', () => {
  assert.match(config, /api_key=sk_live_1234567890abcdef/);
  assert.match(config, /test_output_stream\\\\\.py/);
  assert.match(config, /stripe-access-token/);
  assert.match(config, /rk_test_placeholder/);
  assert.match(config, /apps\/api\/\\\\\.env\\\\\.example/);
  assert.doesNotMatch(config, /paths = \['\^tests\//);
});

test('gitleaks path allowlist is anchored to directory boundaries and does not exclude nextauth', () => {
  const pathMatches = [...config.matchAll(/'''([^']+)'''/g)].map((m) => new RegExp(m[1]));
  const nextAuthRoute = 'apps/web/app/api/auth/[...nextauth]/route.ts';
  const nextBuildFile = 'apps/web/.next/server/pages/index.js';
  const nodeModulesFile = 'node_modules/pkg/index.js';

  // [...nextauth] must not match any allowlisted path
  for (const regex of pathMatches) {
    assert.equal(regex.test(nextAuthRoute), false, `Allowlist pattern ${regex} must not match ${nextAuthRoute}`);
  }

  // Real build/cache paths must match their respective pattern
  assert.ok(pathMatches.some((regex) => regex.test(nextBuildFile)), 'Expected .next/ to be matched');
  assert.ok(pathMatches.some((regex) => regex.test(nodeModulesFile)), 'Expected node_modules/ to be matched');
});
