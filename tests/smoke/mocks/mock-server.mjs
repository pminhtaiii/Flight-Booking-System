import http from 'node:http';
import { pathToFileURL } from 'node:url';

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function parseJsonBody(request) {
  if (!isJson(request)) {
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(await readBody(request)) };
  } catch {
    return { ok: false };
  }
}

async function parseFormBody(request) {
  if (!isFormEncoded(request)) {
    return { ok: false };
  }
  const rawBody = await readBody(request);
  if (hasMalformedPercentEscape(rawBody)) {
    return { ok: false };
  }
  return { ok: true, value: new URLSearchParams(rawBody) };
}

function isValidOfferRequest(payload) {
  const data = payload?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return false;
  }
  if (!Array.isArray(data.slices) || data.slices.length === 0) {
    return false;
  }
  if (!Array.isArray(data.passengers) || data.passengers.length === 0) {
    return false;
  }
  if (typeof data.cabin_class !== 'string' || data.cabin_class.length === 0) {
    return false;
  }
  return (
    data.slices.every(
      (slice) =>
        slice &&
        typeof slice.origin === 'string' &&
        slice.origin.length > 0 &&
        typeof slice.destination === 'string' &&
        slice.destination.length > 0 &&
        typeof slice.departure_date === 'string' &&
        slice.departure_date.length > 0,
    ) &&
    data.passengers.every(
      (passenger) => passenger && typeof passenger.type === 'string' && passenger.type.length > 0,
    )
  );
}

function buildOfferRequest(payload) {
  const { slices, passengers, cabin_class: cabinClass = 'economy' } = payload.data;
  const mockedPassengers = passengers.map((passenger, index) => ({
    id: `pas_mock_${index + 1}`,
    type: passenger.type,
  }));
  const mappedSlices = slices.map((slice, index) => ({
    id: `sli_mock_${index + 1}`,
    duration: 'PT2H10M',
    origin: {
      id: slice.origin,
      name: `${slice.origin} Airport`,
      iata_code: slice.origin,
      type: 'airport',
    },
    destination: {
      id: slice.destination,
      name: `${slice.destination} Airport`,
      iata_code: slice.destination,
      type: 'airport',
    },
    segments: [
      {
        id: `seg_mock_${index + 1}`,
        duration: 'PT2H10M',
        departing_at: `${slice.departure_date}T08:00:00Z`,
        arriving_at: `${slice.departure_date}T10:10:00Z`,
        origin: {
          id: slice.origin,
          name: `${slice.origin} Airport`,
          iata_code: slice.origin,
          type: 'airport',
        },
        destination: {
          id: slice.destination,
          name: `${slice.destination} Airport`,
          iata_code: slice.destination,
          type: 'airport',
        },
        operating_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
        marketing_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
        marketing_carrier_flight_number: String(123 + index),
        aircraft: { id: 'arc_mock_1', name: 'Airbus A321', iata_code: '321' },
        passengers: mockedPassengers.map((passenger) => ({
          passenger_id: passenger.id,
          cabin_class: cabinClass,
          baggages: [{ type: 'checked', quantity: 1 }],
        })),
      },
    ],
  }));
  return {
    id: 'or_mock_123',
    slices: mappedSlices,
    passengers: mockedPassengers,
    offers: [
      {
        id: 'off_mock_123',
        total_amount: '125.50',
        total_currency: 'USD',
        slices: mappedSlices,
        passengers: mockedPassengers,
        passenger_identity_documents_required: false,
        available_services: [],
      },
    ],
  };
}

function isFormEncoded(request) {
  return request.headers['content-type']?.split(';', 1)[0] === 'application/x-www-form-urlencoded';
}

function isJson(request) {
  return request.headers['content-type']?.split(';', 1)[0] === 'application/json';
}

function isValidPaymentIntent(form) {
  const amount = Number(form.get('amount'));
  const currency = form.get('currency');
  return (
    Number.isSafeInteger(amount) &&
    amount > 0 &&
    typeof currency === 'string' &&
    /^[a-z]{3}$/.test(currency) &&
    form.get('capture_method') === 'manual'
  );
}

function hasMalformedPercentEscape(body) {
  return /%(?![0-9A-Fa-f]{2})/.test(body);
}

const safeDiagnosticSegments = new Set([
  '__mock',
  'health',
  'reset',
  'requests',
  'air',
  'offer_requests',
  'offers',
  'orders',
  'v1',
  'customers',
  'payment_intents',
  'capture',
  'not-a-provider-route',
  'unsupported',
]);

function sanitizeUnknownPathname(pathname) {
  return (
    pathname
      .split('/')
      .map((segment) => {
        return segment === '' || safeDiagnosticSegments.has(segment) ? segment : '<redacted>';
      })
      .join('/') || '/'
  );
}

function buildPaymentIntent(status, amount = 12550, currency = 'usd') {
  return {
    id: 'pi_mock_123',
    object: 'payment_intent',
    amount,
    currency,
    status,
    capture_method: 'manual',
    client_secret: 'pi_mock_123_secret',
  };
}

function isValidInstantOrder(payload) {
  const data = payload?.data;
  return Boolean(
    data &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    data.type === 'instant' &&
    Array.isArray(data.selected_offers) &&
    data.selected_offers.length > 0 &&
    data.selected_offers.every((offer) => typeof offer === 'string' && offer.length > 0) &&
    Array.isArray(data.passengers) &&
    data.passengers.length > 0 &&
    data.passengers.every(
      (passenger) =>
        passenger &&
        typeof passenger === 'object' &&
        !Array.isArray(passenger) &&
        typeof passenger.id === 'string' &&
        passenger.id.length > 0,
    ),
  );
}

function buildOrder() {
  const origin = { id: 'SGN', name: 'SGN Airport', iata_code: 'SGN', type: 'airport' };
  const destination = { id: 'SIN', name: 'SIN Airport', iata_code: 'SIN', type: 'airport' };
  const passengers = [{ id: 'pas_mock_1', type: 'adult' }];
  return {
    id: 'ord_mock_123',
    booking_reference: 'MOCK123',
    status: 'confirmed',
    slices: [
      {
        id: 'sli_mock_1',
        duration: 'PT2H10M',
        origin,
        destination,
        segments: [
          {
            id: 'seg_mock_1',
            duration: 'PT2H10M',
            departing_at: '2030-01-02T08:00:00Z',
            arriving_at: '2030-01-02T10:10:00Z',
            origin,
            destination,
            operating_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
            marketing_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
            marketing_carrier_flight_number: '123',
            passengers: [{ passenger_id: 'pas_mock_1', cabin_class: 'economy' }],
          },
        ],
      },
    ],
    passengers,
  };
}

export function buildOfferDetail(offerId = 'off_mock_123', lastCreatedOffer = null) {
  if (lastCreatedOffer && lastCreatedOffer.id === offerId) {
    return {
      ...lastCreatedOffer,
      available_services: lastCreatedOffer.available_services ?? [],
    };
  }
  const origin = { id: 'SGN', name: 'SGN Airport', iata_code: 'SGN', type: 'airport' };
  const destination = { id: 'SIN', name: 'SIN Airport', iata_code: 'SIN', type: 'airport' };
  const passengers = [{ id: 'pas_mock_1', type: 'adult' }];
  return {
    id: offerId,
    total_amount: '125.50',
    total_currency: 'USD',
    slices: [
      {
        id: 'sli_mock_1',
        duration: 'PT2H10M',
        origin,
        destination,
        segments: [
          {
            id: 'seg_mock_1',
            duration: 'PT2H10M',
            departing_at: '2030-01-02T08:00:00Z',
            arriving_at: '2030-01-02T10:10:00Z',
            origin,
            destination,
            operating_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
            marketing_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
            marketing_carrier_flight_number: '123',
            aircraft: { id: 'arc_mock_1', name: 'Airbus A321', iata_code: '321' },
            passengers: [
              {
                passenger_id: 'pas_mock_1',
                cabin_class: 'economy',
                baggages: [{ type: 'checked', quantity: 1 }],
              },
            ],
          },
        ],
      },
    ],
    passengers,
    passenger_identity_documents_required: false,
    available_services: [],
  };
}

export function createMockServer() {
  const counts = new Map();
  const requests = [];
  let lastCreatedOffer = null;

  function record(method, pathname, status) {
    const routeKey = `${method} ${pathname}`;
    counts.set(routeKey, (counts.get(routeKey) ?? 0) + 1);
    requests.push({ timestamp: new Date().toISOString(), method, pathname, status });
  }

  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;

    if (request.method === 'GET' && pathname === '/__mock/health') {
      record(request.method, pathname, 200);
      sendJson(response, 200, { status: 'ok' });
      return;
    }

    if (request.method === 'POST' && pathname === '/__mock/reset') {
      counts.clear();
      requests.length = 0;
      lastCreatedOffer = null;
      sendJson(response, 200, { status: 'reset' });
      return;
    }

    if (request.method === 'GET' && pathname === '/__mock/requests') {
      sendJson(response, 200, {
        counts: Object.fromEntries(counts),
        requests: requests.slice(),
      });
      return;
    }

    if (request.method === 'POST' && pathname === '/air/offer_requests') {
      const parsed = await parseJsonBody(request);
      if (!parsed.ok) {
        record(request.method, pathname, 400);
        sendJson(response, 400, { error: 'Malformed request body' });
        return;
      }
      if (!isValidOfferRequest(parsed.value)) {
        record(request.method, pathname, 422);
        sendJson(response, 422, { error: 'Invalid request' });
        return;
      }
      const offerRequest = buildOfferRequest(parsed.value);
      lastCreatedOffer = offerRequest.offers?.[0] ?? null;
      record(request.method, pathname, 201);
      sendJson(response, 201, { data: offerRequest });
      return;
    }

    if (request.method === 'POST' && pathname === '/v1/payment_intents') {
      const parsed = await parseFormBody(request);
      if (!parsed.ok) {
        record(request.method, pathname, 400);
        sendJson(response, 400, { error: 'Malformed request body' });
        return;
      }
      if (!isValidPaymentIntent(parsed.value)) {
        record(request.method, pathname, 422);
        sendJson(response, 422, { error: 'Invalid request' });
        return;
      }
      const amount = Number(parsed.value.get('amount'));
      const currency = parsed.value.get('currency');
      record(request.method, pathname, 200);
      sendJson(response, 200, buildPaymentIntent('requires_capture', amount, currency));
      return;
    }

    if (request.method === 'POST' && pathname === '/air/orders') {
      const parsed = await parseJsonBody(request);
      if (!parsed.ok) {
        record(request.method, pathname, 400);
        sendJson(response, 400, { error: 'Malformed request body' });
        return;
      }
      if (!isValidInstantOrder(parsed.value)) {
        record(request.method, pathname, 422);
        sendJson(response, 422, { error: 'Invalid request' });
        return;
      }
      record(request.method, pathname, 201);
      sendJson(response, 201, {
        data: {
          id: 'ord_mock_123',
          booking_reference: 'MOCK123',
          status: 'confirmed',
        },
      });
      return;
    }

    if (request.method === 'GET' && pathname === '/air/orders/ord_mock_123') {
      record(request.method, pathname, 200);
      sendJson(response, 200, { data: buildOrder() });
      return;
    }

    if (
      request.method === 'GET' &&
      (pathname === '/air/offers' || pathname.startsWith('/air/offers/'))
    ) {
      const offerId = pathname.startsWith('/air/offers/')
        ? pathname.slice('/air/offers/'.length)
        : '';
      if (!offerId || !offerId.startsWith('off_') || offerId === 'off_' || offerId.includes('/')) {
        record(request.method, pathname, 400);
        sendJson(response, 400, { error: 'Malformed offer ID' });
        return;
      }
      const isKnown =
        offerId === 'off_mock_123' || (lastCreatedOffer && lastCreatedOffer.id === offerId);
      if (!isKnown) {
        record(request.method, pathname, 404);
        sendJson(response, 404, { error: 'Offer not found' });
        return;
      }
      record(request.method, pathname, 200);
      sendJson(response, 200, { data: buildOfferDetail(offerId, lastCreatedOffer) });
      return;
    }

    if (request.method === 'POST' && pathname === '/v1/customers') {
      const parsed = await parseFormBody(request);
      if (!parsed.ok) {
        record(request.method, pathname, 400);
        sendJson(response, 400, { error: 'Malformed request body' });
        return;
      }
      record(request.method, pathname, 200);
      sendJson(response, 200, {
        id: 'cus_mock_123',
        object: 'customer',
      });
      return;
    }

    if (
      request.method === 'GET' &&
      (pathname === '/v1/payment_intents' || pathname.startsWith('/v1/payment_intents/'))
    ) {
      const intentId = pathname.startsWith('/v1/payment_intents/')
        ? pathname.slice('/v1/payment_intents/'.length)
        : '';
      if (
        !intentId ||
        !intentId.startsWith('pi_') ||
        intentId === 'pi_' ||
        intentId.includes('/')
      ) {
        record(request.method, pathname, 400);
        sendJson(response, 400, { error: 'Malformed payment intent ID' });
        return;
      }
      record(request.method, pathname, 200);
      sendJson(response, 200, {
        id: intentId,
        object: 'payment_intent',
        status: 'requires_capture',
        amount: 12550,
        currency: 'usd',
        capture_method: 'manual',
        client_secret: `${intentId}_secret`,
      });
      return;
    }

    if (
      request.method === 'POST' &&
      pathname.startsWith('/v1/payment_intents/') &&
      pathname.endsWith('/capture')
    ) {
      const intentId = pathname.slice('/v1/payment_intents/'.length, -'/capture'.length);
      if (
        !intentId ||
        !intentId.startsWith('pi_') ||
        intentId === 'pi_' ||
        intentId.includes('/')
      ) {
        record(request.method, pathname, 400);
        sendJson(response, 400, { error: 'Malformed payment intent ID' });
        return;
      }
      const parsed = await parseFormBody(request);
      if (!parsed.ok) {
        record(request.method, pathname, 400);
        sendJson(response, 400, { error: 'Malformed request body' });
        return;
      }
      record(request.method, pathname, 200);
      sendJson(response, 200, {
        id: intentId,
        object: 'payment_intent',
        status: 'succeeded',
        amount: 12550,
        currency: 'usd',
        capture_method: 'manual',
        client_secret: `${intentId}_secret`,
      });
      return;
    }

    const safePath = sanitizeUnknownPathname(pathname);
    record(request.method ?? 'UNKNOWN', safePath, 404);
    process.stderr.write(
      `[mock-server] Warning: Unknown route requested: ${request.method ?? 'UNKNOWN'} ${safePath}\n`,
    );
    sendJson(response, 404, { error: 'Not found' });
  });

  return { server };
}

async function runCli() {
  const port = Number(process.env.MOCK_PORT ?? '4010');
  const { server } = createMockServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  process.stdout.write(`Mock server listening on http://127.0.0.1:${port}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runCli().catch((error) => {
    process.stderr.write(
      `Mock server failed to start: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    );
    process.exitCode = 1;
  });
}
