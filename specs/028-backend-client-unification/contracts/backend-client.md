# Internal Contract: Backend Client

## Factory and result

```typescript
type TokenProvider = () => Promise<string | null>;
type TransportResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: 'http'; status: number; body?: unknown }
  | { ok: false; kind: 'transport'; cause?: string };

type RequestOpts = RequestInit & { responseMode?: 'json' | 'none' };

createBackendClient(config?: { tokenProvider?: TokenProvider; baseUrl?: string }): {
  request: <T>(path: string, schema: ZodType<T>, opts?: RequestOpts) => Promise<TransportResult<T>>;
};
export const backendClient = createBackendClient();
```

Types remain inline in `apps/web/lib/server/backend-client.ts`. The default provider retains current NextAuth token extraction and URL precedence. `request` never assigns a flight, booking, or dashboard outcome reason.

**Safe cause codes**: `missing_token`, `network`, `timeout`, `invalid_json`, `invalid_payload`. The optional cause is a stable category only; detailed exception causes stay in internal PII-safe logs. Dashboard maps `invalid_json`/`invalid_payload` to existing `INVALID_RESPONSE`; other callers retain their existing unavailable outcomes. A non-2xx response always returns `kind: 'http'` and its status, even when its error body is malformed; in that case `body` is absent and booking 400/422 uses its current default message.

## Retry and validation matrix

| Method and condition | Total attempts |
|---|---:|
| GET network error or timeout | up to 3 |
| GET 502, 503, or 504 | up to 3 |
| GET 429 with valid Retry-After | up to 3 if required wait fits the total deadline; otherwise return 429 immediately |
| GET other status, including 500 or 429 without valid header | 1 |
| POST, PUT, PATCH, DELETE for any result | 1 |

Backoff is exponential from 100 ms for eligible GET failures. A total 31-second deadline includes all attempts and waits; each attempt uses at most the existing 10-second AbortController timeout and the remaining total budget. Parse Retry-After as delta seconds or HTTP date; never retry before its required delay. If it cannot fit the remaining budget, return the 429 immediately. Successful JSON responses are parsed and validated against the caller's Zod schema before returning `data`; malformed successful JSON is `kind: 'transport'`. For status-only success, call `request<void>(path, z.void(), { responseMode: 'none', ... })`: do not read any successful response body and return `data: undefined`. The caller may still validate a mapped domain view; that is a different boundary. Missing token stops before fetch. All requests retain no-store and bearer-token behavior.

## Domain and route adapter boundaries

- `flight-search.ts`: existing search and offer selection outcomes, local input checks, flight mapping, and view validation.
- `booking-management.ts`: six JSON-consuming operations (list, detail, cancellation status, cancellation quote, cancel, revisions) use operation-specific raw response schemas shaped to preserve current tolerated fields/defaults, followed by current projection/view validation. Acknowledge and accept disruption use explicit none mode and construct their existing `{ ok: true }` domain data on 2xx. All eight retain status/error body mapping.
- `dashboard.ts`: existing 401/403/unavailable/INVALID_RESPONSE outcome semantics.
- `outcome-response.ts`: only BookingManagementOutcome → NextResponse; used by all six existing booking-management route files. Public status/body/header mapping is unchanged.
