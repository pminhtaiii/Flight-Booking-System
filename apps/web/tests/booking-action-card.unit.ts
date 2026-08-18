import assert from 'node:assert/strict';
import test from 'node:test';
import { parseActionRequiredEvent } from '../components/chat/BookingActionCard';

test('parseActionRequiredEvent - parses valid single-passenger profile event', () => {
  const payload = {
    action: 'COMPLETE_PROFILE',
    scope: 'INTERNATIONAL',
    passengers: [
      {
        passengerType: 'ADULT',
        passengerOrdinal: 1,
        sections: [
          {
            name: 'travel_document',
            fields: [
              {
                name: 'passportNumber',
                status: 'missing',
                reason: 'REQUIRED',
              },
              {
                name: 'passportExpiry',
                status: 'invalid',
                reason: 'EXPIRED',
              },
            ],
          },
        ],
      },
    ],
    target: '/profile',
  };

  const parsed = parseActionRequiredEvent(payload);
  assert.notEqual(parsed, null);
  assert.equal(parsed?.action, 'COMPLETE_PROFILE');
  assert.equal(parsed?.scope, 'INTERNATIONAL');
  assert.equal(parsed?.target, '/profile');
  assert.equal(parsed?.passengers.length, 1);
  assert.equal(parsed?.passengers[0].passengerType, 'ADULT');
  assert.equal(parsed?.passengers[0].passengerOrdinal, 1);
  assert.equal(parsed?.passengers[0].sections.length, 1);
  assert.equal(parsed?.passengers[0].sections[0].fields.length, 2);
});

test('parseActionRequiredEvent - parses valid multi-passenger checkout event with offerId', () => {
  const payload = {
    action: 'CONTINUE_CHECKOUT',
    scope: 'DOMESTIC',
    passengers: [
      {
        passengerType: 'ADULT',
        passengerOrdinal: 1,
        sections: [
          {
            name: 'identity',
            fields: [
              {
                name: 'givenName',
                status: 'missing',
                reason: 'REQUIRED',
              },
            ],
          },
        ],
      },
      {
        passengerType: 'CHILD',
        passengerOrdinal: 2,
        sections: [
          {
            name: 'identity',
            fields: [
              {
                name: 'familyName',
                status: 'missing',
                reason: 'REQUIRED',
              },
            ],
          },
        ],
      },
    ],
    target: '/checkout/passengers',
    offerId: 'off_valid123_abc',
  };

  const parsed = parseActionRequiredEvent(payload);
  assert.notEqual(parsed, null);
  assert.equal(parsed?.action, 'CONTINUE_CHECKOUT');
  assert.equal(parsed?.scope, 'DOMESTIC');
  assert.equal(parsed?.target, '/checkout/passengers');
  assert.equal(parsed?.offerId, 'off_valid123_abc');
  assert.equal(parsed?.passengers.length, 2);
  assert.equal(parsed?.passengers[1].passengerType, 'CHILD');
  assert.equal(parsed?.passengers[1].passengerOrdinal, 2);
});

test('parseActionRequiredEvent - strictly rejects root-level extra properties / PII', () => {
  const maliciousPayload = {
    action: 'COMPLETE_PROFILE',
    scope: 'DOMESTIC',
    passengers: [
      {
        passengerType: 'ADULT',
        passengerOrdinal: 1,
        sections: [
          {
            name: 'identity',
            fields: [
              {
                name: 'givenName',
                status: 'missing',
                reason: 'REQUIRED',
              },
            ],
          },
        ],
      },
    ],
    target: '/profile',
    _unsafe_pii: {
      fullName: 'Jane Doe',
      documentNumber: 'P12345',
    },
  };

  assert.equal(parseActionRequiredEvent(maliciousPayload), null);
});

test('parseActionRequiredEvent - strictly rejects nested PII inside passenger, section, or field', () => {
  const maliciousPassenger = {
    action: 'COMPLETE_PROFILE',
    scope: 'DOMESTIC',
    passengers: [
      {
        passengerType: 'ADULT',
        passengerOrdinal: 1,
        fullName: 'Jane Doe',
        sections: [
          {
            name: 'identity',
            fields: [
              {
                name: 'givenName',
                status: 'missing',
                reason: 'REQUIRED',
              },
            ],
          },
        ],
      },
    ],
    target: '/profile',
  };
  assert.equal(parseActionRequiredEvent(maliciousPassenger), null);

  const maliciousField = {
    action: 'COMPLETE_PROFILE',
    scope: 'DOMESTIC',
    passengers: [
      {
        passengerType: 'ADULT',
        passengerOrdinal: 1,
        sections: [
          {
            name: 'identity',
            fields: [
              {
                name: 'givenName',
                status: 'missing',
                reason: 'REQUIRED',
                value: 'SecretName',
              },
            ],
          },
        ],
      },
    ],
    target: '/profile',
  };
  assert.equal(parseActionRequiredEvent(maliciousField), null);
});

test('parseActionRequiredEvent - rejects invalid target mismatch', () => {
  const mismatchedTarget = {
    action: 'COMPLETE_PROFILE',
    scope: 'DOMESTIC',
    passengers: [
      {
        passengerType: 'ADULT',
        passengerOrdinal: 1,
        sections: [
          {
            name: 'identity',
            fields: [
              {
                name: 'givenName',
                status: 'missing',
                reason: 'REQUIRED',
              },
            ],
          },
        ],
      },
    ],
    target: '/checkout/passengers', // single passenger COMPLETE_PROFILE must be /profile
  };
  assert.equal(parseActionRequiredEvent(mismatchedTarget), null);
});

test('parseActionRequiredEvent - rejects malformed offerId or ordinal', () => {
  const invalidOfferId = {
    action: 'COMPLETE_PROFILE',
    scope: 'DOMESTIC',
    passengers: [
      {
        passengerType: 'ADULT',
        passengerOrdinal: 1,
        sections: [],
      },
    ],
    target: '/profile',
    offerId: 'malicious<script>',
  };
  assert.equal(parseActionRequiredEvent(invalidOfferId), null);

  const invalidOrdinal = {
    action: 'COMPLETE_PROFILE',
    scope: 'DOMESTIC',
    passengers: [
      {
        passengerType: 'ADULT',
        passengerOrdinal: 0,
        sections: [],
      },
    ],
    target: '/profile',
  };
  assert.equal(parseActionRequiredEvent(invalidOrdinal), null);
});
