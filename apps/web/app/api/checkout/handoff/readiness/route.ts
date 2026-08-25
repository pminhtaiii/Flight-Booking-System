import { proxyHandoffCheckout } from '@/lib/handoffCheckoutProxy';

export async function POST(request: Request): Promise<Response> {
  return proxyHandoffCheckout(request, '/api/bookings/intents/readiness');
}
