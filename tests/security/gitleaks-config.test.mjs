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
