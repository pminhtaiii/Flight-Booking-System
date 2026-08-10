import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';

const CURRENT_GENERATOR_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const VERSIONED_HANDOFF_TOKEN = /^chk_handoff_v1_[A-Za-z0-9_-]{1,128}$/;

type SessionWithAccessToken = {
  accessToken?: unknown;
};

function isValidHandoffCredential(value: string): boolean {
  return CURRENT_GENERATOR_TOKEN.test(value) || VERSIONED_HANDOFF_TOKEN.test(value);
}

function hasAuthenticatedSession(session: unknown): boolean {
  if (typeof session !== 'object' || session === null) {
    return false;
  }

  const accessToken = (session as SessionWithAccessToken).accessToken;
  return typeof accessToken === 'string' && accessToken.length > 0;
}

function isSameOrigin(request: Request, candidate: string): boolean {
  try {
    return new URL(candidate).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function hasValidSameOriginHeaders(request: Request): boolean {
  const boundaryValues = [request.headers.get('origin'), request.headers.get('referer')]
    .filter((value): value is string => value !== null);

  return boundaryValues.length > 0 && boundaryValues.every((value) => isSameOrigin(request, value));
}

export async function POST(request: Request): Promise<NextResponse> {
  const session = await getServerSession(authOptions);
  if (!hasAuthenticatedSession(session)) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  if (!hasValidSameOriginHeaders(request)) {
    return new NextResponse('Forbidden', { status: 403 });
  }

  const formData = await request.formData();
  const formEntries = Array.from(formData.entries());
  if (formEntries.length !== 1 || formEntries[0][0] !== 'handoffToken') {
    return new NextResponse('Bad Request', { status: 400 });
  }

  const handoffToken = formData.get('handoffToken');

  if (!handoffToken || typeof handoffToken !== 'string' || !isValidHandoffCredential(handoffToken)) {
    return new NextResponse('Bad Request', { status: 400 });
  }

  const response = NextResponse.redirect(new URL('/checkout/passengers', request.url), 303);

  response.cookies.set('chat_handoff_token', handoffToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    maxAge: 15 * 60,
    path: '/',
  });

  return response;
}
