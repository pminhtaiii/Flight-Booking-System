import assert from 'node:assert/strict';
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
  assert.deepEqual(Object.keys(snapshot.requests[0]).sort(), ['method', 'pathname', 'status', 'timestamp']);
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
