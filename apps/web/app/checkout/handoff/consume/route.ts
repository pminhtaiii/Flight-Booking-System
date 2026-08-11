import { NextResponse, NextRequest } from 'next/server';

export async function GET(request: NextRequest) {
  const offerId = request.nextUrl.searchParams.get('offerId');
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || 'localhost:3000';
  const protocol = request.headers.get('x-forwarded-proto') || 'http';
  const targetUrl = new URL(`${protocol}://${host}/checkout/passengers`);
  if (offerId) {
    targetUrl.searchParams.set('offerId', offerId);
  }
  const response = NextResponse.redirect(targetUrl);
  response.cookies.delete('chat_handoff_token');
  return response;
}
