import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import type { DashboardOutcome, DashboardSummary } from '@shared/types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const testRequire = createRequire(import.meta.url);
type TestSession = { accessToken?: string; user?: { id: string; email: string } } | null;

let session: TestSession = null;
const getServerSession = mock.fn(async () => session);
const resolvePath = (specifier: string): string => {
  try {
    return testRequire.resolve(specifier);
  } catch {
    return require.resolve(specifier, {
      paths: [
        path.resolve(__dirname, '../../node_modules'),
        path.resolve(process.cwd(), 'apps/web/node_modules'),
        path.resolve(process.cwd(), 'node_modules'),
      ],
    });
  }
};

const nextAuthPath = resolvePath('next-auth');
const originalNextAuthModule = testRequire.cache[nextAuthPath];
testRequire.cache[nextAuthPath] = {
  exports: { getServerSession, default: { getServerSession } },
} as NodeModule;
const serverOnlyPath = resolvePath('server-only');
const originalServerOnlyModule = testRequire.cache[serverOnlyPath];
testRequire.cache[serverOnlyPath] = { exports: {} } as NodeModule;

after(() => {
  if (originalNextAuthModule) {
    testRequire.cache[nextAuthPath] = originalNextAuthModule;
  } else {
    delete testRequire.cache[nextAuthPath];
  }

  if (originalServerOnlyModule) {
    testRequire.cache[serverOnlyPath] = originalServerOnlyModule;
    return;
  }

  delete testRequire.cache[serverOnlyPath];
});

let getDashboardSummary: () => Promise<DashboardOutcome>;

before(async () => {
  ({ getDashboardSummary } = await import('./dashboard.ts'));
});

const mockValidSummary: DashboardSummary = {
  stats: {
    totalBookings: 12,
    upcomingBookings: 3,
    completedBookings: 8,
    cancelledBookings: 1,
  },
  recentBookings: [
    {
      id: '8a7466ab-78bd-4a45-8e9e-9b3c62269a91',
      status: 'CONFIRMED',
      createdAt: '2026-08-20T10:00:00.000Z',
      departureAt: '2026-09-01T08:00:00.000Z',
      originCode: 'SGN',
      destinationCode: 'HAN',
      airlineCode: 'VN',
      flightNumber: 'VN123',
    },
    {
      id: '8a7466ab-78bd-4a45-8e9e-9b3c62269a92',
      status: 'COMPLETED',
      createdAt: '2026-07-15T12:00:00.000Z',
      departureAt: '2026-08-01T14:30:00.000Z',
      originCode: 'LHR',
      destinationCode: 'JFK',
      airlineCode: 'BA',
      flightNumber: 'BA178',
    },
    {
      id: '8a7466ab-78bd-4a45-8e9e-9b3c62269a93',
      status: 'CANCELLED_AND_REFUNDED',
      createdAt: '2026-06-10T09:00:00.000Z',
      departureAt: '2026-07-01T11:00:00.000Z',
      originCode: 'NRT',
      destinationCode: 'SIN',
      airlineCode: 'SQ',
      flightNumber: 'SQ637',
    },
    {
      id: '8a7466ab-78bd-4a45-8e9e-9b3c62269a94',
      status: 'PROCESSING',
      createdAt: '2026-08-28T16:00:00.000Z',
      departureAt: '2026-09-10T19:00:00.000Z',
      originCode: 'SYD',
      destinationCode: 'MEL',
      airlineCode: 'QF',
      flightNumber: 'QF401',
    },
    {
      id: '8a7466ab-78bd-4a45-8e9e-9b3c62269a95',
      status: 'CONFIRMED',
      createdAt: '2026-08-25T08:30:00.000Z',
      departureAt: '2026-09-15T06:00:00.000Z',
      originCode: 'CDG',
      destinationCode: 'DXB',
      airlineCode: 'EK',
      flightNumber: 'EK074',
    },
  ],
  generatedAt: '2026-08-29T08:00:00.000Z',
};

describe('dashboard server loader (getDashboardSummary)', () => {
  const originalEnvironment = process.env;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env = { ...originalEnvironment, API_URL: 'http://private-api.example/' };
    session = { accessToken: 'session-token-secret-123' };
    getServerSession.mock.resetCalls();
  });

  afterEach(() => {
    process.env = originalEnvironment;
    globalThis.fetch = originalFetch;
    session = null;
  });

  describe('1. Unauthenticated Session', () => {
    it('returns UNAUTHENTICATED outcome when session is null without calling upstream fetch', async () => {
      session = null;
      let fetchCalled = false;
      globalThis.fetch = async (): Promise<Response> => {
        fetchCalled = true;
        return new Response();
      };

      const outcome = await getDashboardSummary();

      assert.deepEqual(outcome, {
        ok: false,
        reason: 'UNAUTHENTICATED',
        message: 'Authentication required. Please log in.',
        retryable: false,
      });
      assert.strictEqual(fetchCalled, false);
      assert.strictEqual(getServerSession.mock.calls.length, 1);
    });

    it('returns UNAUTHENTICATED outcome when session has no accessToken without calling upstream fetch', async () => {
      session = {} as TestSession;
      let fetchCalled = false;
      globalThis.fetch = async (): Promise<Response> => {
        fetchCalled = true;
        return new Response();
      };

      const outcome = await getDashboardSummary();

      assert.deepEqual(outcome, {
        ok: false,
        reason: 'UNAUTHENTICATED',
        message: 'Authentication required. Please log in.',
        retryable: false,
      });
      assert.strictEqual(fetchCalled, false);
    });

    it('returns UNAUTHENTICATED outcome when session accessToken is empty string without calling upstream fetch', async () => {
      session = { accessToken: '' };
      let fetchCalled = false;
      globalThis.fetch = async (): Promise<Response> => {
        fetchCalled = true;
        return new Response();
      };

      const outcome = await getDashboardSummary();

      assert.deepEqual(outcome, {
        ok: false,
        reason: 'UNAUTHENTICATED',
        message: 'Authentication required. Please log in.',
        retryable: false,
      });
      assert.strictEqual(fetchCalled, false);
    });
  });

  describe('2. Bearer Token Forwarding & Dynamic URL Resolution', () => {
    it('forwards Bearer token and dispatches GET to ${API_URL}/api/dashboard/summary with cache: no-store', async () => {
      let requestedUrl = '';
      let requestedInit: RequestInit | undefined;
      globalThis.fetch = async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        requestedUrl = String(input);
        requestedInit = init;
        return new Response(JSON.stringify(mockValidSummary), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const outcome = await getDashboardSummary();

      assert.strictEqual(outcome.ok, true);
      if (outcome.ok) {
        assert.deepEqual(outcome.data, mockValidSummary);
      }
      assert.strictEqual(requestedUrl, 'http://private-api.example/api/dashboard/summary');
      assert.strictEqual(requestedInit?.method, 'GET');
      assert.strictEqual(requestedInit?.cache, 'no-store');
      const authHeader = requestedInit?.headers as HeadersInit & {
        Authorization?: string;
        authorization?: string;
      };
      assert.strictEqual(
        authHeader?.Authorization || authHeader?.authorization,
        'Bearer session-token-secret-123',
      );
    });

    it('correctly trims trailing slash from configured API_URL', async () => {
      process.env.API_URL = 'http://custom-api.internal:8080/';
      let requestedUrl = '';
      globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
        requestedUrl = String(input);
        return new Response(JSON.stringify(mockValidSummary), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const outcome = await getDashboardSummary();

      assert.strictEqual(outcome.ok, true);
      assert.strictEqual(requestedUrl, 'http://custom-api.internal:8080/api/dashboard/summary');
    });

    it('falls back to NEXT_PUBLIC_API_URL when API_URL is unset', async () => {
      delete process.env.API_URL;
      process.env.NEXT_PUBLIC_API_URL = 'http://public-api.internal:9000/';
      let requestedUrl = '';
      globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
        requestedUrl = String(input);
        return new Response(JSON.stringify(mockValidSummary), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const outcome = await getDashboardSummary();

      assert.strictEqual(outcome.ok, true);
      assert.strictEqual(requestedUrl, 'http://public-api.internal:9000/api/dashboard/summary');
    });

    it('falls back to default http://localhost:3001 when neither env var is set', async () => {
      delete process.env.API_URL;
      delete process.env.NEXT_PUBLIC_API_URL;
      let requestedUrl = '';
      globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
        requestedUrl = String(input);
        return new Response(JSON.stringify(mockValidSummary), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const outcome = await getDashboardSummary();

      assert.strictEqual(outcome.ok, true);
      assert.strictEqual(requestedUrl, 'http://localhost:3001/api/dashboard/summary');
    });
  });

  describe('3. Request Timeout Handling', () => {
    it('returns retryable UPSTREAM_UNAVAILABLE failure on request abort / timeout', async () => {
      globalThis.fetch = async (): Promise<Response> => {
        throw new DOMException('The operation was aborted', 'AbortError');
      };

      const outcome = await getDashboardSummary();

      assert.deepEqual(outcome, {
        ok: false,
        reason: 'UPSTREAM_UNAVAILABLE',
        retryable: true,
        message: 'Connection timed out. Please check your network and try again.',
      });
    });
  });

  describe('4. HTTP Status Mapping', () => {
    it('maps HTTP 401 Unauthorized to non-retryable UNAUTHENTICATED failure', async () => {
      globalThis.fetch = async (): Promise<Response> => {
        return new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 });
      };

      const outcome = await getDashboardSummary();

      assert.deepEqual(outcome, {
        ok: false,
        reason: 'UNAUTHENTICATED',
        retryable: false,
        message: 'Your session has expired. Please sign in again.',
      });
    });

    it('maps HTTP 403 Forbidden to non-retryable FORBIDDEN failure', async () => {
      globalThis.fetch = async (): Promise<Response> => {
        return new Response(JSON.stringify({ message: 'Forbidden' }), { status: 403 });
      };

      const outcome = await getDashboardSummary();

      assert.deepEqual(outcome, {
        ok: false,
        reason: 'FORBIDDEN',
        retryable: false,
        message: 'Access denied. You do not have permission to view this resource.',
      });
    });

    it('maps HTTP 500, 502, 503, and 504 server errors to retryable UPSTREAM_UNAVAILABLE failure', async () => {
      for (const status of [500, 502, 503, 504]) {
        globalThis.fetch = async (): Promise<Response> => {
          return new Response(JSON.stringify({ message: 'Internal Server Error' }), { status });
        };

        const outcome = await getDashboardSummary();

        assert.deepEqual(outcome, {
          ok: false,
          reason: 'UPSTREAM_UNAVAILABLE',
          retryable: true,
          message: 'The dashboard service is temporarily unavailable. Please try again.',
        });
      }
    });
  });

  describe('5. Schema Validation & Malformed Payload Handling', () => {
    it('rejects malformed unparseable JSON with INVALID_RESPONSE failure', async () => {
      globalThis.fetch = async (): Promise<Response> => {
        return new Response('{"corrupted_json', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const outcome = await getDashboardSummary();

      assert.deepEqual(outcome, {
        ok: false,
        reason: 'INVALID_RESPONSE',
        retryable: false,
        message: 'Unable to load dashboard data due to an unexpected format.',
      });
    });

    it('rejects response missing stats object with INVALID_RESPONSE failure', async () => {
      const invalid = {
        recentBookings: [],
        generatedAt: '2026-08-29T08:00:00.000Z',
      };
      globalThis.fetch = async (): Promise<Response> => {
        return new Response(JSON.stringify(invalid), { status: 200 });
      };

      const outcome = await getDashboardSummary();

      assert.deepEqual(outcome, {
        ok: false,
        reason: 'INVALID_RESPONSE',
        retryable: false,
        message: 'Unable to load dashboard data due to an unexpected format.',
      });
    });

    it('rejects response with negative stats counts with INVALID_RESPONSE failure', async () => {
      const invalid = {
        stats: {
          totalBookings: -1,
          upcomingBookings: 0,
          completedBookings: 0,
          cancelledBookings: 0,
        },
        recentBookings: [],
        generatedAt: '2026-08-29T08:00:00.000Z',
      };
      globalThis.fetch = async (): Promise<Response> => {
        return new Response(JSON.stringify(invalid), { status: 200 });
      };

      const outcome = await getDashboardSummary();

      assert.deepEqual(outcome, {
        ok: false,
        reason: 'INVALID_RESPONSE',
        retryable: false,
        message: 'Unable to load dashboard data due to an unexpected format.',
      });
    });

    it('rejects response with invalid booking status enum with INVALID_RESPONSE failure', async () => {
      const invalid = {
        ...mockValidSummary,
        recentBookings: [
          {
            ...mockValidSummary.recentBookings[0],
            status: 'UNRECOGNIZED_STATUS_ENUM',
          },
        ],
      };
      globalThis.fetch = async (): Promise<Response> => {
        return new Response(JSON.stringify(invalid), { status: 200 });
      };

      const outcome = await getDashboardSummary();

      assert.deepEqual(outcome, {
        ok: false,
        reason: 'INVALID_RESPONSE',
        retryable: false,
        message: 'Unable to load dashboard data due to an unexpected format.',
      });
    });

    it('rejects response with invalid ISO date format with INVALID_RESPONSE failure', async () => {
      const invalid = {
        ...mockValidSummary,
        generatedAt: 'invalid-non-iso-date',
      };
      globalThis.fetch = async (): Promise<Response> => {
        return new Response(JSON.stringify(invalid), { status: 200 });
      };

      const outcome = await getDashboardSummary();

      assert.deepEqual(outcome, {
        ok: false,
        reason: 'INVALID_RESPONSE',
        retryable: false,
        message: 'Unable to load dashboard data due to an unexpected format.',
      });
    });

    it('rejects response with more than 5 recent bookings with INVALID_RESPONSE failure', async () => {
      const invalid = {
        ...mockValidSummary,
        recentBookings: [
          mockValidSummary.recentBookings[0],
          mockValidSummary.recentBookings[1],
          mockValidSummary.recentBookings[2],
          mockValidSummary.recentBookings[3],
          mockValidSummary.recentBookings[4],
          {
            ...mockValidSummary.recentBookings[0],
            id: '8a7466ab-78bd-4a45-8e9e-9b3c62269a96',
          },
        ],
      };
      globalThis.fetch = async (): Promise<Response> => {
        return new Response(JSON.stringify(invalid), { status: 200 });
      };

      const outcome = await getDashboardSummary();

      assert.deepEqual(outcome, {
        ok: false,
        reason: 'INVALID_RESPONSE',
        retryable: false,
        message: 'Unable to load dashboard data due to an unexpected format.',
      });
    });

    it('rejects response with extra root keys violating .strict() with INVALID_RESPONSE failure', async () => {
      const invalid = {
        ...mockValidSummary,
        leakInternalSecret: 'database_password_123',
      };
      globalThis.fetch = async (): Promise<Response> => {
        return new Response(JSON.stringify(invalid), { status: 200 });
      };

      const outcome = await getDashboardSummary();

      assert.deepEqual(outcome, {
        ok: false,
        reason: 'INVALID_RESPONSE',
        retryable: false,
        message: 'Unable to load dashboard data due to an unexpected format.',
      });
    });

    it('rejects response with extra booking item keys violating .strict() with INVALID_RESPONSE failure', async () => {
      const invalid = {
        ...mockValidSummary,
        recentBookings: [
          {
            ...mockValidSummary.recentBookings[0],
            stripePaymentIntentId: 'pi_secret_12345',
          },
        ],
      };
      globalThis.fetch = async (): Promise<Response> => {
        return new Response(JSON.stringify(invalid), { status: 200 });
      };

      const outcome = await getDashboardSummary();

      assert.deepEqual(outcome, {
        ok: false,
        reason: 'INVALID_RESPONSE',
        retryable: false,
        message: 'Unable to load dashboard data due to an unexpected format.',
      });
    });
  });

  describe('6. Zero Credential / Stack Trace Leakage', () => {
    it('asserts that failure outcome messages contain zero tokens, URLs, DB error details, or stack traces', async () => {
      const failureGenerators: Array<() => Promise<DashboardOutcome>> = [
        // 1. Unauthenticated
        async () => {
          session = null;
          return getDashboardSummary();
        },
        // 2. Timeout
        async () => {
          session = { accessToken: 'session-token-secret-123' };
          globalThis.fetch = async () => {
            throw new DOMException('Aborted', 'AbortError');
          };
          return getDashboardSummary();
        },
        // 3. HTTP 401
        async () => {
          session = { accessToken: 'session-token-secret-123' };
          globalThis.fetch = async () =>
            new Response(
              JSON.stringify({
                message: 'Unauthorized',
                stack: 'Error: Unauthorized at Function.checkAuth',
              }),
              { status: 401 },
            );
          return getDashboardSummary();
        },
        // 4. HTTP 403
        async () => {
          session = { accessToken: 'session-token-secret-123' };
          globalThis.fetch = async () =>
            new Response(
              JSON.stringify({
                message: 'Forbidden',
                dbError: 'PrismaClientKnownRequestError: SELECT * FROM "Booking"',
              }),
              { status: 403 },
            );
          return getDashboardSummary();
        },
        // 5. HTTP 500
        async () => {
          session = { accessToken: 'session-token-secret-123' };
          globalThis.fetch = async () =>
            new Response(
              JSON.stringify({
                message: 'PostgresError: connection terminated unexpectedly',
                url: 'http://private-api.example/api/dashboard/summary',
              }),
              { status: 500 },
            );
          return getDashboardSummary();
        },
        // 6. Malformed schema
        async () => {
          session = { accessToken: 'session-token-secret-123' };
          globalThis.fetch = async () =>
            new Response(JSON.stringify({ unexpected: 'malformed' }), { status: 200 });
          return getDashboardSummary();
        },
      ];

      for (const generator of failureGenerators) {
        const outcome = await generator();
        assert.strictEqual(outcome.ok, false);
        const serialized = JSON.stringify(outcome);

        assert.strictEqual(
          serialized.includes('session-token-secret-123'),
          false,
          'Outcome must not leak bearer token',
        );
        assert.strictEqual(
          serialized.includes('private-api.example'),
          false,
          'Outcome must not leak internal API URL',
        );
        assert.strictEqual(
          serialized.includes('PrismaClientKnownRequestError'),
          false,
          'Outcome must not leak ORM error types',
        );
        assert.strictEqual(
          serialized.includes('SELECT * FROM'),
          false,
          'Outcome must not leak SQL queries',
        );
        assert.strictEqual(
          serialized.includes('PostgresError'),
          false,
          'Outcome must not leak DB errors',
        );
        assert.strictEqual(
          serialized.includes('at Function.'),
          false,
          'Outcome must not leak stack traces',
        );
      }
    });
  });
});
