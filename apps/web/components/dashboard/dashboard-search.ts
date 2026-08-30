export type QuickSearchInput = {
  origin?: string;
  destination?: string;
  departureDate?: string;
  adults?: number;
  cabinClass?: string;
};

export type ValidQuickSearch = {
  origin: string;
  destination: string;
  departureDate: string;
};

export type QuickSearchResult =
  | { valid: true; value: ValidQuickSearch }
  | { valid: false; error?: string };

export function normalizeAirportCode(code: string): string {
  return (code || '').trim().toUpperCase();
}

export function validateQuickSearch(
  input: QuickSearchInput,
  today: Date = new Date(),
): QuickSearchResult {
  const origin = normalizeAirportCode(input.origin ?? '');
  const destination = normalizeAirportCode(input.destination ?? '');
  const departureDate = (input.departureDate ?? '').trim();

  if (!origin || origin.length < 3) {
    return { valid: false, error: 'Origin airport must be at least 3 characters' };
  }

  if (!destination || destination.length < 3) {
    return { valid: false, error: 'Destination airport must be at least 3 characters' };
  }

  if (origin === destination) {
    return { valid: false, error: 'Origin and destination cannot be the same airport' };
  }

  if (!departureDate) {
    return { valid: false, error: 'Departure date is required' };
  }

  const depTime = new Date(`${departureDate}T00:00:00.000Z`).getTime();
  if (isNaN(depTime)) {
    return { valid: false, error: 'Invalid departure date' };
  }

  const todayUtcStr = today.toISOString().split('T')[0];
  const todayTime = new Date(`${todayUtcStr}T00:00:00.000Z`).getTime();

  if (depTime < todayTime) {
    return { valid: false, error: 'Departure date cannot be in the past' };
  }

  return {
    valid: true,
    value: {
      origin,
      destination,
      departureDate,
    },
  };
}

export function buildSearchUrl(params: {
  origin: string;
  destination: string;
  departureDate: string;
}): string {
  const origin = normalizeAirportCode(params.origin);
  const destination = normalizeAirportCode(params.destination);
  const departureDate = (params.departureDate || '').trim();

  const searchParams = new URLSearchParams();
  searchParams.set('origin', origin);
  searchParams.set('destination', destination);
  searchParams.set('departureDate', departureDate);
  searchParams.set('adults', '1');
  searchParams.set('cabinClass', 'economy');

  return `/search?${searchParams.toString()}`;
}
