import { FactoryProvider } from '@nestjs/common';
import { Duffel } from '@duffel/api';

export const DUFFEL_SDK = Symbol('DUFFEL_SDK');

/**
 * Creates a Duffel SDK client from DUFFEL_ACCESS_TOKEN and optional DUFFEL_API_URL.
 * Uses the default Duffel endpoint when the URL is unset or blank; overrides
 * retain the origin and path with trailing slashes removed.
 *
 * @returns A new client configured with the trimmed access token and base URL.
 * @throws If the token is missing or blank, or the URL is invalid or not HTTP(S).
 */
export function createDuffelSdk(): Duffel {
  const token = process.env.DUFFEL_ACCESS_TOKEN;
  if (!token || token.trim() === '') {
    throw new Error('DUFFEL_ACCESS_TOKEN is required');
  }

  const rawApiUrl = process.env.DUFFEL_API_URL;
  let basePath = 'https://api.duffel.com';

  if (rawApiUrl && rawApiUrl.trim() !== '') {
    const trimmed = rawApiUrl.trim();
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(
        `Unsupported DUFFEL_API_URL protocol: ${parsed.protocol}. Only http: and https: are allowed.`,
      );
    }
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    basePath = `${parsed.origin}${path}`.replace(/\/+$/, '');
  }

  return new Duffel({
    token: token.trim(),
    basePath,
  });
}

export const duffelSdkProvider: FactoryProvider<Duffel> = {
  provide: DUFFEL_SDK,
  useFactory: (): Duffel => {
    return createDuffelSdk();
  },
};
