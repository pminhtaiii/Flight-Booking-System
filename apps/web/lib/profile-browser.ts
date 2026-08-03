import {
  getProfileRequestError,
  type TravelerProfileResponse,
  type UpdateProfilePayload,
} from './profile-contract';

async function requestBrowserProfile<T>(init: RequestInit): Promise<T> {
  const response = await fetch('/api/profile', {
    ...init,
    cache: 'no-store',
  });

  if (!response.ok) {
    throw await getProfileRequestError(response);
  }

  return (await response.json()) as T;
}

export function fetchBrowserProfile(): Promise<TravelerProfileResponse> {
  return requestBrowserProfile<TravelerProfileResponse>({
    method: 'GET',
  });
}

export function updateBrowserProfile(
  payload: UpdateProfilePayload,
): Promise<TravelerProfileResponse> {
  return requestBrowserProfile<TravelerProfileResponse>({
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}
