function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isDuffelCancellationConfirmed(response: unknown): boolean {
  if (!isRecord(response) || response.success === false) return false;
  if (typeof response.confirmed_at === 'string' && response.confirmed_at.trim().length > 0) {
    return true;
  }
  return (
    typeof response.status === 'string' &&
    ['confirmed', 'cancelled', 'canceled'].includes(response.status.toLowerCase())
  );
}
