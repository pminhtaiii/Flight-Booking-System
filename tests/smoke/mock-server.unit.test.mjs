import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { createMockServer } from './mocks/mock-server.mjs';

async function startMock() {
  const mock = createMockServer();
  await new Promise((resolve, reject) => {
    mock.server.once('error', reject);
    mock.server.listen(0, '127.0.0.1', resolve);
  });
  const address = mock.server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');
  return {
    mock,
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function stopMock(mock) {
  await new Promise((resolve, reject) => {
    mock.server.close((error) => (error ? reject(error) : resolve()));
  });
}

test('reports readiness through the loopback health route', async (t) => {
  const { mock, url } = await startMock();
  t.after(() => stopMock(mock));

  const response = await fetch(`${url}/__mock/health?readiness=1`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('resets and snapshots safe request counters through loopback controls', async (t) => {
  const { mock, url } = await startMock();
  t.after(() => stopMock(mock));

  await fetch(`${url}/__mock/health`);
  const beforeReset = await fetch(`${url}/__mock/requests`);

  assert.equal(beforeReset.status, 200);
  const beforeResetBody = await beforeReset.json();
  assert.deepEqual(beforeResetBody.counts, { 'GET /__mock/health': 1 });
  assert.equal(beforeResetBody.requests.length, 1);
  assert.equal(beforeResetBody.requests[0].method, 'GET');
  assert.equal(beforeResetBody.requests[0].pathname, '/__mock/health');
  assert.equal(beforeResetBody.requests[0].status, 200);
  assert.match(beforeResetBody.requests[0].timestamp, /^\d{4}-\d{2}-\d{2}T/);

  const reset = await fetch(`${url}/__mock/reset`, { method: 'POST' });
  assert.equal(reset.status, 200);
  assert.deepEqual(await reset.json(), { status: 'reset' });

  const afterReset = await fetch(`${url}/__mock/requests`);
  assert.deepEqual(await afterReset.json(), { counts: {}, requests: [] });
});

test('accepts a valid Duffel offer request by method and parsed pathname', async (t) => {
  const { mock, url } = await startMock();
  t.after(() => stopMock(mock));

  const response = await fetch(`${url}/air/offer_requests?return_offers=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      data: {
        slices: [{ origin: 'SGN', destination: 'SIN', departure_date: '2030-01-02' }],
        passengers: [{ type: 'adult' }],
        cabin_class: 'economy',
      },
    }),
  });

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.data.id, 'or_mock_123');
  assert.equal(body.data.offers[0].id, 'off_mock_123');
  assert.deepEqual(body.data.offers[0].passengers, [{ id: 'pas_mock_1', type: 'adult' }]);
});

test('rejects a Duffel offer request with missing required JSON fields', async (t) => {
  const { mock, url } = await startMock();
  t.after(() => stopMock(mock));

  const response = await fetch(`${url}/air/offer_requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      data: {
        slices: [{ origin: 'SGN', destination: 'SIN', departure_date: '2030-01-02' }],
        passengers: [{ type: 'adult' }],
      },
    }),
  });

  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: 'Invalid request' });
});

test('accepts a valid form-encoded Stripe payment intent request', async (t) => {
  const { mock, url } = await startMock();
  t.after(() => stopMock(mock));

  const response = await fetch(`${url}/v1/payment_intents`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ amount: '12550', currency: 'usd', capture_method: 'manual' }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    id: 'pi_mock_123',
    object: 'payment_intent',
    amount: 12550,
    currency: 'usd',
    status: 'requires_capture',
    capture_method: 'manual',
    client_secret: 'pi_mock_123_secret',
  });
});

test('captures a known Stripe payment intent through its exact method and pathname', async (t) => {
  const { mock, url } = await startMock();
  t.after(() => stopMock(mock));

  const response = await fetch(`${url}/v1/payment_intents/pi_mock_123/capture`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    id: 'pi_mock_123',
    object: 'payment_intent',
    amount: 12550,
    currency: 'usd',
    status: 'succeeded',
    capture_method: 'manual',
    client_secret: 'pi_mock_123_secret',
  });
});

test('rejects a malformed form body on the Stripe capture route', async (t) => {
  const { mock, url } = await startMock();
  t.after(() => stopMock(mock));

  const response = await fetch(`${url}/v1/payment_intents/pi_mock_123/capture`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'amount=%',
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Malformed request body' });
});

test('accepts a valid Duffel instant-order request with required JSON fields', async (t) => {
  const { mock, url } = await startMock();
  t.after(() => stopMock(mock));

  const response = await fetch(`${url}/air/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      data: {
        type: 'instant',
        selected_offers: ['off_mock_123'],
        passengers: [{ id: 'pas_mock_1' }],
      },
    }),
  });

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.data.id, 'ord_mock_123');
  assert.equal(body.data.booking_reference, 'MOCK123');
  assert.equal(body.data.status, 'confirmed');
});

test('rejects an instant-order passenger without the required Duffel passenger id', async (t) => {
  const { mock, url } = await startMock();
  t.after(() => stopMock(mock));

  const response = await fetch(`${url}/air/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      data: {
        type: 'instant',
        selected_offers: ['off_mock_123'],
        passengers: [{}],
      },
    }),
  });

  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: 'Invalid request' });
});

test('rejects a Duffel body that is not declared as JSON', async (t) => {
  const { mock, url } = await startMock();
  t.after(() => stopMock(mock));

  const response = await fetch(`${url}/air/offer_requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: JSON.stringify({
      data: {
        slices: [{ origin: 'SGN', destination: 'SIN', departure_date: '2030-01-02' }],
        passengers: [{ type: 'adult' }],
        cabin_class: 'economy',
      },
    }),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Malformed request body' });
});

test('returns sanitized validation errors for malformed Duffel and invalid Stripe bodies', async (t) => {
  const { mock, url } = await startMock();
  t.after(() => stopMock(mock));

  const malformedDuffel = await fetch(`${url}/air/offer_requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  });
  const invalidStripe = await fetch(`${url}/v1/payment_intents`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ amount: '0', currency: 'usd', capture_method: 'manual' }),
  });

  assert.equal(malformedDuffel.status, 400);
  assert.deepEqual(await malformedDuffel.json(), { error: 'Malformed request body' });
  assert.equal(invalidStripe.status, 422);
  assert.deepEqual(await invalidStripe.json(), { error: 'Invalid request' });
});

test('rejects malformed percent escapes in a Stripe form body', async (t) => {
  const { mock, url } = await startMock();
  t.after(() => stopMock(mock));

  const response = await fetch(`${url}/v1/payment_intents`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'amount=%&currency=usd&capture_method=manual',
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Malformed request body' });
});

test('returns a deterministic Duffel order fixture for the created order pathname', async (t) => {
  const { mock, url } = await startMock();
  t.after(() => stopMock(mock));

  const response = await fetch(`${url}/air/orders/ord_mock_123?return_available_services=true`);

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.id, 'ord_mock_123');
  assert.equal(body.data.booking_reference, 'MOCK123');
  assert.equal(body.data.slices[0].segments[0].id, 'seg_mock_1');
  assert.deepEqual(body.data.passengers, [{ id: 'pas_mock_1', type: 'adult' }]);
});

test('records only safe diagnostics for unknown routes without leaking headers or bodies', async (t) => {
  const { mock, url } = await startMock();
  t.after(() => stopMock(mock));
  const secret = 'Bearer token-should-not-appear';
  const paymentDetails = 'card=4242424242424242&password=should-not-appear';

  const unknown = await fetch(`${url}/not-a-provider-route?ignored=true`, {
    method: 'PATCH',
    headers: { authorization: secret, 'content-type': 'application/x-www-form-urlencoded' },
    body: paymentDetails,
  });

  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: 'Not found' });
  const snapshot = await (await fetch(`${url}/__mock/requests`)).json();
  assert.deepEqual(snapshot.counts, { 'PATCH /not-a-provider-route': 1 });
  assert.equal(snapshot.requests.length, 1);
  assert.deepEqual(Object.keys(snapshot.requests[0]).sort(), [
    'method',
    'pathname',
    'status',
    'timestamp',
  ]);
  assert.equal(snapshot.requests[0].method, 'PATCH');
  assert.equal(snapshot.requests[0].pathname, '/not-a-provider-route');
  assert.equal(snapshot.requests[0].status, 404);
  assert.equal(JSON.stringify(snapshot).includes(secret), false);
  assert.equal(JSON.stringify(snapshot).includes(paymentDetails), false);
  assert.equal(JSON.stringify(snapshot).includes('4242424242424242'), false);
});

test('rejects a known pathname when its HTTP method does not match and records the 404', async (t) => {
  const { mock, url } = await startMock();
  t.after(() => stopMock(mock));

  const response = await fetch(`${url}/air/offer_requests?return_offers=true`);

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'Not found' });
  const snapshot = await (await fetch(`${url}/__mock/requests`)).json();
  assert.deepEqual(snapshot.counts, { 'GET /air/offer_requests': 1 });
  assert.equal(snapshot.requests[0].method, 'GET');
  assert.equal(snapshot.requests[0].pathname, '/air/offer_requests');
  assert.equal(snapshot.requests[0].status, 404);
});

test('redacts sensitive unknown pathname segments before exposing request diagnostics', async (t) => {
  const { mock, url } = await startMock();
  t.after(() => stopMock(mock));
  const sensitiveSegment = 'token-should-not-appear';

  const response = await fetch(`${url}/unsupported/${sensitiveSegment}`);

  assert.equal(response.status, 404);
  const snapshot = await (await fetch(`${url}/__mock/requests`)).json();
  assert.equal(snapshot.requests[0].pathname, '/unsupported/<redacted>');
  assert.equal(JSON.stringify(snapshot).includes(sensitiveSegment), false);
});

test('redacts non-keyword sensitive-looking unknown pathname segments', async (t) => {
  const { mock, url } = await startMock();
  t.after(() => stopMock(mock));
  const sensitiveSegment = 'alice-smith';

  const response = await fetch(`${url}/unsupported/${sensitiveSegment}`);

  assert.equal(response.status, 404);
  const snapshot = await (await fetch(`${url}/__mock/requests`)).json();
  assert.equal(snapshot.requests[0].pathname, '/unsupported/<redacted>');
  assert.equal(JSON.stringify(snapshot).includes(sensitiveSegment), false);
});

test('preserves audit-sensitive LLM pathname segments to prevent zero-LLM audit evasion', async (t) => {
  const { mock, url } = await startMock();
  t.after(() => stopMock(mock));

  const response = await fetch(`${url}/v1/chat/completions`);

  assert.equal(response.status, 404);
  const snapshot = await (await fetch(`${url}/__mock/requests`)).json();
  assert.equal(snapshot.requests[0].pathname, '/v1/chat/completions');
});

test('returns deterministic Duffel offer detail fixture for GET /air/offers/off_mock_123', async (t) => {
  const { mock, url } = await startMock();
  t.after(() => stopMock(mock));

  const response = await fetch(`${url}/air/offers/off_mock_123`);

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.id, 'off_mock_123');
  assert.equal(body.data.total_amount, '125.50');
  assert.equal(body.data.total_currency, 'USD');
  assert.equal(body.data.slices[0].duration, 'PT2H10M');
  assert.equal(body.data.slices[0].segments[0].operating_carrier.id, 'VN');
  assert.equal(body.data.slices[0].segments[0].operating_carrier.name, 'Vietnam Airlines');
  assert.deepEqual(body.data.passengers, [{ id: 'pas_mock_1', type: 'adult' }]);
  assert.deepEqual(body.data.available_services, []);

  const snapshot = await (await fetch(`${url}/__mock/requests`)).json();
  assert.equal(snapshot.counts['GET /air/offers/off_mock_123'], 1);
  const recorded = snapshot.requests.find((r) => r.pathname === '/air/offers/off_mock_123');
  assert.notEqual(recorded, undefined);
  assert.equal(recorded.method, 'GET');
  assert.equal(recorded.status, 200);
});

test('rejects GET /air/offers/invalid_id with 400 for malformed offer ID', async (t) => {
  const { mock, url } = await startMock();
  t.after(() => stopMock(mock));

  const response = await fetch(`${url}/air/offers/invalid_id`);

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Malformed offer ID' });

  const snapshot = await (await fetch(`${url}/__mock/requests`)).json();
  assert.equal(snapshot.counts['GET /air/offers/invalid_id'], 1);
  const recorded = snapshot.requests.find((r) => r.pathname === '/air/offers/invalid_id');
  assert.notEqual(recorded, undefined);
  assert.equal(recorded.method, 'GET');
  assert.equal(recorded.status, 400);
});

test('returns 404 for unknown offer ID on GET /air/offers/off_unknown', async (t) => {
  const { mock, url } = await startMock();
  t.after(() => stopMock(mock));

  const response = await fetch(`${url}/air/offers/off_unknown`);

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'Offer not found' });

  const snapshot = await (await fetch(`${url}/__mock/requests`)).json();
  assert.equal(snapshot.counts['GET /air/offers/off_unknown'], 1);
  const recorded = snapshot.requests.find((r) => r.pathname === '/air/offers/off_unknown');
  assert.notEqual(recorded, undefined);
  assert.equal(recorded.method, 'GET');
  assert.equal(recorded.status, 404);
});

test('rejects GET /air/offers with 400 for empty offer ID', async (t) => {
  const { mock, url } = await startMock();
  t.after(() => stopMock(mock));

  const response = await fetch(`${url}/air/offers`);

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Malformed offer ID' });
});

test('returns dynamically created offer detail when offer request was posted', async (t) => {
  const { mock, url } = await startMock();
  t.after(() => stopMock(mock));

  const createRes = await fetch(`${url}/air/offer_requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      data: {
        slices: [{ origin: 'HAN', destination: 'DAD', departure_date: '2030-05-01' }],
        passengers: [{ type: 'adult' }],
        cabin_class: 'business',
      },
    }),
  });
  assert.equal(createRes.status, 201);
  const createdBody = await createRes.json();
  const offerId = createdBody.data.offers[0].id;

  const getRes = await fetch(`${url}/air/offers/${offerId}`);
  assert.equal(getRes.status, 200);
  const detailBody = await getRes.json();
  assert.equal(detailBody.data.id, offerId);
  assert.equal(detailBody.data.slices[0].origin.id, 'HAN');
  assert.equal(detailBody.data.slices[0].destination.id, 'DAD');
  assert.equal(detailBody.data.slices[0].segments[0].passengers[0].cabin_class, 'business');

  await fetch(`${url}/__mock/reset`, { method: 'POST' });
  const afterReset = await fetch(`${url}/air/offers/off_mock_123`);
  assert.equal(afterReset.status, 200);
  const defaultBody = await afterReset.json();
  assert.equal(defaultBody.data.slices[0].origin.id, 'SGN');
});

test('rejects GET /air/offers/off_ with 400 for missing offer ID suffix', async (t) => {
  const { mock, url } = await startMock();
  t.after(() => stopMock(mock));

  const response = await fetch(`${url}/air/offers/off_`);

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Malformed offer ID' });
});

test('accepts Stripe customer creation through POST /v1/customers', async (t) => {
  const { mock, url } = await startMock();
  t.after(() => stopMock(mock));

  const response = await fetch(`${url}/v1/customers`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'email=traveler%40example.com&name=Test+Traveler',
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    id: 'cus_mock_123',
    object: 'customer',
  });

  const reqs = await fetch(`${url}/__mock/requests`);
  const reqsBody = await reqs.json();
  assert.equal(reqsBody.counts['POST /v1/customers'], 1);
  const recorded = reqsBody.requests.find((r) => r.pathname === '/v1/customers');
  assert.ok(recorded);
  assert.equal(recorded.method, 'POST');
  assert.equal(recorded.status, 200);
});

test('rejects POST /v1/customers with malformed percent encoding', async (t) => {
  const { mock, url } = await startMock();
  t.after(() => stopMock(mock));

  const response = await fetch(`${url}/v1/customers`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'email=traveler%ZZexample.com',
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Malformed request body' });
});

test('retrieves Stripe payment intent through GET /v1/payment_intents/:id', async (t) => {
  const { mock, url } = await startMock();
  t.after(() => stopMock(mock));

  const response = await fetch(`${url}/v1/payment_intents/pi_mock_123`);

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.id, 'pi_mock_123');
  assert.equal(body.object, 'payment_intent');
  assert.equal(body.status, 'requires_capture');
  assert.equal(body.amount, 12550);
  assert.equal(body.currency, 'usd');

  const reqs = await fetch(`${url}/__mock/requests`);
  const reqsBody = await reqs.json();
  assert.equal(reqsBody.counts['GET /v1/payment_intents/pi_mock_123'], 1);
});

test('retrieves Stripe payment intent with custom valid pi_ ID', async (t) => {
  const { mock, url } = await startMock();
  t.after(() => stopMock(mock));

  const response = await fetch(`${url}/v1/payment_intents/pi_test_custom_456`);

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.id, 'pi_test_custom_456');
  assert.equal(body.object, 'payment_intent');
  assert.equal(body.status, 'requires_capture');
  assert.equal(body.amount, 12550);
  assert.equal(body.currency, 'usd');
});

test('rejects GET /v1/payment_intents/:id with 400 for malformed ID', async (t) => {
  const { mock, url } = await startMock();
  t.after(() => stopMock(mock));

  const badPrefixRes = await fetch(`${url}/v1/payment_intents/not_a_pi_id`);
  assert.equal(badPrefixRes.status, 400);
  assert.deepEqual(await badPrefixRes.json(), { error: 'Malformed payment intent ID' });

  const emptySuffixRes = await fetch(`${url}/v1/payment_intents/pi_`);
  assert.equal(emptySuffixRes.status, 400);
  assert.deepEqual(await emptySuffixRes.json(), { error: 'Malformed payment intent ID' });

  const missingIdRes = await fetch(`${url}/v1/payment_intents`);
  assert.equal(missingIdRes.status, 400);
  assert.deepEqual(await missingIdRes.json(), { error: 'Malformed payment intent ID' });
});

test('captures Stripe payment intent with any valid pi_ ID through POST /v1/payment_intents/:id/capture', async (t) => {
  const { mock, url } = await startMock();
  t.after(() => stopMock(mock));

  const response = await fetch(`${url}/v1/payment_intents/pi_custom_capture_789/capture`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: '',
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.id, 'pi_custom_capture_789');
  assert.equal(body.object, 'payment_intent');
  assert.equal(body.status, 'succeeded');

  const reqs = await fetch(`${url}/__mock/requests`);
  const reqsBody = await reqs.json();
  assert.equal(reqsBody.counts['POST /v1/payment_intents/pi_custom_capture_789/capture'], 1);
});

test('rejects POST /v1/payment_intents/:id/capture with 400 for malformed payment intent ID', async (t) => {
  const { mock, url } = await startMock();
  t.after(() => stopMock(mock));

  const response = await fetch(`${url}/v1/payment_intents/bad_id/capture`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: '',
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Malformed payment intent ID' });
});

test('derives stable SHA-256 payment intent ID and matching client_secret from metadata[bookingIntentId]', async (t) => {
  const { mock, url } = await startMock();
  t.after(() => stopMock(mock));

  const bookingIntentId = 'intent_order_test_456';
  const expectedHash = crypto.createHash('sha256').update(bookingIntentId).digest('hex').slice(0, 12);
  const expectedId = `pi_mock_${expectedHash}`;

  const response = await fetch(`${url}/v1/payment_intents`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      amount: '12550',
      currency: 'usd',
      capture_method: 'manual',
      'metadata[bookingIntentId]': bookingIntentId,
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    id: expectedId,
    object: 'payment_intent',
    amount: 12550,
    currency: 'usd',
    status: 'requires_capture',
    capture_method: 'manual',
    client_secret: `${expectedId}_secret`,
  });
});

test('yields identical and stable payment intent IDs across repeated requests with identical metadata[bookingIntentId]', async (t) => {
  const { mock, url } = await startMock();
  t.after(() => stopMock(mock));

  const bookingIntentId = 'intent_order_idempotent_789';
  const payload = new URLSearchParams({
    amount: '12550',
    currency: 'usd',
    capture_method: 'manual',
    'metadata[bookingIntentId]': bookingIntentId,
  });

  const response1 = await fetch(`${url}/v1/payment_intents`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: payload,
  });
  const response2 = await fetch(`${url}/v1/payment_intents`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: payload,
  });

  assert.equal(response1.status, 200);
  assert.equal(response2.status, 200);
  const body1 = await response1.json();
  const body2 = await response2.json();

  assert.equal(body1.id, body2.id);
  assert.equal(body1.client_secret, body2.client_secret);
  assert.match(body1.id, /^pi_mock_[0-9a-f]{12}$/);
  assert.equal(body1.client_secret, `${body1.id}_secret`);
});

test('falls back to metadata[bookingId] to derive SHA-256 payment intent ID and client_secret when bookingIntentId is absent', async (t) => {
  const { mock, url } = await startMock();
  t.after(() => stopMock(mock));

  const bookingId = 'booking_legacy_fallback_101';
  const expectedHash = crypto.createHash('sha256').update(bookingId).digest('hex').slice(0, 12);
  const expectedId = `pi_mock_${expectedHash}`;

  const response = await fetch(`${url}/v1/payment_intents`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      amount: '8900',
      currency: 'eur',
      capture_method: 'manual',
      'metadata[bookingId]': bookingId,
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    id: expectedId,
    object: 'payment_intent',
    amount: 8900,
    currency: 'eur',
    status: 'requires_capture',
    capture_method: 'manual',
    client_secret: `${expectedId}_secret`,
  });
});

test('generates distinct payment intent IDs and client secrets across distinct booking intent IDs', async (t) => {
  const { mock, url } = await startMock();
  t.after(() => stopMock(mock));

  const intentIdA = 'intent_alpha_111';
  const intentIdB = 'intent_beta_222';

  const resA = await fetch(`${url}/v1/payment_intents`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      amount: '12550',
      currency: 'usd',
      capture_method: 'manual',
      'metadata[bookingIntentId]': intentIdA,
    }),
  });
  const resB = await fetch(`${url}/v1/payment_intents`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      amount: '12550',
      currency: 'usd',
      capture_method: 'manual',
      'metadata[bookingIntentId]': intentIdB,
    }),
  });

  assert.equal(resA.status, 200);
  assert.equal(resB.status, 200);
  const dataA = await resA.json();
  const dataB = await resB.json();

  assert.notEqual(dataA.id, dataB.id);
  assert.notEqual(dataA.client_secret, dataB.client_secret);
  assert.match(dataA.id, /^pi_mock_[0-9a-f]{12}$/);
  assert.match(dataB.id, /^pi_mock_[0-9a-f]{12}$/);
  assert.equal(dataA.client_secret, `${dataA.id}_secret`);
  assert.equal(dataB.client_secret, `${dataB.id}_secret`);
});

test('defaults payment intent ID to pi_mock_123 when metadata ID is missing or 123', async (t) => {
  const { mock, url } = await startMock();
  t.after(() => stopMock(mock));

  // 1. Missing metadata
  const missingMetaRes = await fetch(`${url}/v1/payment_intents`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ amount: '12550', currency: 'usd', capture_method: 'manual' }),
  });
  assert.equal(missingMetaRes.status, 200);
  const missingMetaData = await missingMetaRes.json();
  assert.equal(missingMetaData.id, 'pi_mock_123');
  assert.equal(missingMetaData.client_secret, 'pi_mock_123_secret');

  // 2. metadata[bookingIntentId] is '123'
  const literalIntent123Res = await fetch(`${url}/v1/payment_intents`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      amount: '12550',
      currency: 'usd',
      capture_method: 'manual',
      'metadata[bookingIntentId]': '123',
    }),
  });
  assert.equal(literalIntent123Res.status, 200);
  const literalIntent123Data = await literalIntent123Res.json();
  assert.equal(literalIntent123Data.id, 'pi_mock_123');
  assert.equal(literalIntent123Data.client_secret, 'pi_mock_123_secret');

  // 3. metadata[bookingId] is '123'
  const literalBooking123Res = await fetch(`${url}/v1/payment_intents`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      amount: '12550',
      currency: 'usd',
      capture_method: 'manual',
      'metadata[bookingId]': '123',
    }),
  });
  assert.equal(literalBooking123Res.status, 200);
  const literalBooking123Data = await literalBooking123Res.json();
  assert.equal(literalBooking123Data.id, 'pi_mock_123');
  assert.equal(literalBooking123Data.client_secret, 'pi_mock_123_secret');
});

