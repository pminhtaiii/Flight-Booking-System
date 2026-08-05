export function isTransientStripeError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { statusCode?: unknown; code?: unknown; message?: unknown };
  if (typeof candidate.statusCode === 'number' && (candidate.statusCode === 429 || candidate.statusCode >= 500)) {
    return true;
  }
  const code = typeof candidate.code === 'string' ? candidate.code : '';
  const message = typeof candidate.message === 'string' ? candidate.message : '';
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|timeout|connection|api_connection_error/i.test(`${code} ${message}`);
}

export function toMajorCurrency(amount: number): string {
  return (amount / 100).toFixed(2);
}
