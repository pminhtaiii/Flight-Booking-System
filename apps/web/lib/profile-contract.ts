import type {
  HourWindow,
  PriceSensitivity,
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
  preferredAirlines?: string[] | null;
  blacklistedAirlines?: string[] | null;
  preferredDepartureWindow?: HourWindow | null;
  preferredArrivalWindow?: HourWindow | null;
  maxStops?: number | null;
  priceSensitivity?: PriceSensitivity | null;
  requiresCheckedBaggage?: boolean | null;
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

const GENERIC_PROFILE_FAILURE_MESSAGE = 'We could not update your traveler profile.';
const PROFILE_ERROR_MESSAGES_BY_CODE = new Map<string, string>([
  ['PROFILE_UPDATE_CONFLICT', 'Profile has been modified by another session. Refresh and retry.'],
  ['PROFILE_REVISION_CONFLICT', 'Profile revision conflict.'],
]);
const SAFE_PROFILE_ERROR_MESSAGES = new Set<string>([
  'Invalid passport expiration date format.',
  'givenName is required. email must be a valid email.',
  'Authentication required.',
  'Access to profile is forbidden.',
  'Profile not found.',
  'Internal server error processing profile.',
  'Upstream profile database unreachable.',
]);

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
  const serverMessage = Array.isArray(errorBody.message)
    ? errorBody.message.filter((item): item is string => typeof item === 'string').join(' ')
    : typeof errorBody.message === 'string'
      ? errorBody.message
      : GENERIC_PROFILE_FAILURE_MESSAGE;
  const serverCode = typeof errorBody.code === 'string' ? errorBody.code : null;
  const code =
    response.status === 409 && serverMessage === 'PROFILE_UPDATE_CONFLICT'
      ? 'PROFILE_UPDATE_CONFLICT'
      : serverCode;
  const message =
    (code === null ? undefined : PROFILE_ERROR_MESSAGES_BY_CODE.get(code)) ??
    (SAFE_PROFILE_ERROR_MESSAGES.has(serverMessage)
      ? serverMessage
      : GENERIC_PROFILE_FAILURE_MESSAGE);

  return new ProfileRequestError(response.status, message, code);
}
