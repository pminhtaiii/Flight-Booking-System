import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const offerId = url.searchParams.get('offerId');
  
  // Redirect back to passengers page with the resolved offerId
  const response = NextResponse.redirect(new URL(`/checkout/passengers?offerId=${offerId || ''}`, request.url));
  
  // Clear the handoff cookie so it doesn't override subsequent navigations
  response.cookies.delete('chat_handoff_token');
  
  return response;
}
