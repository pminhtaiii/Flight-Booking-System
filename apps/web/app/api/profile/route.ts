import { getServerSession } from 'next-auth';
import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';
import { isBookingReadinessEnabled } from '@/lib/featureFlags';
import {
  fetchProfile,
  ProfileRequestError,
  type UpdateProfilePayload,
  updateProfile,
} from '@/lib/profile';

function jsonError(status: number, message: string, code: string | null = null): NextResponse {
  return NextResponse.json({ message, ...(code ? { code } : {}) }, { status });
}

async function getAccessToken(): Promise<string | null> {
  const session = await getServerSession(authOptions);
  return (session as { accessToken?: string } | null)?.accessToken ?? null;
}

function mapProfileError(error: unknown): NextResponse {
  if (error instanceof ProfileRequestError) {
    return jsonError(error.status, error.message, error.code);
  }

  return jsonError(502, 'The profile service is temporarily unavailable.');
}

export async function GET(): Promise<NextResponse> {
  if (!isBookingReadinessEnabled()) {
    return jsonError(404, 'FEATURE_DISABLED', 'FEATURE_DISABLED');
  }

  const accessToken = await getAccessToken();

  if (!accessToken) {
    return jsonError(401, 'Authentication required.');
  }

  try {
    const profile = await fetchProfile(accessToken);
    return NextResponse.json(profile, {
      headers: { 'Cache-Control': 'no-store, private' },
    });
  } catch (error: unknown) {
    return mapProfileError(error);
  }
}

export async function PATCH(request: Request): Promise<NextResponse> {
  if (!isBookingReadinessEnabled()) {
    return jsonError(404, 'FEATURE_DISABLED', 'FEATURE_DISABLED');
  }

  const accessToken = await getAccessToken();

  if (!accessToken) {
    return jsonError(401, 'Authentication required.');
  }

  try {
    const payload = (await request.json()) as UpdateProfilePayload;
    const profile = await updateProfile(accessToken, payload);
    return NextResponse.json(profile, {
      headers: { 'Cache-Control': 'no-store, private' },
    });
  } catch (error: unknown) {
    return mapProfileError(error);
  }
}
