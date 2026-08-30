import { getServerSession } from 'next-auth';
import { cookies } from 'next/headers';
import { authOptions } from '@/lib/auth';
import { isSafeHandoffCheckoutPayload } from '@/lib/handoffCheckoutPayload';
import { expiredHandoffCookieHeader, HANDOFF_COOKIE_NAME } from '@/lib/handoffCookie';
import { safeHandoffCheckoutOrigin, safeHandoffTraceHeaders } from '@/lib/handoffCheckoutRequest';

const TIMEOUT_MS = 10_000;

export async function proxyHandoffCheckout(
  request: Request,
  pathname: '/api/bookings/intents/readiness' | '/api/bookings/intents',
): Promise<Response> {
  if (!safeHandoffCheckoutOrigin(request)) {
    return new Response(JSON.stringify({ error: 'Checkout unavailable' }), {
      status: 403,
      headers: noStoreJson(),
    });
  }
  const session = (await getServerSession(authOptions)) as { accessToken?: unknown } | null;
  const handoffToken = cookies().get(HANDOFF_COOKIE_NAME)?.value;
  if (!session || typeof session.accessToken !== 'string' || !handoffToken) {
    return new Response(JSON.stringify({ error: 'Checkout unavailable' }), {
      status: 401,
      headers: noStoreJson(),
    });
  }
  const body: unknown = await request.json().catch(() => null);
  if (!isSafeHandoffCheckoutPayload(body, pathname)) {
    return new Response(JSON.stringify({ error: 'Invalid checkout request' }), {
      status: 400,
      headers: noStoreJson(),
    });
  }
  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  if (!apiUrl)
    return new Response(JSON.stringify({ error: 'Checkout unavailable' }), {
      status: 503,
      headers: noStoreJson(),
    });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const upstream = await fetch(new URL(pathname, apiUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        'Content-Type': 'application/json',
        ...safeHandoffTraceHeaders(request.headers),
      },
      body: JSON.stringify({ ...body, handoffToken }),
      cache: 'no-store',
      signal: controller.signal,
    });
    const response = new Response(await upstream.text(), {
      status: upstream.status,
      headers: noStoreJson(),
    });
    if (pathname === '/api/bookings/intents' && upstream.status === 201) {
      response.headers.append('Set-Cookie', expiredHandoffCookieHeader());
    }
    return response;
  } catch {
    return new Response(JSON.stringify({ error: 'Checkout unavailable' }), {
      status: 503,
      headers: noStoreJson(),
    });
  } finally {
    clearTimeout(timeout);
  }
}

function noStoreJson(): HeadersInit {
  return { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, private' };
}
