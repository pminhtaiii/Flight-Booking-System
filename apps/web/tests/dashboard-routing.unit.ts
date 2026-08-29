import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, beforeEach, describe, it, mock } from 'node:test';
import React from 'react';
import type { DashboardOutcome } from '@shared/types';

// Ensure React is available globally for JSX execution in Node environment
(globalThis as unknown as { React: typeof React }).React = React;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const testRequire = createRequire(import.meta.url);

// Mock CSS and stylesheet imports for Node.js test environment
const cssHandler = (module: NodeModule): void => {
  module.exports = new Proxy(
    {},
    { get: (_target: unknown, prop: string | symbol): string => String(prop) },
  );
};
require.extensions['.css'] = cssHandler;
require.extensions['.scss'] = cssHandler;

type TestSession = {
  accessToken?: string;
  user?: { id: string; email: string; name?: string };
} | null;

let session: TestSession = null;
const getServerSession = mock.fn(async (): Promise<TestSession> => session);

const createRedirectError = (url: string): Error & { digest: string } => {
  // Cast needed to attach Next.js internal digest marker to standard Error object
  const error = new Error('NEXT_REDIRECT: ' + url) as Error & { digest: string };
  error.digest = 'NEXT_REDIRECT;' + url;
  return error;
};

const redirect = mock.fn((url: string): never => {
  throw createRedirectError(url);
});

const defaultPopulatedOutcome: DashboardOutcome = {
  ok: true,
  data: {
    stats: {
      totalBookings: 1,
      upcomingBookings: 1,
      completedBookings: 0,
      cancelledBookings: 0,
    },
    recentBookings: [],
    generatedAt: '2026-08-29T00:00:00.000Z',
  },
};

let summaryOutcome: DashboardOutcome = defaultPopulatedOutcome;

const getDashboardSummary = mock.fn(async (): Promise<DashboardOutcome> => summaryOutcome);

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
// Cast needed because testRequire.cache expects NodeModule structure
testRequire.cache[nextAuthPath] = {
  exports: { getServerSession, default: { getServerSession } },
} as NodeModule;

try {
  const credentialsPath = resolvePath('next-auth/providers/credentials');
  // Cast needed because testRequire.cache expects NodeModule structure
  testRequire.cache[credentialsPath] = {
    exports: {
      default: (): { id: string; name: string } => ({ id: 'credentials', name: 'Credentials' }),
    },
  } as NodeModule;
} catch {
  // Module resolution fallback if credentials provider is already bundled
}

const nextNavigationPath = resolvePath('next/navigation');
const originalNextNavigationModule = testRequire.cache[nextNavigationPath];
// Cast needed because testRequire.cache expects NodeModule structure
testRequire.cache[nextNavigationPath] = {
  exports: { redirect, default: { redirect } },
} as NodeModule;

const serverOnlyPath = resolvePath('server-only');
const originalServerOnlyModule = testRequire.cache[serverOnlyPath];
// Cast needed because testRequire.cache expects NodeModule structure
testRequire.cache[serverOnlyPath] = { exports: {} } as NodeModule;

const dashboardLibPath = path.resolve(__dirname, '../lib/server/dashboard.ts');
const originalDashboardModule = testRequire.cache[dashboardLibPath];
// Cast needed because testRequire.cache expects NodeModule structure
testRequire.cache[dashboardLibPath] = {
  exports: { getDashboardSummary, default: { getDashboardSummary } },
} as NodeModule;

after(() => {
  if (originalNextAuthModule) {
    testRequire.cache[nextAuthPath] = originalNextAuthModule;
  } else {
    delete testRequire.cache[nextAuthPath];
  }

  if (originalNextNavigationModule) {
    testRequire.cache[nextNavigationPath] = originalNextNavigationModule;
  } else {
    delete testRequire.cache[nextNavigationPath];
  }

  if (originalServerOnlyModule) {
    testRequire.cache[serverOnlyPath] = originalServerOnlyModule;
  } else {
    delete testRequire.cache[serverOnlyPath];
  }

  if (originalDashboardModule) {
    testRequire.cache[dashboardLibPath] = originalDashboardModule;
  } else {
    delete testRequire.cache[dashboardLibPath];
  }
});

let IndexPage: () => Promise<unknown> | unknown;
let DashboardPage: () => Promise<unknown>;

beforeEach(async () => {
  session = null;
  getServerSession.mock.resetCalls();
  redirect.mock.resetCalls();
  getDashboardSummary.mock.resetCalls();

  summaryOutcome = defaultPopulatedOutcome;

  if (!IndexPage) {
    const pageModule = await import('../app/page.tsx');
    IndexPage = pageModule.default;
  }
  if (!DashboardPage) {
    const dashboardModule = await import('../app/dashboard/page.tsx');
    DashboardPage = dashboardModule.default;
  }
});

describe('Root Page Routing (apps/web/app/page.tsx)', () => {
  it('redirects authenticated user with active session to /dashboard', async () => {
    session = { user: { id: 'test-user', email: 'test@example.com' } };

    await assert.rejects(
      async () => {
        await IndexPage();
      },
      (err: unknown): boolean => {
        // Cast needed to assert standard Next.js redirect exception contract
        const error = err as Error & { digest?: string };
        assert.match(error.message, /NEXT_REDIRECT:\s*\/dashboard/);
        return true;
      },
    );

    assert.equal(redirect.mock.calls.length, 1);
    assert.equal(redirect.mock.calls[0].arguments[0], '/dashboard');
  });

  it('renders landing page when session is null without redirecting', async () => {
    session = null;

    const result = await IndexPage();

    assert.equal(redirect.mock.calls.length, 0);
    assert.ok(result, 'Expected LandingPage component element to be returned');
  });
});

describe('Dashboard Page Routing & Access Control (apps/web/app/dashboard/page.tsx)', () => {
  it('redirects unauthenticated user to /login?callbackUrl=/dashboard when summary returns UNAUTHENTICATED', async () => {
    summaryOutcome = {
      ok: false,
      reason: 'UNAUTHENTICATED',
      message: 'Authentication required. Please log in.',
      retryable: false,
    };

    await assert.rejects(
      async () => {
        await DashboardPage();
      },
      (err: unknown): boolean => {
        // Cast needed to assert standard Next.js redirect exception contract
        const error = err as Error & { digest?: string };
        assert.match(error.message, /NEXT_REDIRECT:\s*\/login\?callbackUrl=\/dashboard/);
        return true;
      },
    );

    assert.equal(redirect.mock.calls.length, 1);
    assert.equal(redirect.mock.calls[0].arguments[0], '/login?callbackUrl=/dashboard');
  });

  it('throws non-masked Error("Unable to load dashboard.") when summary returns UPSTREAM_UNAVAILABLE', async () => {
    summaryOutcome = {
      ok: false,
      reason: 'UPSTREAM_UNAVAILABLE',
      message: 'The dashboard service is temporarily unavailable.',
      retryable: true,
    };

    await assert.rejects(
      async () => {
        await DashboardPage();
      },
      {
        name: 'Error',
        message: 'Unable to load dashboard.',
      },
    );

    assert.equal(redirect.mock.calls.length, 0);
  });

  it('throws non-masked Error("Unable to load dashboard.") when summary returns INVALID_RESPONSE', async () => {
    summaryOutcome = {
      ok: false,
      reason: 'INVALID_RESPONSE',
      message: 'Unable to load dashboard data due to an unexpected format.',
      retryable: false,
    };

    await assert.rejects(
      async () => {
        await DashboardPage();
      },
      {
        name: 'Error',
        message: 'Unable to load dashboard.',
      },
    );

    assert.equal(redirect.mock.calls.length, 0);
  });

  it('renders DashboardShell without redirect when summary returns ok: true', async () => {
    session = { user: { id: 'test-user', email: 'test@example.com', name: 'Test User' } };
    summaryOutcome = defaultPopulatedOutcome;

    const result = await DashboardPage();

    assert.equal(redirect.mock.calls.length, 0);
    assert.ok(result, 'Expected DashboardShell component element to be returned');
  });
});
