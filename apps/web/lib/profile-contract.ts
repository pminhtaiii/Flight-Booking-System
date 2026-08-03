import type {
  TravelerContact,
  TravelerDocument,
  TravelerIdentity,
  TravelerPreferences,
} from '@shared/types';

export type TravelerProfileResponse = {
  profileId: string | null;
  identity: TravelerIdentity | null;
  contact: TravelerContact | null;
  travelDocument: TravelerDocument | null;
  preferences: TravelerPreferences | null;
  revision: number;
  updatedAt?: string;
};

export type ProfileIdentityUpdate = {
  givenName: string;
  middleName: string | null;
  familyName: string;
  dateOfBirth: string;
  gender: string;
  title: string;
};

export type ProfileContactUpdate = {
  email: string;
  phoneCountryCode: string;
  phoneNumber: string;
};

export type ProfileDocumentUpdate = {
  documentType: string;
  passportNumber: string;
  passportExpiry: string;
  issuingCountry: string;
  nationality: string;
};

export type ProfilePreferencesUpdate = {
  seatPreference: string | null;
  classPreference: string | null;
};

export type UpdateProfilePayload = {
  expectedRevision: number;
  identity?: ProfileIdentityUpdate | null;
  contact?: ProfileContactUpdate | null;
  travelDocument?: ProfileDocumentUpdate | null;
  preferences?: ProfilePreferencesUpdate | null;
};

type ErrorBody = {
  code?: unknown;
  message?: unknown;
};

export class ProfileRequestError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = 'ProfileRequestError';
    this.status = status;
    this.code = code;
  }
}

function isErrorBody(value: unknown): value is ErrorBody {
  return typeof value === 'object' && value !== null;
}

export async function getProfileRequestError(response: Response): Promise<ProfileRequestError> {
  let body: unknown = null;

  try {
    body = await response.json();
  } catch {
    body = null;
  }

  const errorBody = isErrorBody(body) ? body : {};
  const message = Array.isArray(errorBody.message)
    ? errorBody.message.filter((item): item is string => typeof item === 'string').join(' ')
    : typeof errorBody.message === 'string'
      ? errorBody.message
      : 'We could not update your traveler profile.';
  const code = typeof errorBody.code === 'string' ? errorBody.code : null;

  return new ProfileRequestError(response.status, message, code);
}
