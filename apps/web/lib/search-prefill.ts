import type { FlightSearchQuery } from '@shared/types';

export type SearchPageSearchParams = Record<string, string | string[] | undefined>;

const IATA_CODE_PATTERN = /^[A-Z]{3}$/;

export const isExactCalendarDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
};

export const parseDurationMinutes = (duration: string): number => {
  const match = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(duration);
  if (!match) return 0;
  const [days = 0, hours = 0, minutes = 0, seconds = 0] = match
    .slice(1)
    .map((v) => Number(v ?? 0));
  return days * 1_440 + hours * 60 + minutes + Math.ceil(seconds / 60);
};

export const formatDuration = (duration: string): string => {
  const totalMinutes = parseDurationMinutes(duration);
  if (totalMinutes <= 0) return duration;
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
};

export const isCabinClass = (value: string): value is FlightSearchQuery['cabinClass'] =>
  value === 'economy' || value === 'premium_economy' || value === 'business' || value === 'first';

export const getSingleValue = (value: string | string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

export const getInitialValues = (
  searchParams: SearchPageSearchParams,
  preferredCabinClass?: FlightSearchQuery['cabinClass'],
): Partial<FlightSearchQuery> => {
  const origin = getSingleValue(searchParams.origin);
  const destination = getSingleValue(searchParams.destination);
  const departureDate = getSingleValue(searchParams.departureDate);
  const adults = Number(getSingleValue(searchParams.adults));
  const cabinClassParam = getSingleValue(searchParams.cabinClass);

  let cabinClass: FlightSearchQuery['cabinClass'] | undefined;
  if (cabinClassParam && isCabinClass(cabinClassParam)) {
    // Explicit URL query strictly overrides profile's classPreference
    cabinClass = cabinClassParam;
  } else if (preferredCabinClass && isCabinClass(preferredCabinClass)) {
    // Profile cabin prefill when query param is omitted
    cabinClass = preferredCabinClass;
  }

  return {
    ...(origin && IATA_CODE_PATTERN.test(origin) ? { origin } : {}),
    ...(destination && IATA_CODE_PATTERN.test(destination) ? { destination } : {}),
    ...(departureDate && isExactCalendarDate(departureDate) ? { departureDate } : {}),
    ...(Number.isInteger(adults) && adults >= 1 && adults <= 9 ? { adults } : {}),
    ...(cabinClass ? { cabinClass } : {}),
  };
};
