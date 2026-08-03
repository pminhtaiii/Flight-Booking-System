const ALLOWED_RETURN_PREFIXES = [
  '/',
  '/dashboard',
  '/search',
  '/bookings',
  '/checkout/passengers',
];

function isAllowedPath(pathname: string): boolean {
  return ALLOWED_RETURN_PREFIXES.some((prefix) => pathname === prefix || (prefix !== '/' && pathname.startsWith(`${prefix}/`)));
}

export function getSafeReturnTarget(candidate: string | null | undefined, fallback = '/'): string {
  if (!candidate || candidate.startsWith('//')) {
    return fallback;
  }

  try {
    const target = new URL(candidate, 'http://flight-system.internal');

    if (target.origin !== 'http://flight-system.internal' || !isAllowedPath(target.pathname)) {
      return fallback;
    }

    return target.pathname;
  } catch {
    return fallback;
  }
}
