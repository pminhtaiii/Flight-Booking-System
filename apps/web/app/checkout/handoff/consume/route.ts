import { NextResponse, NextRequest } from 'next/server';

export async function GET(request: NextRequest) {
  const offerId = request.nextUrl.searchParams.get('offerId');
  const targetUrl = new URL('/checkout/passengers', request.url);
  if (offerId) {
    targetUrl.searchParams.set('offerId', offerId);
  }
  const response = NextResponse.redirect(targetUrl);
  response.cookies.delete('chat_handoff_token');
  return response;
}
