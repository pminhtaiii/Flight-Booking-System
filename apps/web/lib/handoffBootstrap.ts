import { isOpaqueChatId } from './chatTrace';

export type HandoffBootstrapResult = {
  ok: boolean;
  status: number;
  context?: HandoffCheckoutContext;
};

export type HandoffCheckoutContext = {
  offer: {
    airline: string;
    origin: string;
    destination: string;
    departureAt: string;
    arrivalAt: string;
    price: string;
    currency: string;
    adults: number;
    children: number;
    infants: number;
  };
  passengers: Array<{ id: string; type: 'ADULT' | 'CHILD' | 'INFANT' }>;
};

export function hasCheckoutHandoffContext(
  result: HandoffBootstrapResult,
): result is HandoffBootstrapResult & { context: HandoffCheckoutContext } {
  return result.ok && result.context !== undefined;
}

type BootstrapFetcher = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export const HANDOFF_BOOTSTRAP_TIMEOUT_MS = 10_000;

export async function resolveHandoffForBootstrap(
  apiUrl: string,
  handoffToken: string,
  accessToken: string,
  traceId: string | undefined,
  correlationId: string | undefined,
  fetcher: BootstrapFetcher = fetch,
  timeoutMs = HANDOFF_BOOTSTRAP_TIMEOUT_MS,
): Promise<HandoffBootstrapResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  if (isOpaqueChatId(traceId)) {
    headers['X-Trace-Id'] = traceId;
  }
  if (isOpaqueChatId(correlationId)) {
    headers['X-Correlation-Id'] = correlationId;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetcher(
      new URL('/api/bookings/handoffs/resolve', apiUrl).toString(),
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ handoffToken }),
        cache: 'no-store',
        signal: controller.signal,
      },
    );

    if (!response.ok) return { ok: false, status: response.status };
    const body: unknown = await response.json().catch(() => null);
    return isHandoffCheckoutContext(body)
      ? { ok: true, status: response.status, context: body }
      : { ok: true, status: response.status };
  } catch {
    return { ok: false, status: 503 };
  } finally {
    clearTimeout(timeout);
  }
}

function isHandoffCheckoutContext(value: unknown): value is HandoffCheckoutContext {
  if (!isRecord(value) || !isRecord(value.offer) || !Array.isArray(value.passengers)) {
    return false;
  }
  const offer = value.offer;
  const passengers = value.passengers;

  const stringFields = [
    'airline',
    'origin',
    'destination',
    'departureAt',
    'arrivalAt',
    'price',
    'currency',
  ];
  if (!stringFields.every((field) => typeof offer[field] === 'string' && offer[field] !== '')) {
    return false;
  }

  const adults = offer.adults;
  const children = offer.children;
  const infants = offer.infants;
  if (
    typeof adults !== 'number' || !Number.isInteger(adults) || adults < 0
    || typeof children !== 'number' || !Number.isInteger(children) || children < 0
    || typeof infants !== 'number' || !Number.isInteger(infants) || infants < 0
  ) {
    return false;
  }
  if (passengers.length === 0) return false;

  const passengerCounts = { ADULT: 0, CHILD: 0, INFANT: 0 };
  for (const passenger of passengers) {
    if (!isRecord(passenger) || typeof passenger.id !== 'string' || passenger.id === '') return false;
    if (passenger.type !== 'ADULT' && passenger.type !== 'CHILD' && passenger.type !== 'INFANT') {
      return false;
    }
    passengerCounts[passenger.type] += 1;
  }

  return passengerCounts.ADULT === adults
    && passengerCounts.CHILD === children
    && passengerCounts.INFANT === infants;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
