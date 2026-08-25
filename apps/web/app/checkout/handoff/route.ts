import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { isSameOrigin } from '@/lib/checkoutHandoffOrigin';
import { readHandoffCredential } from '@/lib/handoffCredential';
import {
  createHandoffRedirectResponse,
  hasCheckoutHandoffContext,
  resolveHandoffForBootstrap,
} from '@/lib/handoffBootstrap';

type AuthenticatedSession = {
  accessToken: string;
};

function getAuthenticatedSession(session: unknown): AuthenticatedSession | null {
  if (typeof session !== 'object' || session === null) {
    return null;
  }

  if ('accessToken' in session
    && typeof session.accessToken === 'string'
    && session.accessToken.length > 0) {
    return { accessToken: session.accessToken };
  }

  return null;
}

function hasValidSameOriginHeaders(request: Request): boolean {
  const boundaryValues = [request.headers.get('origin'), request.headers.get('referer')]
    .filter((value): value is string => value !== null && value !== 'null');
  const configuredOrigin = process.env.NEXTAUTH_URL;
  let expectedOrigin = request.url;
  if (configuredOrigin) {
    try {
      expectedOrigin = new URL(configuredOrigin).origin;
    } catch {
      expectedOrigin = request.url;
    }
  }

  if (boundaryValues.length > 0) {
    return boundaryValues.every((value) => isSameOrigin(expectedOrigin, value));
  }

  return request.headers.get('sec-fetch-site') === 'same-origin';
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!hasValidSameOriginHeaders(request)) {
    return new NextResponse('Forbidden', {
      status: 403,
      headers: { 'Cache-Control': 'no-store, private' },
    });
  }

  const handoffToken = await readHandoffCredential(request);
  if (handoffToken === null) {
    return new NextResponse('Bad Request', {
      status: 400,
      headers: { 'Cache-Control': 'no-store, private' },
    });
  }

  const session = await getServerSession(authOptions);
  const authenticatedSession = getAuthenticatedSession(session);
  if (authenticatedSession === null) {
    return new NextResponse('Unauthorized', {
      status: 401,
      headers: { 'Cache-Control': 'no-store, private' },
    });
  }

  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  if (!apiUrl) {
    return new NextResponse('Handoff unavailable', {
      status: 503,
      headers: { 'Cache-Control': 'no-store, private' },
    });
  }

  const cookieHeader = request.headers.get('cookie') ?? '';
  const mockScenarioMatch = cookieHeader.match(/mock-scenario=([^;]+)/);
  const mockScenario = mockScenarioMatch ? mockScenarioMatch[1].trim() : null;

  const resolution = await resolveHandoffForBootstrap(
    apiUrl,
    handoffToken,
    authenticatedSession.accessToken,
    request.headers.get('x-trace-id') ?? undefined,
    request.headers.get('x-correlation-id') ?? undefined,
    fetch,
    undefined,
    mockScenario,
  );
  if (!hasCheckoutHandoffContext(resolution)) {
    const safeStatus = [400, 401, 403, 404, 409, 410, 503].includes(resolution.status)
      ? resolution.status
      : 502;
    return new NextResponse('Handoff unavailable', {
      status: safeStatus,
      headers: { 'Cache-Control': 'no-store, private' },
    });
  }

  const originHeader = request.headers.get('origin') || request.headers.get('referer');
  const redirectTarget = originHeader && !originHeader.includes('null')
    ? new URL('/checkout/passengers', originHeader).toString()
    : request.url;

  return createHandoffRedirectResponse(redirectTarget, handoffToken);
}
