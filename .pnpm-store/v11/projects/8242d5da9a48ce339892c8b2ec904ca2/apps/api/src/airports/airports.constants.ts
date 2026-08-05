import { createHash } from 'crypto';

export function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

export const CACHE_TTLS = {
  SEARCH: 86400, // 24 hours
  DETAIL: 86400, // 24 hours
  NEARBY: 3600,  // 1 hour
  ALL: 86400,    // 24 hours
};

export const CACHE_KEYS = {
  SEARCH: (q: string, limit: number) => {
    const hash = sha256(JSON.stringify({ q, limit }));
    return `airports:search:${hash}`;
  },
  DETAIL: (iataCode: string) => {
    return `airports:detail:${iataCode.toUpperCase()}`;
  },
  NEARBY: (lat: number, lng: number, radius: number, limit: number) => {
    const hash = sha256(JSON.stringify({ lat, lng, radius, limit }));
    return `airports:nearby:${hash}`;
  },
  ALL: 'airports:all',
};
