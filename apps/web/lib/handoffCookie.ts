export const HANDOFF_COOKIE_NAME = 'chat_handoff_token';

export function handoffCookieOptions(): {
  httpOnly: true;
  secure: true;
  sameSite: 'strict';
  maxAge: number;
  path: '/';
} {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    maxAge: 15 * 60,
    path: '/',
  };
}

export function expiredHandoffCookieHeader(): string {
  return `${HANDOFF_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}
