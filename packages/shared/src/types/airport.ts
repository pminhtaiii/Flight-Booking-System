export type AirportType = 'LARGE_AIRPORT' | 'MEDIUM_AIRPORT';

export interface Airport {
  id: string;
  iataCode: string;
  icaoCode?: string | null;
  name: string;
  city: string;
  country: string;
  region?: string | null;
  latitude: number;
  longitude: number;
  elevation?: number | null;
  type: AirportType;
  timezone?: string | null;
  createdAt: Date;
  updatedAt: Date;
}
