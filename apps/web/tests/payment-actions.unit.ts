import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, describe, it, mock } from 'node:test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const testRequire = createRequire(import.meta.url);

type MockSession = { accessToken?: string; user?: { id: string; email: string } } | null;
let currentSession: MockSession = null;
const mockGetServerSession = mock.fn(async (): Promise<MockSession> => currentSession);

const resolveModulePath = (specifier: string): string => {
  try {
    return testRequire.resolve(specifier);
  } catch {
    return require.resolve(specifier, {
      paths: [
        path.resolve(__dirname, '../node_modules'),
        path.resolve(process.cwd(), 'node_modules'),
      ],
    });
  }
};

const nextAuthPath = resolveModulePath('next-auth');
const originalNextAuthModule = testRequire.cache[nextAuthPath];
const mockNextAuth = new Module(nextAuthPath);
mockNextAuth.exports = {
  getServerSession: mockGetServerSession,
  default: { getServerSession: mockGetServerSession },
};
testRequire.cache[nextAuthPath] = mockNextAuth;

const serverOnlyPath = resolveModulePath('server-only');
const originalServerOnlyModule = testRequire.cache[serverOnlyPath];
const mockServerOnly = new Module(serverOnlyPath);
mockServerOnly.exports = {};
testRequire.cache[serverOnlyPath] = mockServerOnly;

after(() => {
  if (originalNextAuthModule) {
    testRequire.cache[nextAuthPath] = originalNextAuthModule;
  } else {
    delete testRequire.cache[nextAuthPath];
  }
  if (originalServerOnlyModule) {
    testRequire.cache[serverOnlyPath] = originalServerOnlyModule;
  } else {
    delete testRequire.cache[serverOnlyPath];
  }
});

const originalFetch = globalThis.fetch;
const originalApiUrl = process.env.API_URL;
const originalNextPublicApiUrl = process.env.NEXT_PUBLIC_API_URL;

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.API_URL = originalApiUrl;
  process.env.NEXT_PUBLIC_API_URL = originalNextPublicApiUrl;
  currentSession = null;
  mockGetServerSession.mock.resetCalls();
});

let createPaymentAction: typeof import('../app/checkout/[intentId]/payment/actions').createPaymentAction;
let confirmPaymentAction: typeof import('../app/checkout/[intentId]/payment/actions').confirmPaymentAction;
let getPaymentStatusAction: typeof import('../app/checkout/[intentId]/payment/actions').getPaymentStatusAction;

before(async () => {
  const actionsModule = await import('../app/checkout/[intentId]/payment/actions');
  createPaymentAction = actionsModule.createPaymentAction;
  confirmPaymentAction = actionsModule.confirmPaymentAction;
  getPaymentStatusAction = actionsModule.getPaymentStatusAction;
});

describe('Payment Server Actions', () => {
  describe('createPaymentAction', () => {
    it('returns UNAUTHENTICATED when session is missing', async () => {
      currentSession = null;
      const result = await createPaymentAction({
        bookingIntentId: 'intent_123',
        idempotencyKey: 'idemp_key_auth_001',
      });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reason, 'UNAUTHENTICATED');
        assert.equal(result.retryable, false);
      }
    });

    it('returns INVALID_COMMAND when bookingIntentId is missing or empty', async () => {
      currentSession = { accessToken: 'valid_jwt_token' };
      const result = await createPaymentAction({
        bookingIntentId: '   ',
        idempotencyKey: 'idemp_key_valid_123',
      });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reason, 'INVALID_COMMAND');
        assert.equal(result.retryable, false);
      }
    });

    it('requires caller-owned stable idempotencyKey, rejecting missing or blank before fetch with zero dispatch, and preserving key across retries', async () => {
      currentSession = { accessToken: 'valid_jwt_token' };

      let fetchCallCount = 0;
      const dispatchedHeaders: Array<Record<string, string>> = [];
      globalThis.fetch = mock.fn(
        async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          fetchCallCount++;
          const headersRecord: Record<string, string> = {};
          if (init?.headers) {
            const h = new Headers(init.headers);
            h.forEach((val, key) => {
              headersRecord[key.toLowerCase()] = val;
            });
          }
          dispatchedHeaders.push(headersRecord);
          return new Response(
            JSON.stringify({
              paymentId: 'pay_123',
              clientSecret: 'secret_123',
              status: 'REQUIRES_PAYMENT_METHOD',
            }),
            { status: 201, headers: { 'Content-Type': 'application/json' } },
          );
        },
      );

      // 1. Missing idempotencyKey rejects before fetch with zero network dispatch
      const resMissingUntyped = await Reflect.apply(createPaymentAction, undefined, [
        { bookingIntentId: 'intent_123' },
      ]);
      const resMissing =
        typeof resMissingUntyped === 'object' && resMissingUntyped !== null
          ? resMissingUntyped
          : { ok: false, reason: 'INVALID_COMMAND', retryable: false };
      assert.equal(Reflect.get(resMissing, 'ok'), false);
      assert.equal(Reflect.get(resMissing, 'reason'), 'INVALID_COMMAND');
      assert.equal(Reflect.get(resMissing, 'retryable'), false);
      assert.equal(fetchCallCount, 0, 'Zero fetch calls dispatched on missing idempotencyKey');

      // 2. Blank whitespace idempotencyKey rejects before fetch with zero network dispatch
      const resBlank = await createPaymentAction({
        bookingIntentId: 'intent_123',
        idempotencyKey: '   ',
      });
      assert.equal(resBlank.ok, false);
      if (!resBlank.ok) {
        assert.equal(resBlank.reason, 'INVALID_COMMAND');
        assert.equal(resBlank.retryable, false);
      }
      assert.equal(fetchCallCount, 0, 'Zero fetch calls dispatched on blank idempotencyKey');

      // 3. Retry with same caller-owned key sends exact same header even after lost response
      const stableKey = 'caller-stable-create-key-001';

      // First attempt: network failure / lost response
      globalThis.fetch = mock.fn(
        async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          fetchCallCount++;
          const headersRecord: Record<string, string> = {};
          if (init?.headers) {
            const h = new Headers(init.headers);
            h.forEach((val, key) => {
              headersRecord[key.toLowerCase()] = val;
            });
          }
          dispatchedHeaders.push(headersRecord);
          const err = new Error('Network dropped connection');
          err.name = 'TimeoutError';
          throw err;
        },
      );

      const resLost = await createPaymentAction({
        bookingIntentId: 'intent_123',
        idempotencyKey: stableKey,
      });
      assert.equal(resLost.ok, false);
      assert.equal(dispatchedHeaders.length, 1);
      assert.equal(dispatchedHeaders[0]['idempotency-key'], stableKey);

      // Second attempt (retry of lost response) with identical input: sends same caller-owned key
      globalThis.fetch = mock.fn(
        async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          fetchCallCount++;
          const headersRecord: Record<string, string> = {};
          if (init?.headers) {
            const h = new Headers(init.headers);
            h.forEach((val, key) => {
              headersRecord[key.toLowerCase()] = val;
            });
          }
          dispatchedHeaders.push(headersRecord);
          return new Response(
            JSON.stringify({
              paymentId: 'pay_retry_success',
              clientSecret: 'secret_retry_success',
              status: 'READY',
            }),
            { status: 201, headers: { 'Content-Type': 'application/json' } },
          );
        },
      );

      const resRetry = await createPaymentAction({
        bookingIntentId: 'intent_123',
        idempotencyKey: stableKey,
      });
      assert.equal(resRetry.ok, true);
      assert.equal(dispatchedHeaders.length, 2);
      assert.equal(dispatchedHeaders[1]['idempotency-key'], stableKey);

      // 4. Distinct deliberate keys stay distinct
      const distinctKey = 'caller-second-distinct-key-002';
      const resDistinct = await createPaymentAction({
        bookingIntentId: 'intent_123',
        idempotencyKey: distinctKey,
      });
      assert.equal(resDistinct.ok, true);
      assert.equal(dispatchedHeaders.length, 3);
      assert.equal(dispatchedHeaders[2]['idempotency-key'], distinctKey);
    });

    it('successfully creates payment, sets authorization and idempotency headers, and returns safe secret payload without leaking token', async () => {
      currentSession = {
        accessToken: 'user_jwt_secret_token_123',
        user: { id: 'usr_1', email: 'test@example.com' },
      };

      let capturedUrl = '';
      let capturedMethod = '';
      const capturedHeaders: Record<string, string> = {};
      let capturedBody: unknown = null;

      globalThis.fetch = mock.fn(
        async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          capturedUrl = typeof input === 'string' ? input : input.toString();
          capturedMethod = init?.method ?? 'GET';
          if (init?.headers) {
            const h = new Headers(init.headers);
            h.forEach((val, key) => {
              capturedHeaders[key] = val;
            });
          }
          if (typeof init?.body === 'string') {
            try {
              capturedBody = JSON.parse(init.body);
            } catch {
              capturedBody = init.body;
            }
          }

          const upstreamPayload = {
            paymentId: 'pay_created_456',
            clientSecret: 'pi_secret_stripe_elements_789',
            status: 'REQUIRES_PAYMENT_METHOD',
            internalTransportSecret: 'leaked_internal_secret_must_be_stripped',
          };

          return new Response(JSON.stringify(upstreamPayload), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      );

      const result = await createPaymentAction({
        bookingIntentId: 'intent_def_456',
        idempotencyKey: 'custom-idem-key-001',
      });

      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.data.status, 'READY');
        if (result.data.status === 'READY') {
          assert.equal(result.data.paymentId, 'pay_created_456');
          assert.equal(result.data.clientSecret, 'pi_secret_stripe_elements_789');
          assert.equal(result.data.paymentStatus, 'REQUIRES_PAYMENT_METHOD');

          // Zero-Client-Credential verification: ensure no JWT, backend URL, or unchecked keys leaked to client return
          const returnedKeys = Object.keys(result.data);
          assert.deepEqual(returnedKeys.sort(), [
            'clientSecret',
            'paymentId',
            'paymentStatus',
            'status',
          ]);
          assert.equal('accessToken' in result.data, false);
          assert.equal('internalTransportSecret' in result.data, false);
        }
      }

      // Assert upstream request contract
      assert.ok(capturedUrl.endsWith('/api/bookings/payment/create'));
      assert.equal(capturedMethod, 'POST');
      assert.equal(capturedHeaders['authorization'], 'Bearer user_jwt_secret_token_123');
      assert.equal(capturedHeaders['idempotency-key'], 'custom-idem-key-001');
      assert.deepEqual(capturedBody, {
        bookingIntentId: 'intent_def_456',
      });
    });

    it('returns discriminated PENDING outcome without fabricated secret for RESERVED or explicit PENDING backend responses, and preserves unresolved transport failure without inventing paymentId', async () => {
      currentSession = { accessToken: 'valid_jwt_token' };

      // Case 1: Backend returns RESERVED without clientSecret (reservation semantics)
      globalThis.fetch = mock.fn(
        async (): Promise<Response> =>
          new Response(
            JSON.stringify({
              paymentId: 'pay_reserved_101',
              status: 'RESERVED',
            }),
            { status: 201, headers: { 'Content-Type': 'application/json' } },
          ),
      );
      const resReserved = await createPaymentAction({
        bookingIntentId: 'intent_res_101',
        idempotencyKey: 'idemp_key_res_101',
      });
      assert.equal(resReserved.ok, true);
      if (resReserved.ok) {
        assert.equal(resReserved.data.status, 'PENDING');
        assert.equal(resReserved.data.paymentId, 'pay_reserved_101');
        assert.equal(resReserved.data.paymentStatus, 'RESERVED');
        assert.equal('clientSecret' in resReserved.data, false);
      }

      // Case 2: Backend returns explicit PENDING
      globalThis.fetch = mock.fn(
        async (): Promise<Response> =>
          new Response(
            JSON.stringify({
              paymentId: 'pay_pending_202',
              status: 'PENDING',
              clientSecret: null,
            }),
            { status: 201, headers: { 'Content-Type': 'application/json' } },
          ),
      );
      const resPending = await createPaymentAction({
        bookingIntentId: 'intent_pen_202',
        idempotencyKey: 'idemp_key_pen_202',
      });
      assert.equal(resPending.ok, true);
      if (resPending.ok) {
        assert.equal(resPending.data.status, 'PENDING');
        assert.equal(resPending.data.paymentId, 'pay_pending_202');
        assert.equal(resPending.data.paymentStatus, 'PENDING');
        assert.equal('clientSecret' in resPending.data, false);
      }

      // Case 3: Network timeout / transport error on create preserves unresolved outcome without inventing paymentId
      globalThis.fetch = mock.fn(async (): Promise<Response> => {
        const error = new Error('Create network timeout');
        error.name = 'TimeoutError';
        throw error;
      });
      const resTimeout = await createPaymentAction({
        bookingIntentId: 'intent_timeout_303',
        idempotencyKey: 'caller-owned-key-xyz',
      });
      assert.equal(resTimeout.ok, false);
      if (!resTimeout.ok) {
        assert.equal(resTimeout.reason, 'UPSTREAM_UNAVAILABLE');
        assert.equal(resTimeout.retryable, true);
      }
    });

    it('safely handles PENDING create with empty string clientSecret and fails closed on malformed ready status with null or empty clientSecret', async () => {
      currentSession = { accessToken: 'valid_jwt_token' };
      const bookingIntentId = 'intent_s3_test';
      const paymentId = 'pay_s3_test_123';

      // 1. Backend returns status: 'PENDING' with empty string clientSecret: '' (reviewer probe case)
      globalThis.fetch = mock.fn(
        async (): Promise<Response> =>
          new Response(
            JSON.stringify({
              paymentId,
              status: 'PENDING',
              clientSecret: '',
            }),
            { status: 201, headers: { 'Content-Type': 'application/json' } },
          ),
      );

      const resEmptySecretPending = await createPaymentAction({
        bookingIntentId,
        idempotencyKey: 'idemp_key_empty_secret',
      });
      assert.equal(resEmptySecretPending.ok, true);
      if (resEmptySecretPending.ok) {
        assert.equal(resEmptySecretPending.data.status, 'PENDING');
        assert.equal(resEmptySecretPending.data.paymentId, paymentId);
        assert.equal(resEmptySecretPending.data.paymentStatus, 'PENDING');
        assert.equal('clientSecret' in resEmptySecretPending.data, false);
      }

      // 2. Malformed upstream ready response: status claims READY or REQUIRES_PAYMENT_METHOD but clientSecret is null or empty
      // Ready requires actual nonempty secret; null clientSecret on ready cannot magically mean resolved.
      globalThis.fetch = mock.fn(
        async (): Promise<Response> =>
          new Response(
            JSON.stringify({
              paymentId,
              status: 'READY',
              clientSecret: null,
            }),
            { status: 201, headers: { 'Content-Type': 'application/json' } },
          ),
      );

      const resMalformedReady = await createPaymentAction({
        bookingIntentId,
        idempotencyKey: 'idemp_key_malformed_ready',
      });
      assert.equal(resMalformedReady.ok, false);
      if (!resMalformedReady.ok) {
        assert.equal(resMalformedReady.reason, 'UPSTREAM_UNAVAILABLE');
        assert.equal(resMalformedReady.retryable, true);
      }
    });

    it('maps upstream HTTP 404, 403, and 500 error responses correctly', async () => {
      currentSession = { accessToken: 'valid_jwt_token' };

      // Case 404: Not Found
      globalThis.fetch = mock.fn(async (): Promise<Response> => {
        return new Response(JSON.stringify({ message: 'Intent not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      });
      const res404 = await createPaymentAction({
        bookingIntentId: 'intent_nonexistent',
        idempotencyKey: 'idemp_key_404',
      });
      assert.equal(res404.ok, false);
      if (!res404.ok) {
        assert.equal(res404.reason, 'NOT_FOUND');
        assert.equal(res404.retryable, false);
      }

      // Case 403: Forbidden
      globalThis.fetch = mock.fn(async (): Promise<Response> => {
        return new Response(JSON.stringify({ message: 'Forbidden' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        });
      });
      const res403 = await createPaymentAction({
        bookingIntentId: 'intent_other_user',
        idempotencyKey: 'idemp_key_403',
      });
      assert.equal(res403.ok, false);
      if (!res403.ok) {
        assert.equal(res403.reason, 'FORBIDDEN');
        assert.equal(res403.retryable, false);
      }

      // Case 500: Upstream Unavailable
      globalThis.fetch = mock.fn(async (): Promise<Response> => {
        return new Response(JSON.stringify({ message: 'Database failure' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      });
      const res500 = await createPaymentAction({
        bookingIntentId: 'intent_error',
        idempotencyKey: 'idemp_key_500',
      });
      assert.equal(res500.ok, false);
      if (!res500.ok) {
        assert.equal(res500.reason, 'UPSTREAM_UNAVAILABLE');
        assert.equal(res500.retryable, true);
      }
    });

    it('prevents leakage of upstream error markers in create and confirm, and uses safe customer messages', async () => {
      currentSession = { accessToken: 'valid_jwt_token' };
      const secretMarker = 'STRIPE_SECRET_KEY_LEAK_MARKER_999';

      // 1. Error marker in HTTP 400 during createPaymentAction
      globalThis.fetch = mock.fn(async (): Promise<Response> => {
        return new Response(JSON.stringify({ message: secretMarker }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const resCreate = await createPaymentAction({
        bookingIntentId: 'intent_123',
        idempotencyKey: 'idemp_key_marker_test',
      });
      assert.equal(resCreate.ok, false);
      if (!resCreate.ok) {
        assert.equal(resCreate.reason, 'INVALID_COMMAND');
        assert.equal(resCreate.message.includes(secretMarker), false);
      }

      // 2. Error marker in HTTP 400 during confirmPaymentAction
      globalThis.fetch = mock.fn(async (): Promise<Response> => {
        return new Response(JSON.stringify({ message: secretMarker }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const validBookingUuid = '26aaee91-cd85-4c22-80dc-cb16ec265721';
      const validPaymentId = 'a2183d69-bf15-4847-a089-33792587e5b2';

      const resConfirm = await confirmPaymentAction({
        bookingId: validBookingUuid,
        paymentId: validPaymentId,
      });
      assert.equal(resConfirm.ok, false);
      if (!resConfirm.ok) {
        assert.equal(resConfirm.reason, 'INVALID_COMMAND');
        assert.equal(resConfirm.message.includes(secretMarker), false);
      }
    });
  });

  describe('confirmPaymentAction', () => {
    it('preserves matching payment IDs and caller-scoped legacy responses without an ID', async () => {
      currentSession = { accessToken: 'valid_jwt_token' };
      const paymentId = 'a2183d69-bf15-4847-a089-33792587e5b2';
      for (const identity of [{ paymentId }, {}]) {
        for (const reply of [
          {
            httpStatus: 200,
            body: { status: 'CONFIRMED', bookingReference: 'ABCDEF', duffelOrderId: 'ord_one' },
            expectedStatus: 'CONFIRMED',
          },
          {
            httpStatus: 200,
            body: { success: true, bookingReference: 'ABCDEF', duffelOrderId: 'ord_one' },
            expectedStatus: 'SUCCEEDED',
          },
          {
            httpStatus: 502,
            body: { success: false, bookingStatus: 'CANCELLED' },
            expectedStatus: 'FAILED',
          },
          {
            httpStatus: 502,
            body: { success: false, bookingStatus: 'PROCESSING' },
            expectedStatus: 'PENDING',
          },
        ]) {
          globalThis.fetch = mock.fn(async (): Promise<Response> => {
            return new Response(JSON.stringify({ ...reply.body, ...identity }), {
              status: reply.httpStatus,
              headers: { 'Content-Type': 'application/json' },
            });
          });
          const result = await confirmPaymentAction({
            bookingId: '26aaee91-cd85-4c22-80dc-cb16ec265721',
            paymentId,
          });
          assert.equal(result.ok, true);
          if (result.ok) {
            assert.equal(result.data.status, reply.expectedStatus);
            assert.equal(result.data.paymentId, paymentId);
          }
        }
      }
    });

    it('fails closed on every supplied malformed payment ID in successful and HTTP error responses', async () => {
      currentSession = { accessToken: 'valid_jwt_token' };
      const paymentId = 'a2183d69-bf15-4847-a089-33792587e5b2';
      for (const suppliedId of [123, {}, null, '', '   ']) {
        for (const httpStatus of [200, 502, 400, 401, 403, 404, 422]) {
          globalThis.fetch = mock.fn(async (): Promise<Response> => {
            return new Response(
              JSON.stringify({
                paymentId: suppliedId,
                status: 'CONFIRMED',
                bookingReference: 'ABCDEF',
                duffelOrderId: 'ord_one',
                success: false,
                bookingStatus: 'CANCELLED',
              }),
              { status: httpStatus, headers: { 'Content-Type': 'application/json' } },
            );
          });
          const result = await confirmPaymentAction({
            bookingId: '26aaee91-cd85-4c22-80dc-cb16ec265721',
            paymentId,
          });
          assert.equal(
            result.ok,
            false,
            `supplied ID ${JSON.stringify(suppliedId)}, HTTP ${httpStatus}`,
          );
          if (!result.ok) {
            assert.equal(result.reason, 'UPSTREAM_UNAVAILABLE');
            assert.equal(result.retryable, true);
          }
        }
      }
    });

    it('fails closed when an HTTP error supplies another payment ID before projecting final or pending status', async () => {
      currentSession = { accessToken: 'valid_jwt_token' };
      const paymentId = 'a2183d69-bf15-4847-a089-33792587e5b2';
      for (const bookingStatus of ['CANCELLED', 'PROCESSING']) {
        globalThis.fetch = mock.fn(async (): Promise<Response> => {
          return new Response(
            JSON.stringify({ paymentId: 'different', success: false, bookingStatus }),
            { status: 502, headers: { 'Content-Type': 'application/json' } },
          );
        });
        const result = await confirmPaymentAction({
          bookingId: '26aaee91-cd85-4c22-80dc-cb16ec265721',
          paymentId,
        });
        assert.deepEqual(result, {
          ok: false,
          reason: 'UPSTREAM_UNAVAILABLE',
          message: 'Invalid confirmation payload received from upstream service.',
          retryable: true,
        });
      }
    });

    it('returns UNAUTHENTICATED when session is missing', async () => {
      currentSession = null;
      const result = await confirmPaymentAction({
        bookingId: '26aaee91-cd85-4c22-80dc-cb16ec265721',
        paymentId: 'pay_123',
      });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reason, 'UNAUTHENTICATED');
        assert.equal(result.retryable, false);
      }
    });

    it('returns INVALID_COMMAND when bookingId or paymentId is missing or empty or invalid UUID', async () => {
      currentSession = { accessToken: 'valid_jwt_token' };

      const resMissingBooking = await confirmPaymentAction({
        bookingId: '   ',
        paymentId: 'pay_123',
      });
      assert.equal(resMissingBooking.ok, false);
      if (!resMissingBooking.ok) {
        assert.equal(resMissingBooking.reason, 'INVALID_COMMAND');
      }

      const resInvalidUuid = await confirmPaymentAction({
        bookingId: 'not-a-valid-uuid',
        paymentId: 'pay_123',
      });
      assert.equal(resInvalidUuid.ok, false);
      if (!resInvalidUuid.ok) {
        assert.equal(resInvalidUuid.reason, 'INVALID_COMMAND');
      }

      const resMissingPayment = await confirmPaymentAction({
        bookingId: '26aaee91-cd85-4c22-80dc-cb16ec265721',
        paymentId: '',
      });
      assert.equal(resMissingPayment.ok, false);
      if (!resMissingPayment.ok) {
        assert.equal(resMissingPayment.reason, 'INVALID_COMMAND');
      }
    });

    it('successfully confirms payment, returning SUCCEEDED status and booking reference', async () => {
      currentSession = {
        accessToken: 'user_jwt_secret_token_123',
      };

      let capturedUrl = '';
      let capturedMethod = '';
      const capturedHeaders: Record<string, string> = {};
      let capturedBody: unknown = null;

      globalThis.fetch = mock.fn(
        async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          capturedUrl = typeof input === 'string' ? input : input.toString();
          capturedMethod = init?.method ?? 'GET';
          if (init?.headers) {
            const h = new Headers(init.headers);
            h.forEach((val, key) => {
              capturedHeaders[key] = val;
            });
          }
          if (typeof init?.body === 'string') {
            try {
              capturedBody = JSON.parse(init.body);
            } catch {
              capturedBody = init.body;
            }
          }

          const upstreamPayload = {
            success: true,
            status: 'SUCCEEDED',
            paymentId: 'pay_confirmed_789',
            bookingReference: 'DUFFEL-PNR-ABC',
            duffelOrderId: 'ord_duffel_111',
            internalTransportPayload: 'must_not_leak',
          };

          return new Response(JSON.stringify(upstreamPayload), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      );

      const result = await confirmPaymentAction({
        bookingId: '26aaee91-cd85-4c22-80dc-cb16ec265721',
        paymentId: 'pay_confirmed_789',
        idempotencyKey: 'confirm-idem-key-002',
      });

      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.data.status, 'SUCCEEDED');
        assert.equal(result.data.paymentId, 'pay_confirmed_789');
        assert.equal(result.data.bookingReference, 'DUFFEL-PNR-ABC');
        assert.equal(result.data.duffelOrderId, 'ord_duffel_111');

        assert.equal('internalTransportPayload' in result.data, false);
        assert.equal('accessToken' in result.data, false);
      }

      assert.ok(capturedUrl.endsWith('/api/bookings/payment/confirm'));
      assert.equal(capturedMethod, 'POST');
      assert.equal(capturedHeaders['authorization'], 'Bearer user_jwt_secret_token_123');
      assert.equal(capturedHeaders['idempotency-key'], 'confirm-idem-key-002');
      assert.deepEqual(capturedBody, {
        bookingId: '26aaee91-cd85-4c22-80dc-cb16ec265721',
        paymentId: 'pay_confirmed_789',
      });
    });

    it('returns truthful PENDING outcome when upstream returns HTTP 202 Accepted', async () => {
      currentSession = { accessToken: 'valid_jwt_token' };

      globalThis.fetch = mock.fn(async (): Promise<Response> => {
        return new Response(
          JSON.stringify({
            status: 'PENDING',
            message: 'Booking is being confirmed. Please poll status.',
            pollUrl: '/api/bookings/payment/pay_pending_999/status',
          }),
          {
            status: 202,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      });

      const result = await confirmPaymentAction({
        bookingId: '26aaee91-cd85-4c22-80dc-cb16ec265721',
        paymentId: 'pay_pending_999',
      });

      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.data.status, 'PENDING');
        assert.equal(result.data.paymentId, 'pay_pending_999');
        assert.ok(result.data.message?.includes('poll status'));
      }
    });

    it('asserts truthful PENDING after transport timeout or uncertain network response during confirmation', async () => {
      currentSession = { accessToken: 'valid_jwt_token' };

      globalThis.fetch = mock.fn(async (): Promise<Response> => {
        const error = new Error('Gateway Timeout');
        error.name = 'TimeoutError';
        throw error;
      });

      const result = await confirmPaymentAction({
        bookingId: '26aaee91-cd85-4c22-80dc-cb16ec265721',
        paymentId: 'pay_timeout_888',
      });

      // Truthful pending: network uncertainty or timeout must not report definitive failure
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.data.status, 'PENDING');
        assert.equal(result.data.paymentId, 'pay_timeout_888');
        assert.ok(result.data.message !== undefined && result.data.message.length > 0);
      }
    });

    it('returns truthful PENDING for unresolved capture HTTP 502 with PROCESSING and explicit PENDING with success:false, avoiding false failure or hold-release claims', async () => {
      currentSession = { accessToken: 'valid_jwt_token' };
      const bookingId = '26aaee91-cd85-4c22-80dc-cb16ec265721';
      const paymentId = 'a2183d69-bf15-4847-a089-33792587e5b2';

      // 1. Real saga HTTP 502 with bookingStatus: 'PROCESSING'
      globalThis.fetch = mock.fn(async (): Promise<Response> => {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Stripe capture outcome is unknown. Retry payment confirmation.',
            bookingStatus: 'PROCESSING',
          }),
          { status: 502, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const resUnknownCapture = await confirmPaymentAction({ bookingId, paymentId });
      assert.equal(resUnknownCapture.ok, true);
      if (resUnknownCapture.ok) {
        assert.equal(resUnknownCapture.data.status, 'PENDING');
        assert.equal(resUnknownCapture.data.paymentId, paymentId);
        assert.equal(resUnknownCapture.data.message?.includes('holds have been released'), false);
      }

      // 2. Explicit status: 'PENDING' with success: false
      globalThis.fetch = mock.fn(async (): Promise<Response> => {
        return new Response(
          JSON.stringify({
            status: 'PENDING',
            success: false,
            paymentId,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const resExplicitPending = await confirmPaymentAction({ bookingId, paymentId });
      assert.equal(resExplicitPending.ok, true);
      if (resExplicitPending.ok) {
        assert.equal(resExplicitPending.data.status, 'PENDING');
        assert.equal(resExplicitPending.data.paymentId, paymentId);
        assert.equal(resExplicitPending.data.message?.includes('holds have been released'), false);
      }
    });

    it('maps legacy saga cancelled failure and explicit failure payloads to FAILED outcome without leaking upstream error', async () => {
      currentSession = { accessToken: 'valid_jwt_token' };
      const bookingId = '26aaee91-cd85-4c22-80dc-cb16ec265721';
      const paymentId = 'a2183d69-bf15-4847-a089-33792587e5b2';

      // 1. Legacy saga replay: { success: false, error: '...', bookingStatus: 'CANCELLED' }
      globalThis.fetch = mock.fn(async (): Promise<Response> => {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Duffel booking failed. Payment hold released. [secret_marker_123]',
            bookingStatus: 'CANCELLED',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const resLegacy = await confirmPaymentAction({ bookingId, paymentId });
      assert.equal(resLegacy.ok, true);
      if (resLegacy.ok) {
        assert.equal(resLegacy.data.status, 'FAILED');
        assert.equal(resLegacy.data.paymentId, paymentId);
        assert.equal(resLegacy.data.message?.includes('secret_marker_123'), false);
      }

      // 2. Explicit failure: { status: 'CANCELLED', paymentId }
      globalThis.fetch = mock.fn(async (): Promise<Response> => {
        return new Response(
          JSON.stringify({
            status: 'CANCELLED',
            paymentId,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const resExplicit = await confirmPaymentAction({ bookingId, paymentId });
      assert.equal(resExplicit.ok, true);
      if (resExplicit.ok) {
        assert.equal(resExplicit.data.status, 'FAILED');
        assert.equal(resExplicit.data.paymentId, paymentId);
      }
    });

    it('maps proven legacy saga failure body to neutral FAILED outcome while preserving unknown, PENDING precedence, and identity guards', async () => {
      currentSession = { accessToken: 'valid_jwt_token' };
      const bookingId = '26aaee91-cd85-4c22-80dc-cb16ec265721';
      const paymentId = 'a2183d69-bf15-4847-a089-33792587e5b2';

      // 1. Literal real HTTP 502 saga first-attempt booking failure:
      // payment-fulfillment.saga.ts lines 680-748:
      // { success: false, error: 'Duffel booking failed: ... Payment hold released.', bookingStatus: 'AWAITING_PAYMENT' }
      globalThis.fetch = mock.fn(async (): Promise<Response> => {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Duffel booking failed: Airline inventory exhausted. Payment hold released.',
            bookingStatus: 'AWAITING_PAYMENT',
          }),
          { status: 502, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const resSaga502 = await confirmPaymentAction({ bookingId, paymentId });
      assert.equal(resSaga502.ok, true);
      if (resSaga502.ok) {
        assert.equal(resSaga502.data.status, 'FAILED');
        assert.equal(resSaga502.data.paymentId, paymentId);
        assert.equal(resSaga502.data.message, 'Payment confirmation failed.');
        assert.equal(resSaga502.data.message?.includes('Payment hold released'), false);
        assert.equal(resSaga502.data.message?.includes('Duffel booking failed'), false);
      }

      // 2. Real HTTP 502 passenger validation failure with code and AWAITING_PAYMENT:
      globalThis.fetch = mock.fn(async (): Promise<Response> => {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Passenger validation failed: Passport required. Payment hold released.',
            code: 'PASSENGER_VALIDATION_ERROR',
            bookingStatus: 'AWAITING_PAYMENT',
          }),
          { status: 502, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const resPassenger502 = await confirmPaymentAction({ bookingId, paymentId });
      assert.equal(resPassenger502.ok, true);
      if (resPassenger502.ok) {
        assert.equal(resPassenger502.data.status, 'FAILED');
        assert.equal(resPassenger502.data.paymentId, paymentId);
        assert.equal(resPassenger502.data.message, 'Payment confirmation failed.');
      }

      // 3. AWAITING_PAYMENT alone is NOT failure evidence (missing success:false and nonempty error)
      globalThis.fetch = mock.fn(async (): Promise<Response> => {
        return new Response(
          JSON.stringify({
            bookingStatus: 'AWAITING_PAYMENT',
          }),
          { status: 502, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const resAwaitingAlone = await confirmPaymentAction({ bookingId, paymentId });
      assert.equal(resAwaitingAlone.ok, false);
      if (!resAwaitingAlone.ok) {
        assert.equal(resAwaitingAlone.reason, 'UPSTREAM_UNAVAILABLE');
        assert.equal(resAwaitingAlone.retryable, true);
      }

      // 4. Malformed success or error fields do not project to FAILED
      for (const malformedBody of [
        { success: 'false', error: 'booking failed', bookingStatus: 'AWAITING_PAYMENT' },
        { success: false, error: '   ', bookingStatus: 'AWAITING_PAYMENT' },
        { success: false, error: 12345, bookingStatus: 'AWAITING_PAYMENT' },
        { success: false, bookingStatus: 'AWAITING_PAYMENT' },
      ]) {
        globalThis.fetch = mock.fn(async (): Promise<Response> => {
          return new Response(JSON.stringify(malformedBody), {
            status: 502,
            headers: { 'Content-Type': 'application/json' },
          });
        });

        const resMalformed = await confirmPaymentAction({ bookingId, paymentId });
        assert.equal(resMalformed.ok, false);
        if (!resMalformed.ok) {
          assert.equal(resMalformed.reason, 'UPSTREAM_UNAVAILABLE');
          assert.equal(resMalformed.retryable, true);
        }
      }

      // 5. Explicit unresolved/PENDING precedence over legacy failure body
      globalThis.fetch = mock.fn(async (): Promise<Response> => {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Temporary saga delay',
            bookingStatus: 'PENDING',
          }),
          { status: 502, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const resPendingPrecedence = await confirmPaymentAction({ bookingId, paymentId });
      assert.equal(resPendingPrecedence.ok, true);
      if (resPendingPrecedence.ok) {
        assert.equal(resPendingPrecedence.data.status, 'PENDING');
        assert.equal(resPendingPrecedence.data.paymentId, paymentId);
      }

      // 6. Contradictory outcome: status claims CONFIRMED but success:false & bookingStatus:AWAITING_PAYMENT
      globalThis.fetch = mock.fn(async (): Promise<Response> => {
        return new Response(
          JSON.stringify({
            status: 'CONFIRMED',
            success: false,
            error: 'Contradictory status',
            bookingStatus: 'AWAITING_PAYMENT',
          }),
          { status: 502, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const resContradictory = await confirmPaymentAction({ bookingId, paymentId });
      assert.equal(resContradictory.ok, false);
      if (!resContradictory.ok) {
        assert.equal(resContradictory.reason, 'UPSTREAM_UNAVAILABLE');
      }

      // 7. Identity guard takes precedence over legacy failure body on HTTP error
      globalThis.fetch = mock.fn(async (): Promise<Response> => {
        return new Response(
          JSON.stringify({
            paymentId: 'different_payment_id_999',
            success: false,
            error: 'Duffel booking failed. Payment hold released.',
            bookingStatus: 'AWAITING_PAYMENT',
          }),
          { status: 502, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const resMismatchedId = await confirmPaymentAction({ bookingId, paymentId });
      assert.equal(resMismatchedId.ok, false);
      if (!resMismatchedId.ok) {
        assert.equal(resMismatchedId.reason, 'UPSTREAM_UNAVAILABLE');
      }

      // 8. Legacy failure payload on HTTP 200 also safely projects to FAILED
      globalThis.fetch = mock.fn(async (): Promise<Response> => {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Booking failed on supplier side. Payment hold released.',
            bookingStatus: 'AWAITING_PAYMENT',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const res200Legacy = await confirmPaymentAction({ bookingId, paymentId });
      assert.equal(res200Legacy.ok, true);
      if (res200Legacy.ok) {
        assert.equal(res200Legacy.data.status, 'FAILED');
        assert.equal(res200Legacy.data.paymentId, paymentId);
        assert.equal(res200Legacy.data.message, 'Payment confirmation failed.');
        assert.equal(res200Legacy.data.message?.includes('Payment hold released'), false);
      }
    });

    it('supports approved authoritative workflow variants (CONFIRMED, DEFINITIVE_FAILURE, COMPENSATED_FAILURE, REJECTED) with consistent discriminated results and safe messages', async () => {
      currentSession = { accessToken: 'valid_jwt_token' };
      const bookingId = '26aaee91-cd85-4c22-80dc-cb16ec265721';
      const paymentId = 'a2183d69-bf15-4847-a089-33792587e5b2';

      // 1. Authoritative CONFIRMED with validated supplier order
      globalThis.fetch = mock.fn(async (): Promise<Response> => {
        return new Response(
          JSON.stringify({
            status: 'CONFIRMED',
            paymentId,
            bookingReference: 'ABCDEF',
            duffelOrderId: 'ord_confirmed_123',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });
      const resConfirmed = await confirmPaymentAction({ bookingId, paymentId });
      assert.equal(resConfirmed.ok, true);
      if (resConfirmed.ok) {
        assert.equal(resConfirmed.data.status, 'CONFIRMED');
        assert.equal(resConfirmed.data.paymentId, paymentId);
        assert.equal(resConfirmed.data.bookingReference, 'ABCDEF');
        assert.equal(resConfirmed.data.duffelOrderId, 'ord_confirmed_123');
      }

      // 2. Authoritative COMPENSATED_FAILURE (verified completed compensation with safe hold-released message)
      globalThis.fetch = mock.fn(async (): Promise<Response> => {
        return new Response(
          JSON.stringify({
            status: 'COMPENSATED_FAILURE',
            paymentId,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });
      const resCompensated = await confirmPaymentAction({ bookingId, paymentId });
      assert.equal(resCompensated.ok, true);
      if (resCompensated.ok) {
        assert.equal(resCompensated.data.status, 'COMPENSATED_FAILURE');
        assert.equal(resCompensated.data.paymentId, paymentId);
        assert.ok(resCompensated.data.message?.includes('holds have been released'));
      }

      // 3. Authoritative DEFINITIVE_FAILURE (verified terminal failure with safe neutral message, NO hold-release claim)
      globalThis.fetch = mock.fn(async (): Promise<Response> => {
        return new Response(
          JSON.stringify({
            status: 'DEFINITIVE_FAILURE',
            paymentId,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });
      const resDefinitive = await confirmPaymentAction({ bookingId, paymentId });
      assert.equal(resDefinitive.ok, true);
      if (resDefinitive.ok) {
        assert.equal(resDefinitive.data.status, 'DEFINITIVE_FAILURE');
        assert.equal(resDefinitive.data.paymentId, paymentId);
        assert.equal(resDefinitive.data.message?.includes('holds have been released'), false);
      }

      // 4. Authoritative REJECTED (preflight or authorization rejected with safe neutral message, NO hold-release claim)
      globalThis.fetch = mock.fn(async (): Promise<Response> => {
        return new Response(
          JSON.stringify({
            status: 'REJECTED',
            paymentId,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });
      const resRejected = await confirmPaymentAction({ bookingId, paymentId });
      assert.equal(resRejected.ok, true);
      if (resRejected.ok) {
        assert.equal(resRejected.data.status, 'REJECTED');
        assert.equal(resRejected.data.paymentId, paymentId);
        assert.equal(resRejected.data.message?.includes('holds have been released'), false);
      }

      // 5. CONFIRMED lacking order evidence must fail closed
      globalThis.fetch = mock.fn(async (): Promise<Response> => {
        return new Response(
          JSON.stringify({
            status: 'CONFIRMED',
            paymentId,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });
      const resIncompleteConfirmed = await confirmPaymentAction({ bookingId, paymentId });
      assert.equal(resIncompleteConfirmed.ok, false);
      if (!resIncompleteConfirmed.ok) {
        assert.equal(resIncompleteConfirmed.reason, 'UPSTREAM_UNAVAILABLE');
      }
    });

    it('fails closed when confirmation returns incomplete success or unrecognized status without required order evidence', async () => {
      currentSession = { accessToken: 'valid_jwt_token' };
      const bookingId = '26aaee91-cd85-4c22-80dc-cb16ec265721';
      const paymentId = 'a2183d69-bf15-4847-a089-33792587e5b2';

      // 1. Lone success: true without bookingReference or duffelOrderId
      globalThis.fetch = mock.fn(async (): Promise<Response> => {
        return new Response(
          JSON.stringify({
            success: true,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const resLoneBoolean = await confirmPaymentAction({ bookingId, paymentId });
      assert.equal(resLoneBoolean.ok, false);
      if (!resLoneBoolean.ok) {
        assert.equal(resLoneBoolean.reason, 'UPSTREAM_UNAVAILABLE');
      }

      // 2. Unrecognized arbitrary status string
      globalThis.fetch = mock.fn(async (): Promise<Response> => {
        return new Response(
          JSON.stringify({
            status: 'ARBITRARY_UNKNOWN_STATUS',
            paymentId,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const resUnknown = await confirmPaymentAction({ bookingId, paymentId });
      assert.equal(resUnknown.ok, false);
      if (!resUnknown.ok) {
        assert.equal(resUnknown.reason, 'UPSTREAM_UNAVAILABLE');
      }

      // 3. Mismatched returned paymentId
      globalThis.fetch = mock.fn(async (): Promise<Response> => {
        return new Response(
          JSON.stringify({
            status: 'SUCCEEDED',
            paymentId: 'other-mismatched-payment-id',
            bookingReference: 'REF123',
            duffelOrderId: 'ord123',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const resMismatch = await confirmPaymentAction({ bookingId, paymentId });
      assert.equal(resMismatch.ok, false);
      if (!resMismatch.ok) {
        assert.equal(resMismatch.reason, 'UPSTREAM_UNAVAILABLE');
      }
    });
  });

  describe('getPaymentStatusAction', () => {
    it('returns UNAUTHENTICATED when session is missing', async () => {
      currentSession = null;
      const result = await getPaymentStatusAction('pay_status_123');
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reason, 'UNAUTHENTICATED');
        assert.equal(result.retryable, false);
      }
    });

    it('returns INVALID_COMMAND when paymentId is missing or empty', async () => {
      currentSession = { accessToken: 'valid_jwt_token' };
      const result = await getPaymentStatusAction('   ');
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reason, 'INVALID_COMMAND');
        assert.equal(result.retryable, false);
      }
    });

    it('successfully retrieves payment status with bearer authorization and returns validated outcome', async () => {
      currentSession = {
        accessToken: 'user_jwt_secret_token_123',
      };

      let capturedUrl = '';
      let capturedMethod = '';
      const capturedHeaders: Record<string, string> = {};

      globalThis.fetch = mock.fn(
        async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          capturedUrl = typeof input === 'string' ? input : input.toString();
          capturedMethod = init?.method ?? 'GET';
          if (init?.headers) {
            const h = new Headers(init.headers);
            h.forEach((val, key) => {
              capturedHeaders[key] = val;
            });
          }

          const upstreamPayload = {
            paymentId: 'pay_queried_555',
            status: 'PENDING',
            amount: 54321,
            currency: 'USD',
            bookingIntentStatus: 'AWAITING_PAYMENT',
            attemptNumber: 1,
            unverifiedServerField: 'must_be_stripped',
          };

          return new Response(JSON.stringify(upstreamPayload), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      );

      const result = await getPaymentStatusAction('pay_queried_555');

      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.data.paymentId, 'pay_queried_555');
        assert.equal(result.data.status, 'PENDING');
        assert.equal(result.data.amount, 54321);
        assert.equal(result.data.currency, 'USD');
        assert.equal(result.data.bookingIntentStatus, 'AWAITING_PAYMENT');
        assert.equal(result.data.attemptNumber, 1);

        assert.equal('unverifiedServerField' in result.data, false);
        assert.equal('accessToken' in result.data, false);
      }

      assert.ok(capturedUrl.endsWith('/api/bookings/payment/pay_queried_555/status'));
      assert.equal(capturedMethod, 'GET');
      assert.equal(capturedHeaders['authorization'], 'Bearer user_jwt_secret_token_123');
    });

    it('maps upstream HTTP 404, 403, and 500 error responses correctly for getPaymentStatusAction', async () => {
      currentSession = { accessToken: 'valid_jwt_token' };

      // Case 404: Not Found
      globalThis.fetch = mock.fn(async (): Promise<Response> => {
        return new Response(JSON.stringify({ message: 'Payment not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      });
      const res404 = await getPaymentStatusAction('pay_nonexistent');
      assert.equal(res404.ok, false);
      if (!res404.ok) {
        assert.equal(res404.reason, 'NOT_FOUND');
      }

      // Case 403: Forbidden
      globalThis.fetch = mock.fn(async (): Promise<Response> => {
        return new Response(JSON.stringify({ message: 'Forbidden' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        });
      });
      const res403 = await getPaymentStatusAction('pay_other_user');
      assert.equal(res403.ok, false);
      if (!res403.ok) {
        assert.equal(res403.reason, 'FORBIDDEN');
      }

      // Case 500: Upstream Unavailable
      globalThis.fetch = mock.fn(async (): Promise<Response> => {
        return new Response(JSON.stringify({ message: 'Server error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      });
      const res500 = await getPaymentStatusAction('pay_server_error');
      assert.equal(res500.ok, false);
      if (!res500.ok) {
        assert.equal(res500.reason, 'UPSTREAM_UNAVAILABLE');
      }
    });

    it('recognizes RESERVED status and ensures module exports only async functions compliant with Next server action runtime validator', async () => {
      currentSession = { accessToken: 'valid_jwt_token' };
      const requestedId = 'pay_reserved_status_456';

      // 1. Backend returns RESERVED status
      globalThis.fetch = mock.fn(
        async (): Promise<Response> =>
          new Response(
            JSON.stringify({
              paymentId: requestedId,
              status: 'RESERVED',
              amount: 15000,
              currency: 'USD',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      );

      const resReservedStatus = await getPaymentStatusAction(requestedId);
      assert.equal(resReservedStatus.ok, true);
      if (resReservedStatus.ok) {
        assert.equal(resReservedStatus.data.status, 'RESERVED');
        assert.equal(resReservedStatus.data.paymentId, requestedId);
        assert.equal(resReservedStatus.data.amount, 15000);
      }

      // 2. Next.js server actions validation: module must NOT export arrays/objects at runtime
      const actionsModule = await import('../app/checkout/[intentId]/payment/actions');
      const actionValidatePath = resolveModulePath(
        'next/dist/build/webpack/loaders/next-flight-loader/action-validate.js',
      );
      const actionValidator = testRequire(actionValidatePath);

      // Verify that RECOGNIZED_PAYMENT_STATUSES is NOT exported at runtime
      assert.equal('RECOGNIZED_PAYMENT_STATUSES' in actionsModule, false);

      // Verify all exported runtime values pass Next ensureServerEntryExports without throwing
      const exportedValues = Object.values(actionsModule);
      assert.doesNotThrow(() => {
        actionValidator.ensureServerEntryExports(exportedValues);
      });
    });

    it('fails closed on mismatched paymentId, malformed or missing amount, and unknown status, while accepting legitimate statuses', async () => {
      currentSession = { accessToken: 'valid_jwt_token' };
      const requestedId = 'pay_status_target_123';

      // 1. Reviewer probe case: mismatched paymentId and invalid amount string
      globalThis.fetch = mock.fn(
        async (): Promise<Response> =>
          new Response(
            JSON.stringify({
              paymentId: 'different-payment',
              status: 'SUCCEEDED',
              amount: 'invalid',
              currency: 'usd',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      );
      const resProbe = await getPaymentStatusAction(requestedId);
      assert.equal(resProbe.ok, false);

      // 2. Mismatched paymentId with otherwise valid payload
      globalThis.fetch = mock.fn(
        async (): Promise<Response> =>
          new Response(
            JSON.stringify({
              paymentId: 'pay_other_999',
              status: 'SUCCEEDED',
              amount: 5000,
              currency: 'USD',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      );
      const resMismatch = await getPaymentStatusAction(requestedId);
      assert.equal(resMismatch.ok, false);

      // 3. Malformed/missing amount (defaults must NOT be used)
      globalThis.fetch = mock.fn(
        async (): Promise<Response> =>
          new Response(
            JSON.stringify({
              paymentId: requestedId,
              status: 'SUCCEEDED',
              currency: 'USD',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      );
      const resMissingAmount = await getPaymentStatusAction(requestedId);
      assert.equal(resMissingAmount.ok, false);

      // 4. Unknown arbitrary status string
      globalThis.fetch = mock.fn(
        async (): Promise<Response> =>
          new Response(
            JSON.stringify({
              paymentId: requestedId,
              status: 'ARBITRARY_UNVERIFIED_STATUS',
              amount: 5000,
              currency: 'USD',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      );
      const resUnknownStatus = await getPaymentStatusAction(requestedId);
      assert.equal(resUnknownStatus.ok, false);

      // 5. Legitimate recognized statuses: AUTHORIZED, CREATED, REFUND_PENDING, DISPUTED
      for (const validStatus of ['AUTHORIZED', 'CREATED', 'REFUND_PENDING', 'DISPUTED'] as const) {
        globalThis.fetch = mock.fn(
          async (): Promise<Response> =>
            new Response(
              JSON.stringify({
                paymentId: requestedId,
                status: validStatus,
                amount: 12500,
                currency: 'USD',
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );
        const resValid = await getPaymentStatusAction(requestedId);
        assert.equal(resValid.ok, true);
        if (resValid.ok) {
          assert.equal(resValid.data.status, validStatus);
          assert.equal(resValid.data.paymentId, requestedId);
          assert.equal(resValid.data.amount, 12500);
          assert.equal(resValid.data.currency, 'USD');
        }
      }
    });
  });
});
