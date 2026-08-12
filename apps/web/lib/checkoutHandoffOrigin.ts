export function isSameOrigin(requestUrl: string, candidate: string): boolean {
  try {
    return new URL(candidate).origin === new URL(requestUrl).origin;
  } catch {
    return false;
  }
}
