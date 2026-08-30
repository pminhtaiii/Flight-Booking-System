import assert from 'node:assert/strict';
import test from 'node:test';
import { hasCheckoutHandoffContext, resolveHandoffForBootstrap } from '../lib/handoffBootstrap';

test('rejects a successful resolve response that cannot render checkout', () => {
  assert.equal(hasCheckoutHandoffContext({ ok: true, status: 200 }), false);
});

test('rejects incomplete offer data and an empty passenger mapping', async () => {
  const result = await resolveHandoffForBootstrap(
    'http://127.0.0.1:3001',
    'chk_handoff_v1_credential',
    'access-token',
    undefined,
    undefined,
    async () => Response.json({ offer: {}, passengers: [] }),
  );

  assert.equal(hasCheckoutHandoffContext(result), false);
});
