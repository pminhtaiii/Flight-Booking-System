export const ALLOWED_RETURN_PREFIXES = [
  '/',
  '/dashboard',
  '/search',
  '/bookings',
  '/checkout',
  '/prototype/chat',
] as const;

export const OFFER_ID_PATTERN = /^off_[A-Za-z0-9_-]{1,128}$/;
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const SCENARIO_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isAllowedPath(pathname: string): boolean {
  if (pathname.includes('//')) {
    return false;
  }

  if (pathname === '/') {
    return true;
  }

  return ALLOWED_RETURN_PREFIXES.some((prefix) => {
    if (prefix === '/') {
      return false;
    }
    return pathname === prefix || pathname.startsWith(`${prefix}/`);
  });
}

function safeSearch(search: string): string {
  if (!search) {
    return '';
  }

  const params = new URLSearchParams(search);
  const safeParams = new URLSearchParams();

  const offerId = params.get('offerId');
  if (offerId && OFFER_ID_PATTERN.test(offerId)) {
    safeParams.set('offerId', offerId);
  }

  const sessionId = params.get('sessionId');
  if (sessionId && SESSION_ID_PATTERN.test(sessionId)) {
    safeParams.set('sessionId', sessionId);
  }

  if (params.get('autoResume') === 'true') {
    safeParams.set('autoResume', 'true');
  }

  const scenario = params.get('scenario');
  if (scenario && SCENARIO_PATTERN.test(scenario)) {
    safeParams.set('scenario', scenario);
  }

  const searchStr = safeParams.toString();
  return searchStr ? `?${searchStr}` : '';
}

export function getSafeReturnTarget(candidate: string | null | undefined, fallback = '/'): string {
  if (typeof candidate !== 'string') {
    return fallback;
  }

  const trimmed = candidate.trim();
  if (!trimmed || trimmed !== candidate) {
    return fallback;
  }

  if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.startsWith('/\\')) {
    return fallback;
  }

  if (candidate.includes('\\') || candidate.toLowerCase().includes('%5c')) {
    return fallback;
  }

  if (/[\r\n\0\t]/.test(candidate)) {
    return fallback;
  }

  try {
    const base = 'http://flight-system.internal';
    const target = new URL(candidate, base);

    if (target.origin !== base || !isAllowedPath(target.pathname)) {
      return fallback;
    }

    return `${target.pathname}${safeSearch(target.search)}`;
  } catch {
    return fallback;
  }
}
