import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertResponseShape,
  authBearer,
  buildBookingIntent,
  buildPaymentConfirmationPayload,
  buildPaymentPayload,
  buildSearchQuery,
  buildTravelerProfile,
  createUniqueTestActor,
  getFutureDate,
  getMockRequests,
  normalizeCacheEnvelope,
  pollPaymentStatus,
  redactSensitive,
  requestJson,
  resetMockServer,
  signHmacClaimToken,
  verifyHmacClaimToken,
} from './helpers/test-utils.mjs';

function createMockClock() {
  let currentTime = 1000000;
  return {
    now: () => currentTime,
    sleep: async (ms) => {
      currentTime += ms;
    },
  };
}

test('pollPaymentStatus polls until expected status is reached using mock clock', async () => {
  // Catches a production mutation that fails to reach terminal state or ignores expectedStatus
  const clock = createMockClock();
  let callCount = 0;
  const fakeFetch = async (url, options) => {
    callCount += 1;
    assert.equal(options.headers['Authorization'], 'Bearer pay-tok-123');
    const status = callCount < 3 ? 'PROCESSING' : 'SUCCEEDED';
    return {
      ok: true,
      status: 200,
      json: async () => ({ status, id: 'pi_test_123' }),
    };
  };

  const result = await pollPaymentStatus({
    url: 'http://127.0.0.1:3001/api/payments/pi_test_123',
    token: 'pay-tok-123',
    expectedStatus: 'SUCCEEDED',
    maxAttempts: 5,
    intervalMs: 500,
    fetchImpl: fakeFetch,
    clock,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.attempts, 3);
  assert.equal(result.elapsedMs, 1000); // 2 intervals of 500ms
});

test('pollPaymentStatus throws structured error with allowlisted diagnostics on exhaustion without leaking token', async () => {
  // Catches a production mutation that hangs, exceeds maxAttempts, or leaks bearer token on polling failure
  const clock = createMockClock();
  let callCount = 0;
  const fakeFetch = async () => {
    callCount += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: 'REQUIRES_ACTION', id: 'pi_test_action' }),
    };
  };

  await assert.rejects(
    async () => {
      await pollPaymentStatus({
        url: 'http://127.0.0.1:3001/api/payments/pi_test_action',
        token: 'sensitive-poll-token-99999',
        expectedStatus: 'SUCCEEDED',
        maxAttempts: 4,
        intervalMs: 1000,
        fetchImpl: fakeFetch,
        clock,
      });
    },
    (err) => {
      assert.equal(err.code, 'POLL_TIMEOUT');
      assert.equal(err.attempts, 4);
      assert.equal(err.lastStatus, 'REQUIRES_ACTION');
      assert.ok(typeof err.elapsedMs === 'number');

      const errStr = `${err.message} ${err.stack || ''} ${JSON.stringify(err)}`;
      assert.doesNotMatch(errStr, /sensitive-poll-token-99999/);
      return true;
    },
  );

  assert.equal(callCount, 4);
});

test('requestJson serializes request, attaches token, and parses JSON response on 2xx', async () => {
  // Catches a production mutation that omits headers, fails to serialize JSON, or fails to parse responses
  let received;
  const fakeFetch = async (url, options) => {
    received = { url, ...options };
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ success: true, user: 'usr_123' }),
    };
  };

  const result = await requestJson('http://127.0.0.1:3001/api/users', {
    method: 'POST',
    token: 'jwt-bearer-xyz',
    body: { name: 'Alice' },
    fetchImpl: fakeFetch,
  });

  assert.deepEqual(result, { success: true, user: 'usr_123' });
  assert.equal(received.method, 'POST');
  assert.equal(received.headers['Authorization'], 'Bearer jwt-bearer-xyz');
  assert.equal(received.headers['Content-Type'], 'application/json');
  assert.equal(received.body, JSON.stringify({ name: 'Alice' }));
});

test('requestJson throws structured error on non-2xx with redacted diagnostics and no token leak', async () => {
  // Catches a production mutation that dumps raw tokens or credentials in thrown HTTP errors
  const fakeFetch = async (url, options) => {
    return {
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () =>
        JSON.stringify({ message: 'Invalid credentials', password: 'P@ssword123!' }),
      json: async () => ({ message: 'Invalid credentials', password: 'P@ssword123!' }),
    };
  };

  await assert.rejects(
    async () => {
      await requestJson('http://127.0.0.1:3001/api/login?secretKey=mySecret123', {
        method: 'POST',
        token: 'super-sensitive-jwt-token-12345',
        body: { email: 'test@example.com', password: 'P@ssword123!' },
        fetchImpl: fakeFetch,
      });
    },
    (err) => {
      assert.equal(err.status, 401);
      assert.equal(err.statusText, 'Unauthorized');
      assert.equal(err.method, 'POST');
      assert.match(err.url, /secretKey=<redacted>/);

      const fullErrStr = `${err.message} ${err.stack || ''} ${JSON.stringify(err)}`;
      assert.doesNotMatch(fullErrStr, /super-sensitive-jwt-token-12345/);
      assert.doesNotMatch(fullErrStr, /mySecret123/);
      assert.doesNotMatch(fullErrStr, /P@ssword123!/);
      return true;
    },
  );
});

test('requestJson handles timeout with structured REQUEST_TIMEOUT error', async () => {
  // Catches a production mutation that hangs indefinitely or throws unstructured abort errors
  const fakeFetch = async (url, options) => {
    return new Promise((resolve, reject) => {
      if (options.signal) {
        options.signal.addEventListener('abort', () => {
          const abortErr = new Error('The operation was aborted');
          abortErr.name = 'AbortError';
          reject(abortErr);
        });
      }
    });
  };

  await assert.rejects(
    async () => {
      await requestJson('http://127.0.0.1:3001/api/slow', {
        timeoutMs: 20,
        fetchImpl: fakeFetch,
      });
    },
    (err) => {
      assert.equal(err.code, 'REQUEST_TIMEOUT');
      assert.equal(err.method, 'GET');
      assert.equal(err.url, 'http://127.0.0.1:3001/api/slow');
      return true;
    },
  );
});

test('resetMockServer and getMockRequests call loopback mock control endpoints', async () => {
  // Catches a production mutation with incorrect control paths or HTTP methods
  const recordedCalls = [];
  const fakeFetch = async (url, options = {}) => {
    recordedCalls.push({ url: String(url), method: options.method || 'GET' });
    if (String(url).endsWith('/__mock/reset')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      };
    }
    if (String(url).endsWith('/__mock/requests')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          counts: { 'POST /air/offer_requests': 1 },
          requests: [{ method: 'POST', pathname: '/air/offer_requests', status: 201 }],
        }),
      };
    }
    return { ok: false, status: 404, statusText: 'Not Found' };
  };

  const resetResult = await resetMockServer('http://127.0.0.1:4000', fakeFetch);
  assert.equal(resetResult.ok, true);

  const mockData = await getMockRequests('http://127.0.0.1:4000', fakeFetch);
  assert.equal(mockData.counts['POST /air/offer_requests'], 1);
  assert.equal(mockData.requests.length, 1);

  assert.deepEqual(recordedCalls, [
    { url: 'http://127.0.0.1:4000/__mock/reset', method: 'POST' },
    { url: 'http://127.0.0.1:4000/__mock/requests', method: 'GET' },
  ]);
});

test('assertResponseShape validates keys and types without leaking sensitive data in error', () => {
  // Catches a production mutation that dumps the full un-sanitized response body or values on failure
  const validData = {
    id: 'res_123',
    count: 5,
    active: true,
    tags: ['flight', 'deal'],
    meta: { version: 1 },
  };

  // Valid schemas
  assert.doesNotThrow(() => {
    assertResponseShape(validData, ['id', 'count', 'active']);
  });
  assert.doesNotThrow(() => {
    assertResponseShape(validData, {
      id: 'string',
      count: 'number',
      active: 'boolean',
      tags: 'array',
      meta: 'object',
    });
  });

  // Failing schema with sensitive data inside data
  const sensitiveData = {
    id: 'res_secret',
    token: 'super-secret-bearer-token-12345',
    password: 'UnsafePassword123!',
    count: 'not-a-number',
  };

  assert.throws(
    () => {
      assertResponseShape(sensitiveData, {
        id: 'string',
        count: 'number',
        missingField: 'string',
      });
    },
    (err) => {
      const errStr = `${err.message} ${err.stack || ''}`;
      assert.doesNotMatch(errStr, /super-secret-bearer-token-12345/);
      assert.doesNotMatch(errStr, /UnsafePassword123!/);
      assert.match(err.message, /missingField|count/);
      return true;
    },
  );
});

test('normalizeCacheEnvelope separates cached flag and produces comparable sub-object', () => {
  // Catches a production mutation that includes non-comparable metadata in cache comparisons
  const uncachedEnvelope = {
    results: [{ id: 'fl_offer_1', price: '250.00' }],
    meta: { searchHash: 'hash_abc123', cached: false, timestamp: 1700000001 },
  };
  const cachedEnvelope = {
    results: [{ id: 'fl_offer_1', price: '250.00' }],
    meta: { searchHash: 'hash_abc123', cached: true, timestamp: 1700000005 },
  };

  const norm1 = normalizeCacheEnvelope(uncachedEnvelope);
  const norm2 = normalizeCacheEnvelope(cachedEnvelope);

  assert.equal(norm1.cached, false);
  assert.equal(norm2.cached, true);
  assert.equal(norm1.searchHash, 'hash_abc123');
  assert.equal(norm2.searchHash, 'hash_abc123');

  assert.deepEqual(norm1.comparable, norm2.comparable);
  assert.deepEqual(norm1.comparable, {
    results: [{ id: 'fl_offer_1', price: '250.00' }],
    searchHash: 'hash_abc123',
  });
});

test('getFutureDate returns valid UTC ISO date string in YYYY-MM-DD format', () => {
  // Catches a production mutation that returns non-UTC dates, invalid formats, or non-future dates
  const dateStr = getFutureDate(14);
  assert.match(dateStr, /^\d{4}-\d{2}-\d{2}$/);

  const future = new Date(`${dateStr}T00:00:00Z`);
  const now = new Date();
  assert.ok(future.getTime() > now.getTime());
});

test('buildSearchQuery generates valid default search query and accepts overrides', () => {
  // Catches a production mutation that omits required search query fields
  const query = buildSearchQuery();
  assert.equal(query.origin, 'SGN');
  assert.equal(query.destination, 'SIN');
  assert.match(query.departureDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(query.adults, 1);
  assert.equal(query.cabinClass, 'economy');

  const custom = buildSearchQuery({ origin: 'HAN', adults: 2, cabinClass: 'business' });
  assert.equal(custom.origin, 'HAN');
  assert.equal(custom.adults, 2);
  assert.equal(custom.cabinClass, 'business');
});

test('buildTravelerProfile generates valid UpdateProfileDto payload with future passport', () => {
  // Catches a production mutation that generates invalid profile structures or expired passports
  const profile = buildTravelerProfile();
  assert.equal(profile.expectedRevision, 0);
  assert.equal(profile.identity.givenName, 'John');
  assert.equal(profile.identity.familyName, 'Doe');
  assert.match(profile.identity.dateOfBirth, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(profile.identity.gender, 'male');
  assert.equal(profile.identity.title, 'MR');

  assert.equal(profile.contact.phoneCountryCode, '+65');
  assert.equal(profile.travelDocument.documentType, 'passport');
  assert.match(profile.travelDocument.passportExpiry, /^\d{4}-\d{2}-\d{2}$/);
  const expiry = new Date(`${profile.travelDocument.passportExpiry}T00:00:00Z`);
  assert.ok(expiry.getTime() > Date.now());

  const overridden = buildTravelerProfile({ expectedRevision: 2, identity: { givenName: 'Jane' } });
  assert.equal(overridden.expectedRevision, 2);
  assert.equal(overridden.identity.givenName, 'Jane');
});

test('buildBookingIntent generates valid CreateIntentDto payload with canonical passenger sources', () => {
  // Catches a production mutation that generates invalid intent structures or missing sources
  const intent = buildBookingIntent();
  assert.ok(intent.flightOfferId);
  assert.ok(Array.isArray(intent.passengers));
  assert.equal(intent.passengers.length, 1);
  assert.equal(intent.passengers[0].offerPassengerId, 'pas_001');
  assert.equal(intent.passengers[0].type, 'ADULT');
  assert.equal(intent.passengers[0].source.type, 'traveler_profile');
  assert.equal(intent.passengers[0].source.expectedProfileRevision, 1);

  const customIntent = buildBookingIntent({
    flightOfferId: 'custom-offer-id',
    passengers: [
      {
        offerPassengerId: 'pas_inline',
        type: 'ADULT',
        source: {
          type: 'inline',
          givenName: 'Ada',
          familyName: 'Lovelace',
          dateOfBirth: '1995-05-15',
          gender: 'female',
          nationality: 'GB',
          email: 'ada@example.test',
          phoneCountryCode: '+44',
          phoneNumber: '7000000000',
          title: 'MS',
        },
      },
    ],
  });
  assert.equal(customIntent.flightOfferId, 'custom-offer-id');
  assert.equal(customIntent.passengers[0].source.type, 'inline');
});

test('buildPaymentPayload and buildPaymentConfirmationPayload generate valid payment DTOs', () => {
  // Catches a production mutation that breaks payment intent and confirmation shapes
  const createPayment = buildPaymentPayload();
  assert.ok(createPayment.bookingIntentId);

  const confirmPayment = buildPaymentConfirmationPayload();
  assert.ok(confirmPayment.bookingId);
  assert.ok(confirmPayment.paymentId);
});

test('authBearer constructs Authorization header and enforces non-empty string', () => {
  // Catches a production mutation that omits Bearer prefix or accepts null/empty tokens
  const header = authBearer('mock-jwt-token-12345');
  assert.deepEqual(header, { Authorization: 'Bearer mock-jwt-token-12345' });

  assert.throws(() => authBearer(''), {
    name: 'TypeError',
  });
  assert.throws(() => authBearer(null), {
    name: 'TypeError',
  });
});

test('signHmacClaimToken produces base64url HMAC token verifiable against secret', () => {
  // Catches a production mutation that uses wrong HMAC algorithm, delimiter, or invalid payload serialization
  const secret = 'test-claim-secret-12345';
  const payload = { userId: 'usr_mock_123', iat: 1700000000 };

  const token = signHmacClaimToken(payload, secret);

  const parts = token.split('.');
  assert.equal(parts.length, 2);

  const [payloadPart, sigPart] = parts;
  const decodedPayload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  assert.deepEqual(decodedPayload, payload);

  const verified = verifyHmacClaimToken(token, secret);
  assert.equal(verified.valid, true);
  assert.deepEqual(verified.payload, payload);

  // Wrong secret fails verification
  const wrongSecret = verifyHmacClaimToken(token, 'wrong-secret');
  assert.equal(wrongSecret.valid, false);

  // Tampered payload fails verification
  const tamperedToken = `${Buffer.from(JSON.stringify({ userId: 'usr_other' })).toString('base64url')}.${sigPart}`;
  const tampered = verifyHmacClaimToken(tamperedToken, secret);
  assert.equal(tampered.valid, false);
});

test('createUniqueTestActor generates unique valid credentials with memory-only placeholders', () => {
  // Catches a production mutation that produces non-unique actors, invalid email/passwords, or leaks credentials
  const actor1 = createUniqueTestActor();
  const actor2 = createUniqueTestActor();

  assert.notEqual(actor1.email, actor2.email);
  assert.notEqual(actor1.password, actor2.password);

  assert.match(actor1.email, /^smoke-actor-\d+-[a-f0-9]+@example\.com$/);
  assert.equal(actor1.userId, null);
  assert.equal(actor1.token, null);

  // Password complexity: min 8 chars, uppercase, lowercase, number, special char
  assert.ok(actor1.password.length >= 8);
  assert.match(actor1.password, /[A-Z]/);
  assert.match(actor1.password, /[a-z]/);
  assert.match(actor1.password, /[0-9]/);
  assert.match(actor1.password, /[^A-Za-z0-9]/);
});

test('redactSensitive redacts bearer tokens, passwords, card numbers, and secrets while preserving safe text', () => {
  // Catches a production mutation that logs or exposes raw secrets and credentials in diagnostics
  const sample = [
    'Authorization: Bearer secret-token-xyz-12345.abc_def',
    'User payload: {"email":"user@test.com","password":"SuperSecretP@ss1!"}',
    'Traveler payload: {"passportNumber":"B12345678","nationality":"SG"}',
    'Query: https://example.com/api?token=secret123&key=secretkey456&passport=B12345678',
    'Stripe key: sk_test_51MockKey1234567890abcdef',
    'Card: 4111-2222-3333-4444 and 4111222233334444',
  ].join('\n');

  const redacted = redactSensitive(sample);

  assert.doesNotMatch(redacted, /secret-token-xyz/);
  assert.doesNotMatch(redacted, /SuperSecretP@ss1!/);
  assert.doesNotMatch(redacted, /B12345678/);
  assert.doesNotMatch(redacted, /secretkey456/);
  assert.doesNotMatch(redacted, /sk_test_51MockKey/);
  assert.doesNotMatch(redacted, /4111-2222-3333-4444/);
  assert.doesNotMatch(redacted, /4111222233334444/);

  assert.match(redacted, /Bearer <redacted>/);
  assert.match(redacted, /"password":\s*"<redacted>"/);
  assert.match(redacted, /"passportNumber":\s*"<redacted>"/);
  assert.match(
    redacted,
    /https:\/\/example\.com\/api\?token=<redacted>&key=<redacted>&passport=<redacted>/,
  );
  assert.match(redacted, /<redacted>/);
});
