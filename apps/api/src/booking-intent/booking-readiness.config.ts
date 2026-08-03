export const DEFAULT_PASSPORT_ADVISORY_BUFFER_DAYS = 180;
export const MIN_PASSPORT_ADVISORY_BUFFER_DAYS = 0;
export const MAX_PASSPORT_ADVISORY_BUFFER_DAYS = 3650;

type BookingReadinessConfigEnv = {
  PASSPORT_ADVISORY_BUFFER_DAYS?: string | undefined;
};

export type BookingReadinessConfig = {
  passportAdvisoryBufferDays: number;
};

function clampPassportAdvisoryBufferDays(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_PASSPORT_ADVISORY_BUFFER_DAYS;
  }

  const normalizedValue = Math.trunc(value);

  if (normalizedValue < MIN_PASSPORT_ADVISORY_BUFFER_DAYS) {
    return MIN_PASSPORT_ADVISORY_BUFFER_DAYS;
  }

  if (normalizedValue > MAX_PASSPORT_ADVISORY_BUFFER_DAYS) {
    return MAX_PASSPORT_ADVISORY_BUFFER_DAYS;
  }

  return normalizedValue;
}

export function parseBookingReadinessConfig(env: BookingReadinessConfigEnv = process.env): BookingReadinessConfig {
  const rawValue = env.PASSPORT_ADVISORY_BUFFER_DAYS?.trim();

  if (!rawValue) {
    return {
      passportAdvisoryBufferDays: DEFAULT_PASSPORT_ADVISORY_BUFFER_DAYS,
    };
  }

  const parsedValue = Number(rawValue);

  if (!Number.isFinite(parsedValue)) {
    return {
      passportAdvisoryBufferDays: DEFAULT_PASSPORT_ADVISORY_BUFFER_DAYS,
    };
  }

  return {
    passportAdvisoryBufferDays: clampPassportAdvisoryBufferDays(parsedValue),
  };
}
