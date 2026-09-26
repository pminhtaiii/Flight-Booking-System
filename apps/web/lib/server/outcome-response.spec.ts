import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import type { BookingManagementOutcome } from '@shared/types/booking-management.types';

const testRequire = createRequire(import.meta.url);
const serverOnlyPath = testRequire.resolve('server-only');
testRequire.cache[serverOnlyPath] = { exports: {} } as NodeModule;

type Payload = { bookingId: string; nested: { revision: number } };
const payload: Payload = { bookingId: 'booking-test-123', nested: { revision: 2 } };

describe('mapOutcomeToResponse', () => {
  it('preserves success status, body, and private no-store header', async () => {
    const { mapOutcomeToResponse } = await import('./outcome-response');
    const outcome: BookingManagementOutcome<Payload> = { ok: true, data: payload };
    const response = mapOutcomeToResponse(outcome);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), payload);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  });

  const failures = [
    ['UNAUTHENTICATED', 401],
    ['FORBIDDEN', 403],
    ['NOT_FOUND', 404],
    ['STALE_REVISION', 409],
    ['INVALID_COMMAND', 400],
    ['UPSTREAM_UNAVAILABLE', 503],
    ['UNMAPPED_REASON', 500],
  ] as const;

  for (const [reason, status] of failures) {
    it(`maps ${reason} to ${status} with the unchanged body and header`, async () => {
      const { mapOutcomeToResponse } = await import('./outcome-response');
      const outcome = {
        ok: false,
        reason,
        message: `Message for ${reason}`,
        retryable: false,
      } as unknown as BookingManagementOutcome<Payload>;
      const response = mapOutcomeToResponse(outcome);

      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), {
        error: reason,
        message: `Message for ${reason}`,
      });
      assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    });
  }
});
