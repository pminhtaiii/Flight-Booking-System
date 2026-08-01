import { expect, test } from '@playwright/test';

import {
  ancillaryRecoveryKey,
  writeAncillaryRecovery,
} from '../lib/ancillary-recovery';

test('writes a versioned, expiry-bound recovery record without tokens or passenger PII', () => {
  const writes = new Map<string, string>();

  writeAncillaryRecovery({
    setItem(key: string, value: string): void {
      writes.set(key, value);
    },
  }, {
    intentId: 'intent-1',
    selectionId: 'selection-2',
    selectionVersion: 2,
    intentExpiresAt: '2026-07-29T12:30:00.000Z',
    updatedAt: '2026-07-29T12:00:00.000Z',
    seats: [{
      intentPassengerId: 'passenger-1',
      segmentId: 'segment-1',
      serviceId: 'seat-service-1',
      seatDesignator: '1A',
    }],
    baggage: [{
      intentPassengerId: 'passenger-1',
      serviceId: 'bag-service-1',
      quantity: 1,
    }],
  });

  const serialized = writes.get(ancillaryRecoveryKey('intent-1'));
  expect(serialized).toBeDefined();
  expect(JSON.parse(serialized!)).toEqual({
    schemaVersion: 1,
    intentId: 'intent-1',
    selectionId: 'selection-2',
    selectionVersion: 2,
    updatedAt: '2026-07-29T12:00:00.000Z',
    expiresAt: '2026-07-29T12:30:00.000Z',
    seats: [{ intentPassengerId: 'passenger-1', segmentId: 'segment-1', serviceId: 'seat-service-1', seatDesignator: '1A' }],
    baggage: [{ intentPassengerId: 'passenger-1', serviceId: 'bag-service-1', quantity: 1 }],
  });
  expect(serialized).not.toMatch(/token|givenName|familyName|passport|dateOfBirth|email/i);
});

