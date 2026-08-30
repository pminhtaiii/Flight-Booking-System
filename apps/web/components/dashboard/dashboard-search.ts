type CabinClass = 'economy' | 'premium_economy' | 'business' | 'first';

export type QuickSearchParams = {
  origin: string;
  destination: string;
  departureDate: string;
  adults?: number;
  cabinClass?: CabinClass;
};

type QuickSearchValidation =
  | { valid: true; value: { origin: string; destination: string; departureDate: string } }
  | { valid: false; error: string };

const IATA_CODE_PATTERN = /^[A-Z]{3}$/;

const isCalendarDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const [year, month, day] = value.split('-').map(Number);
  const parsedDate = new Date(year, month - 1, day);

  return (
    parsedDate.getFullYear() === year &&
    parsedDate.getMonth() === month - 1 &&
    parsedDate.getDate() === day
  );
};

const startOfLocalDay = (value: Date): Date => {
  const today = new Date(value);
  today.setHours(0, 0, 0, 0);
  return today;
};

const isCabinClass = (value: CabinClass | undefined): value is CabinClass =>
  value === 'economy' || value === 'premium_economy' || value === 'business' || value === 'first';

export const normalizeAirportCode = (input: string): string => input.trim().toUpperCase();

export const validateQuickSearch = (
  params: QuickSearchParams,
  today: Date = new Date(),
): QuickSearchValidation => {
  const origin = normalizeAirportCode(params.origin);
  const destination = normalizeAirportCode(params.destination);

  if (!origin) return { valid: false, error: 'Departure airport code is required.' };
  if (!destination) return { valid: false, error: 'Arrival airport code is required.' };
  if (!IATA_CODE_PATTERN.test(origin))
    return { valid: false, error: 'Departure airport code must be a three-letter IATA code.' };
  if (!IATA_CODE_PATTERN.test(destination))
    return { valid: false, error: 'Arrival airport code must be a three-letter IATA code.' };
  if (origin === destination)
    return { valid: false, error: 'Departure and arrival airports must be different.' };
  if (!isCalendarDate(params.departureDate))
    return { valid: false, error: 'Departure date must be a valid YYYY-MM-DD date.' };

  const [year, month, day] = params.departureDate.split('-').map(Number);
  const departureDate = new Date(year, month - 1, day);
  if (departureDate < startOfLocalDay(today))
    return { valid: false, error: 'Departure date must be today or later.' };

  return { valid: true, value: { origin, destination, departureDate: params.departureDate } };
};

export const buildSearchUrl = (params: QuickSearchParams): string => {
  const query = new URLSearchParams();
  const adults =
    typeof params.adults === 'number' &&
    Number.isInteger(params.adults) &&
    params.adults >= 1 &&
    params.adults <= 9
      ? params.adults
      : 1;

  query.set('origin', normalizeAirportCode(params.origin));
  query.set('destination', normalizeAirportCode(params.destination));
  query.set('departureDate', params.departureDate);
  query.set('adults', String(adults));
  query.set('cabinClass', isCabinClass(params.cabinClass) ? params.cabinClass : 'economy');

  return `/search?${query.toString()}`;
};
