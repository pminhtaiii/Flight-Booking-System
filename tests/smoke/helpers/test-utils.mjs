import crypto from 'node:crypto';

/**
 * Creates a unique test actor with valid credentials and memory-only placeholders.
 *
 * @returns {{ email: string, password: string, userId: null, token: null }}
 */
export function createUniqueTestActor() {
  const randomHex = crypto.randomBytes(4).toString('hex');
  const email = `smoke-actor-${Date.now()}-${randomHex}@example.com`;
  const password = `SmokeP@ss123!${randomHex}`;
  return {
    email,
    password,
    userId: null,
    token: null,
  };
}

/**
 * Constructs an Authorization Bearer header object.
 *
 * @param {string} token
 * @returns {{ Authorization: string }}
 */
export function authBearer(token) {
  if (typeof token !== 'string' || token.trim().length === 0) {
    throw new TypeError('token must be a non-empty string');
  }
  return { Authorization: `Bearer ${token}` };
}

/**
 * Returns a future UTC ISO date string in YYYY-MM-DD format.
 *
 * @param {number} [daysAhead=14]
 * @param {Date} [baseDate]
 * @returns {string}
 */
export function getFutureDate(daysAhead = 14, baseDate = new Date()) {
  const future = new Date(
    Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth(), baseDate.getUTCDate() + daysAhead),
  );
  return future.toISOString().slice(0, 10);
}

/**
 * Builds a search query object with sensible defaults and future departure date.
 *
 * @param {object} [overrides={}]
 * @returns {object}
 */
export function buildSearchQuery(overrides = {}) {
  return {
    origin: 'SGN',
    destination: 'SIN',
    departureDate: getFutureDate(14),
    adults: 1,
    cabinClass: 'economy',
    ...overrides,
  };
}

/**
 * Builds a valid traveler profile update payload matching UpdateProfileDto.
 *
 * @param {object} [overrides={}]
 * @returns {object}
 */
export function buildTravelerProfile(overrides = {}) {
  const {
    identity: overrideIdentity,
    contact: overrideContact,
    travelDocument: overrideTravelDocument,
    ...restOverrides
  } = overrides;

  return {
    expectedRevision: 0,
    identity: {
      givenName: 'John',
      familyName: 'Doe',
      dateOfBirth: '1990-01-01',
      gender: 'male',
      title: 'MR',
      ...overrideIdentity,
    },
    contact: {
      email: 'smoke-traveler@example.com',
      phoneCountryCode: '+65',
      phoneNumber: '91234567',
      ...overrideContact,
    },
    travelDocument: {
      documentType: 'passport',
      passportNumber: 'E12345678',
      passportExpiry: getFutureDate(365),
      issuingCountry: 'SG',
      nationality: 'SG',
      ...overrideTravelDocument,
    },
    ...restOverrides,
  };
}

/**
 * Builds a valid booking intent creation payload matching CreateIntentDto.
 *
 * @param {object} [overrides={}]
 * @returns {object}
 */
export function buildBookingIntent(overrides = {}) {
  return {
    flightOfferId: '22222222-2222-4222-8222-222222222222',
    passengers: [
      {
        offerPassengerId: 'pas_001',
        type: 'ADULT',
        source: {
          type: 'traveler_profile',
          travelerProfileId: '11111111-1111-4111-8111-111111111111',
          expectedProfileRevision: 1,
        },
      },
    ],
    ...overrides,
  };
}

/**
 * Builds a valid payment creation payload matching CreatePaymentDto.
 *
 * @param {object} [overrides={}]
 * @returns {object}
 */
export function buildPaymentPayload(overrides = {}) {
  return {
    bookingIntentId: '33333333-3333-4333-8333-333333333333',
    ...overrides,
  };
}

/**
 * Builds a valid payment confirmation payload matching ConfirmPaymentDto.
 *
 * @param {object} [overrides={}]
 * @returns {object}
 */
export function buildPaymentConfirmationPayload(overrides = {}) {
  return {
    bookingId: '44444444-4444-4444-8444-444444444444',
    paymentId: 'pi_mock_123',
    ...overrides,
  };
}

/**
 * Normalizes a search response cache envelope so results and hash can be compared
 * while the cached boolean is handled separately.
 *
 * @param {object} envelope
 * @returns {{ results: any[], searchHash: string, cached: boolean, comparable: { results: any[], searchHash: string } }}
 */
export function normalizeCacheEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') {
    throw new TypeError('envelope must be an object');
  }
  const results = envelope.results || envelope.data || [];
  const searchHash = envelope.meta?.searchHash || envelope.searchHash || '';
  const cached = Boolean(envelope.meta?.cached ?? envelope.cached ?? false);

  return {
    results,
    searchHash,
    cached,
    comparable: {
      results,
      searchHash,
    },
  };
}

/**
 * Asserts that data conforms to the required schema shape without leaking
 * sensitive values or logging the data object in error messages.
 *
 * @param {object} data
 * @param {string[]|Record<string, string|Function>} schema
 */
export function assertResponseShape(data, schema) {
  if (!data || typeof data !== 'object') {
    throw new Error('Response data must be a non-null object');
  }

  if (Array.isArray(schema)) {
    for (const key of schema) {
      if (!(key in data) || data[key] === undefined) {
        throw new Error(`Response is missing required field: "${key}"`);
      }
    }
    return;
  }

  if (typeof schema === 'object' && schema !== null) {
    for (const [key, expectedType] of Object.entries(schema)) {
      if (!(key in data) || data[key] === undefined) {
        throw new Error(`Response is missing required field: "${key}"`);
      }
      const val = data[key];
      if (typeof expectedType === 'function') {
        if (!expectedType(val)) {
          throw new Error(`Field "${key}" failed custom validation check`);
        }
      } else if (expectedType === 'array') {
        if (!Array.isArray(val)) {
          throw new Error(`Field "${key}" must be an array, observed: ${typeof val}`);
        }
      } else if (expectedType === 'object') {
        if (typeof val !== 'object' || val === null || Array.isArray(val)) {
          throw new Error(
            `Field "${key}" must be an object, observed: ${val === null ? 'null' : Array.isArray(val) ? 'array' : typeof val}`,
          );
        }
      } else if (typeof expectedType === 'string') {
        if (typeof val !== expectedType) {
          throw new Error(
            `Field "${key}" must be of type "${expectedType}", observed: ${typeof val}`,
          );
        }
      }
    }
    return;
  }

  throw new TypeError('schema must be an array of field names or a type specification object');
}

/**
 * Calls POST /__mock/reset on the mock provider server.
 *
 * @param {string} mockUrl
 * @param {typeof fetch} [fetchImpl=globalThis.fetch]
 * @returns {Promise<{ ok: boolean }>}
 */
export async function resetMockServer(mockUrl, fetchImpl = globalThis.fetch) {
  const normalized = mockUrl.replace(/\/+$/, '');
  const response = await fetchImpl(`${normalized}/__mock/reset`, {
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(`Failed to reset mock server: HTTP ${response.status}`);
  }
  return response.json ? await response.json() : { ok: true };
}

/**
 * Calls GET /__mock/requests on the mock provider server.
 *
 * @param {string} mockUrl
 * @param {typeof fetch} [fetchImpl=globalThis.fetch]
 * @returns {Promise<{ counts: Record<string, number>, requests: object[] }>}
 */
export async function getMockRequests(mockUrl, fetchImpl = globalThis.fetch) {
  const normalized = mockUrl.replace(/\/+$/, '');
  const response = await fetchImpl(`${normalized}/__mock/requests`, {
    method: 'GET',
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch mock requests: HTTP ${response.status}`);
  }
  return await response.json();
}

/**
 * Executes a JSON HTTP request with safe diagnostics, token injection, and timeout handling.
 *
 * @param {string|URL} url
 * @param {object} [options={}]
 * @returns {Promise<any>}
 */
export async function requestJson(url, options = {}) {
  const method = options.method || 'GET';
  const sanitizedUrl = redactSensitive(String(url));
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 30000;

  const headers = {
    Accept: 'application/json',
    ...(options.headers || {}),
  };

  if (options.token) {
    headers['Authorization'] = `Bearer ${options.token}`;
  }

  let body = options.body;
  if (body !== undefined && typeof body === 'object' && body !== null) {
    if (!(body instanceof Uint8Array) && !(body instanceof URLSearchParams)) {
      body = JSON.stringify(body);
      if (!headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
      }
    }
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let onAbort = null;
  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort(options.signal.reason);
    } else {
      onAbort = () => controller.abort(options.signal.reason);
      options.signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  try {
    const response = await fetchImpl(url, {
      ...options,
      method,
      headers,
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      const err = new Error(
        `Request failed with status ${response.status}: ${method} ${sanitizedUrl}`,
      );
      err.code = 'HTTP_ERROR';
      err.status = response.status;
      err.statusText = response.statusText;
      err.method = method;
      err.url = sanitizedUrl;
      throw err;
    }

    if (response.status === 204) {
      return null;
    }

    if (typeof response.json === 'function') {
      return await response.json();
    }

    return null;
  } catch (err) {
    if (timedOut) {
      const timeoutErr = new Error(
        `Request timed out after ${timeoutMs}ms: ${method} ${sanitizedUrl}`,
      );
      timeoutErr.code = 'REQUEST_TIMEOUT';
      timeoutErr.method = method;
      timeoutErr.url = sanitizedUrl;
      throw timeoutErr;
    }
    if (options.signal?.aborted) {
      throw options.signal.reason || err;
    }
    if (err.name === 'AbortError') {
      const timeoutErr = new Error(
        `Request timed out after ${timeoutMs}ms: ${method} ${sanitizedUrl}`,
      );
      timeoutErr.code = 'REQUEST_TIMEOUT';
      timeoutErr.method = method;
      timeoutErr.url = sanitizedUrl;
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (onAbort && options.signal) {
      options.signal.removeEventListener('abort', onAbort);
    }
  }
}

const defaultClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Polls payment status until the expected status is reached or limits are exceeded.
 *
 * @param {object} options
 * @param {string|URL} options.url
 * @param {string} options.token
 * @param {string} [options.expectedStatus='SUCCEEDED']
 * @param {number} [options.maxAttempts=10]
 * @param {number} [options.intervalMs=1000]
 * @param {number} [options.timeoutMs=30000]
 * @param {typeof fetch} [options.fetchImpl=globalThis.fetch]
 * @param {object} [options.clock=defaultClock]
 * @returns {Promise<{ ok: boolean, status: string, attempts: number, elapsedMs: number, data: any }>}
 */
export async function pollPaymentStatus({
  url,
  token,
  expectedStatus = 'SUCCEEDED',
  maxAttempts = 10,
  intervalMs = 1000,
  timeoutMs = 30000,
  fetchImpl = globalThis.fetch,
  clock = defaultClock,
}) {
  const startedAt = clock.now();
  let attempts = 0;
  let lastStatus = null;

  while (attempts < maxAttempts && clock.now() - startedAt < timeoutMs) {
    attempts += 1;
    let data = null;
    let ok = false;
    try {
      const headers = authBearer(token);
      headers.Accept = 'application/json';
      const response = await fetchImpl(url, { headers });
      ok = Boolean(response?.ok);
      if (typeof response?.json === 'function') {
        data = await response.json();
      }
    } catch {
      // Network or parsing error: continue to evaluate polling condition
    }

    const currentStatus = ok ? data?.status || data?.payment?.status || null : null;
    lastStatus = currentStatus;

    if (ok && currentStatus === expectedStatus) {
      const elapsedMs = clock.now() - startedAt;
      return {
        ok: true,
        status: currentStatus,
        attempts,
        elapsedMs,
        data,
      };
    }

    const elapsedMs = clock.now() - startedAt;
    if (attempts >= maxAttempts || elapsedMs >= timeoutMs) {
      break;
    }

    const remainingMs = timeoutMs - elapsedMs;
    const pauseTime = Math.min(intervalMs, remainingMs);
    if (pauseTime > 0) {
      await clock.sleep(pauseTime);
    }
  }

  const elapsedMs = clock.now() - startedAt;
  const err = new Error(
    `Payment polling exhausted (${attempts} attempts, last status: ${lastStatus})`,
  );
  err.code = 'POLL_TIMEOUT';
  err.attempts = attempts;
  err.lastStatus = lastStatus;
  err.elapsedMs = elapsedMs;
  throw err;
}

/**
 * Signs an HMAC-SHA256 claim token matching ClaimTokenService.
 *
 * @param {object|string} payload
 * @param {string} secret
 * @returns {string}
 */
export function signHmacClaimToken(payload, secret) {
  if (!secret || typeof secret !== 'string') {
    throw new TypeError('secret must be a non-empty string');
  }
  let payloadObj = payload;
  if (typeof payload === 'object' && payload !== null) {
    payloadObj = {
      iat: Math.floor(Date.now() / 1000),
      ...payload,
    };
  }
  const payloadStr = typeof payloadObj === 'string' ? payloadObj : JSON.stringify(payloadObj);
  const payloadPart = Buffer.from(payloadStr, 'utf8').toString('base64url');
  const signaturePart = crypto.createHmac('sha256', secret).update(payloadStr).digest('base64url');

  return `${payloadPart}.${signaturePart}`;
}

/**
 * Verifies an HMAC-SHA256 claim token against a secret.
 *
 * @param {string} token
 * @param {string} secret
 * @returns {{ valid: boolean, payload?: object, reason?: string }}
 */
export function verifyHmacClaimToken(token, secret) {
  if (typeof token !== 'string' || typeof secret !== 'string') {
    return { valid: false, reason: 'invalid_arguments' };
  }
  const parts = token.split('.');
  if (parts.length !== 2) {
    return { valid: false, reason: 'malformed_structure' };
  }
  const [payloadPart, signaturePart] = parts;
  let payloadStr;
  try {
    payloadStr = Buffer.from(payloadPart, 'base64url').toString('utf8');
  } catch {
    return { valid: false, reason: 'invalid_encoding' };
  }

  let signatureBuffer;
  try {
    signatureBuffer = Buffer.from(signaturePart, 'base64url');
  } catch {
    return { valid: false, reason: 'invalid_signature_encoding' };
  }

  const computedSignature = crypto.createHmac('sha256', secret).update(payloadStr).digest();

  if (
    signatureBuffer.length !== computedSignature.length ||
    !crypto.timingSafeEqual(signatureBuffer, computedSignature)
  ) {
    return { valid: false, reason: 'signature_mismatch' };
  }

  try {
    const payload = JSON.parse(payloadStr);
    return { valid: true, payload };
  } catch {
    return { valid: false, reason: 'invalid_json' };
  }
}

/**
 * Redacts sensitive tokens, passwords, card numbers, and secret values from strings.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function redactSensitive(value) {
  if (value === null || value === undefined) {
    return '';
  }
  let str = typeof value === 'string' ? value : String(value);

  str = str.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer <redacted>');
  str = str.replace(/"(?:password|passportNumber|cvv|securityCode)"\s*:\s*"[^"]*"/gi, (match) => {
    const field = match.slice(0, match.indexOf(':'));
    return `${field}: "<redacted>"`;
  });
  str = str.replace(
    /([?&][^=&\s]*(?:password|token|key|secret|passport|cvv)[^=&\s]*=)[^&\s]+/gi,
    '$1<redacted>',
  );
  str = str.replace(/\b(?:sk_live_|sk_test_|rk_live_|rk_test_)[0-9a-zA-Z]+\b/g, '<redacted>');
  str = str.replace(/\b(?:\d{4}[- ]){3}\d{4}\b/g, '<redacted>');
  str = str.replace(/\b\d{15,16}\b/g, '<redacted>');

  return str;
}
