import { Airport } from '@shared/types';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

const DEFAULT_TIMEOUT_MS = 5000;

async function fetchWithTimeout(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

export type NearbyAirportResponse = {
  data: (Airport & { distanceKm: number })[];
  count: number;
  center: { lat: number; lng: number };
  radiusKm: number;
};

export type AirportSearchResponse = {
  data: Airport[];
  count: number;
};

export async function searchAirports(q: string, limit?: number): Promise<Airport[]> {
  try {
    const limitQuery = limit ? `&limit=${limit}` : '';
    const res = await fetchWithTimeout(`${API_URL}/api/airports/search?q=${encodeURIComponent(q)}${limitQuery}`);
    if (!res.ok) {
      throw new Error(`Failed to search airports: ${res.statusText}`);
    }
    const result: AirportSearchResponse = await res.json();
    return result.data;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[airport-service/searchAirports]', error);
    return [];
  }
}

export async function getAirportByIataCode(iataCode: string): Promise<Airport | null> {
  try {
    const res = await fetchWithTimeout(`${API_URL}/api/airports/${encodeURIComponent(iataCode.toUpperCase())}`);
    if (!res.ok) {
      if (res.status === 404) return null;
      throw new Error(`Failed to fetch airport ${iataCode}: ${res.statusText}`);
    }
    const data: Airport = await res.json();
    return data;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[airport-service/getAirportByIataCode] iataCode=${iataCode}`, error);
    return null;
  }
}

export async function getNearbyAirports(
  lat: number,
  lng: number,
  radius?: number,
  limit?: number
): Promise<NearbyAirportResponse | null> {
  try {
    const params = new URLSearchParams({
      lat: lat.toString(),
      lng: lng.toString(),
    });
    if (radius) params.append('radius', radius.toString());
    if (limit) params.append('limit', limit.toString());

    const res = await fetchWithTimeout(`${API_URL}/api/airports/nearby?${params.toString()}`);
    if (!res.ok) {
      throw new Error(`Failed to fetch nearby airports: ${res.statusText}`);
    }
    const data: NearbyAirportResponse = await res.json();
    return data;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[airport-service/getNearbyAirports] lat=${lat}, lng=${lng}`, error);
    return null;
  }
}

export async function getAllAirports(): Promise<Airport[]> {
  try {
    const res = await fetchWithTimeout(`${API_URL}/api/airports/all`);
    if (!res.ok) {
      throw new Error(`Failed to fetch all airports: ${res.statusText}`);
    }
    const result: AirportSearchResponse = await res.json();
    return result.data;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[airport-service/getAllAirports]', error);
    return [];
  }
}
