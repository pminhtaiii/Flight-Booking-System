import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');
  const host = request.headers.get('host');

  // Basic CSRF/origin protection
  if (origin) {
    const originUrl = new URL(origin);
    if (originUrl.host !== host) {
      return new NextResponse('Forbidden', { status: 403 });
    }
  } else if (referer) {
    const refererUrl = new URL(referer);
    if (refererUrl.host !== host) {
      return new NextResponse('Forbidden', { status: 403 });
    }
  }

  const formData = await request.formData();
  const handoffToken = formData.get('handoffToken');

  if (!handoffToken || typeof handoffToken !== 'string') {
    return new NextResponse('Bad Request', { status: 400 });
  }

  // Create redirect response
  const response = NextResponse.redirect(new URL('/checkout/passengers', request.url), 303);

  // Set the short-lived cookie
  response.cookies.set('chat_handoff_token', handoffToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 15 * 60, // 15 minutes
    path: '/',
  });

  return response;
}
