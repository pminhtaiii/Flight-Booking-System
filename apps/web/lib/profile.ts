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
  const apiUrl = process.env.NEXT_PUBLIC_API_URL;

  if (!apiUrl || !apiUrl.trim()) {
    throw new Error('NEXT_PUBLIC_API_URL is required but not configured.');
  }

  return apiUrl.trim().replace(/\/+$/, '');
}

async function requestProfile<T>(accessToken: string, init: RequestInit): Promise<T> {
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

  return (await response.json()) as T;
}

export function fetchProfile(accessToken: string): Promise<TravelerProfileResponse> {
  return requestProfile<TravelerProfileResponse>(accessToken, {
    method: 'GET',
  });
}

export const getTravelerProfile = fetchProfile;

export function updateProfile(
  accessToken: string,
  payload: UpdateProfilePayload,
): Promise<TravelerProfileResponse> {
  return requestProfile<TravelerProfileResponse>(accessToken, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

export const updateTravelerProfile = updateProfile;
