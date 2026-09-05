import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('security stack isolates every runtime service and binds only loopback ports', async () => {
  const stack = JSON.parse(await readFile(new URL('./compose.security.yml', import.meta.url), 'utf8'));
  assert.equal(stack.networks.security.internal, true);
  assert.equal(stack.services.api_security.image, 'security-dast-api:local');
  assert.equal(stack.services.agent_security.image, 'security-dast-agent:local');
  assert.equal(stack.services.migrate.image, 'security-dast-api:local');
  for (const service of Object.values(stack.services)) {
    assert.deepEqual(service.networks, ['security']);
    assert.equal(service.env_file, undefined);
    assert.equal(service.network_mode, undefined);
    for (const port of service.ports ?? []) assert.match(port, /^127\.0\.0\.1:/);
  }
  assert.deepEqual(stack.services.postgres_security.ports, ['127.0.0.1:5433:5432']);
  assert.deepEqual(stack.services.redis_security.ports, ['127.0.0.1:6380:6379']);
  assert.equal(stack.services.api_security.environment.DUFFEL_API_URL, 'http://mock_security:3400');
  assert.equal(stack.services.api_security.environment.STRIPE_API_URL, 'http://mock_security:3400');
  assert.equal(stack.services.agent_security.environment.MIMO_API_URL, 'http://mock_security:3400/v1');
  assert.equal(stack.services.agent_security.environment.CHAT_QUOTA_DAILY, '${DAST_QUOTA_DAILY:-50}');
  assert.equal(stack.services.agent_security.environment.CHAT_QUOTA_BURST, '${DAST_QUOTA_BURST:-60}');
});

test('network-facing application images declare dedicated unprivileged users', async () => {
  const dockerfiles = await Promise.all([
    readFile(new URL('./api.Dockerfile', import.meta.url), 'utf8'),
    readFile(new URL('./agent.Dockerfile', import.meta.url), 'utf8'),
  ]);
  assert.match(dockerfiles[0], /^USER\s+security-api\s*$/m);
  assert.match(dockerfiles[1], /^USER\s+security-agent\s*$/m);
  for (const dockerfile of dockerfiles) assert.doesNotMatch(dockerfile, /^USER\s+root\s*$/m);
});
