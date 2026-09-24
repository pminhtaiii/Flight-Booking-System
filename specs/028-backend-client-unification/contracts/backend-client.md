# Internal Contract: Backend Client

## Factory and result

```typescript
type TokenProvider = () => Promise<string | null>;
type TransportResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: 'http'; status: number; body?: unknown }
  | { ok: false; kind: 'transport'; cause?: string };

createBackendClient(config?: { tokenProvider?: TokenProvider; baseUrl?: string }): {
  request: <T>(path: string, schema: ZodType<T>, opts?: RequestOpts) => Promise<TransportResult<T>>;
};
export const backendClient = createBackendClient();
```

Types remain inline in `apps/web/lib/server/backend-client.ts`. The default provider retains current NextAuth token extraction and URL precedence. `request` never assigns a flight, booking, or dashboard outcome reason.

**Safe cause codes**: `missing_token`, `network`, `timeout`, `invalid_json`, `invalid_payload`. The optional cause is a stable category only; detailed exception causes stay in internal PII-safe logs. Dashboard maps `invalid_json`/`invalid_payload` to existing `INVALID_RESPONSE`; other callers retain their existing unavailable outcomes. HTTP errors retain status and parsed body needed by booking 400/422 messages.

## Retry and validation matrix

| Method and condition | Total attempts |
|---|---:|
| GET network error or timeout | up to 3 |
| GET 502, 503, or 504 | up to 3 |
| GET 429 with valid Retry-After | up to 3; respect header |
| GET other status, including 500 or 429 without valid header | 1 |
| POST, PUT, PATCH, DELETE for any result | 1 |

Backoff is exponential from 100 ms for eligible GET failures. Each attempt has the existing 10-second AbortController timeout. Successful responses are JSON-parsed and validated against the caller's Zod schema before returning `data`. The caller may still validate a mapped domain view; that is a different boundary. Missing token stops before fetch. All requests retain no-store and bearer-token behavior.

## Domain and route adapter boundaries

- `flight-search.ts`: existing search and offer selection outcomes, local input checks, flight mapping, and view validation.
- `booking-management.ts`: all eight existing exported operations, status/error body mapping, projection, and view validation.
- `dashboard.ts`: existing 401/403/unavailable/INVALID_RESPONSE outcome semantics.
- `outcome-response.ts`: only BookingManagementOutcome → NextResponse; used by all six existing booking-management route files. Public status/body/header mapping is unchanged.
