import { getProfileRequestError } from './profile-contract';
import type { TravelerProfileResponse, UpdateProfilePayload } from './profile-contract';

export { ProfileRequestError } from './profile-contract';
export type {
  ProfileContactUpdate,
  ProfileDocumentUpdate,
  ProfileIdentityUpdate,
  ProfilePreferencesUpdate,
  TravelerProfileResponse,
  UpdateProfilePayload,
} from './profile-contract';

function getApiUrl(): string {
  const apiUrl = process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
  return apiUrl.trim().replace(/\/+$/, '');
}

type ResponseRecord = Record<string, unknown>;

function isResponseRecord(value: unknown): value is ResponseRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTravelerProfileResponse(value: unknown): value is TravelerProfileResponse {
  return (
    isResponseRecord(value) && (typeof value.profileId === 'string' || value.profileId === null)
  );
}

function parseTravelerProfileResponse(value: unknown): TravelerProfileResponse {
  if (!isTravelerProfileResponse(value)) {
    throw new Error('Invalid traveler profile response.');
  }

  return value;
}

async function requestProfile(
  accessToken: string,
  init: RequestInit,
): Promise<TravelerProfileResponse> {
  const response = await fetch(`${getApiUrl()}/api/profile`, {
    ...init,
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Cache-Control': 'no-store, private',
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw await getProfileRequestError(response);
  }

  return parseTravelerProfileResponse(await response.json());
}

export function fetchProfile(accessToken: string): Promise<TravelerProfileResponse> {
  return requestProfile(accessToken, {
    method: 'GET',
  });
}

export const getTravelerProfile = fetchProfile;

export function updateProfile(
  accessToken: string,
  payload: UpdateProfilePayload,
): Promise<TravelerProfileResponse> {
  return requestProfile(accessToken, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

export const updateTravelerProfile = updateProfile;

export async function fetchProfileCabinPreference(
  sessionOrToken?: unknown,
): Promise<string | null> {
  try {
    let token: string | null = null;
    if (typeof sessionOrToken === 'string' && sessionOrToken.length > 0) {
      token = sessionOrToken;
    } else if (
      sessionOrToken &&
      typeof sessionOrToken === 'object' &&
      'accessToken' in sessionOrToken
    ) {
      // Type assertion safe after checking 'accessToken' property presence on session object
      const candidate = (sessionOrToken as { accessToken?: unknown }).accessToken;
      if (typeof candidate === 'string' && candidate.length > 0) {
        token = candidate;
      }
    } else if (sessionOrToken === undefined) {
      const { getServerSession } = await import('next-auth');
      const { authOptions } = await import('./auth');
      const session = await getServerSession(authOptions);
      if (session && typeof session === 'object' && 'accessToken' in session) {
        // Type assertion safe after verifying NextAuth session has accessToken property
        const candidate = (session as { accessToken?: unknown }).accessToken;
        if (typeof candidate === 'string' && candidate.length > 0) {
          token = candidate;
        }
      }
    }

    if (!token) return null;
    const profile = await fetchProfile(token);
    return profile?.preferences?.classPreference ?? null;
  } catch {
    return null;
  }
}
