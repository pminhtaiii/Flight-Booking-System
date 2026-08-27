import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

function getApiUrl(): string {
  const rawUrl = process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:3001';
  const trimmed = rawUrl.replace(/\/+$/, '');
  return trimmed.replace(/\/api$/, '');
}

function degradedResponse(): NextResponse {
  return NextResponse.json(
    { status: 'degraded', upstream: 'down' },
    { status: 503, headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function GET(): Promise<NextResponse> {
  const apiUrl = getApiUrl();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);

  try {
    const response = await fetch(`${apiUrl}/api/health/ping`, {
      signal: controller.signal,
    });

    if (!response.ok) {
      return degradedResponse();
    }

    // Safely narrow unknown JSON payload without unsafe casting
    const rawJson: unknown = await response.json();
    if (
      rawJson &&
      typeof rawJson === 'object' &&
      !Array.isArray(rawJson) &&
      (rawJson as Record<string, unknown>).status === 'ok'
    ) {
      return NextResponse.json(
        { status: 'ok', upstream: 'up' },
        { status: 200, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    return degradedResponse();
  } catch {
    return degradedResponse();
  } finally {
    clearTimeout(timeoutId);
  }
}
