const ALLOWED_RETURN_PREFIXES = [
  '/',
  '/dashboard',
  '/search',
  '/bookings',
  '/checkout/passengers',
  '/prototype/chat',
];
const OFFER_ID_PATTERN = /^off_[A-Za-z0-9_-]{1,128}$/;

function isAllowedPath(pathname: string): boolean {
  return ALLOWED_RETURN_PREFIXES.some((prefix) => pathname === prefix || (prefix !== '/' && pathname.startsWith(`${prefix}/`)));
}

function safeSearch(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  const safeParams = new URLSearchParams();
  
  const offerId = params.get('offerId');
  if (offerId && OFFER_ID_PATTERN.test(offerId)) {
    safeParams.set('offerId', offerId);
  }

  const sessionId = params.get('sessionId');
  if (sessionId && /^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
    safeParams.set('sessionId', sessionId);
  }

  if (params.get('autoResume') === 'true') {
    safeParams.set('autoResume', 'true');
  }

  const scenario = params.get('scenario');
  if (scenario) {
    safeParams.set('scenario', scenario);
  }

  const searchStr = safeParams.toString();
  return searchStr ? `?${searchStr}` : '';
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

    return `${target.pathname}${safeSearch(target.pathname, target.search)}`;
  } catch {
    return fallback;
  }
}
