# Web Server Seam Contracts

## Shared Flight Search outcomes

```ts
type FlightSearchOutcome =
  | { ok: true; offers: FlightSearchOfferView[]; meta: FlightSearchMeta }
  | {
      ok: false;
      reason: 'UNAUTHENTICATED' | 'INVALID_SEARCH' | 'RATE_LIMITED' | 'UPSTREAM_UNAVAILABLE';
      message: string;
      retryable: boolean;
    };

type FlightSelectionOutcome =
  | { ok: true; checkoutPath: string }
  | {
      ok: false;
      reason: 'OFFER_EXPIRED' | 'OFFER_UNAVAILABLE' | 'UNAUTHENTICATED';
      message: string;
      retryable: boolean;
    };
```

`FlightSearchOfferView.id` is an opaque local identifier. No Duffel identifier is serialized to the browser.

## Flight Search operations

- Server-only domain operations own session/JWT extraction, private API URL, timeout, read retry, runtime upstream validation, and error normalization.
- Colocated Next.js 14 Server Actions expose serializable `searchFlightsAction` and `selectFlightOfferAction` results to the Client Component.
- Mutations fail fast; GET/read retries remain bounded by the accepted policy.

## Booking Management outcomes

```ts
type BookingManagementOutcome<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      reason:
        | 'UNAUTHENTICATED'
        | 'FORBIDDEN'
        | 'NOT_FOUND'
        | 'STALE_REVISION'
        | 'INVALID_COMMAND'
        | 'UPSTREAM_UNAVAILABLE';
      message: string;
      retryable: boolean;
    };
```

Prepared views cover list, detail, cancellation status/quote, and itinerary revision pages. Authenticated owner-facing PNR/passenger fields remain; Stripe IDs, Duffel order IDs, raw snapshots, and provider payloads do not.

## Booking transport

- Server Components call the server-only domain module for initial list/detail reads.
- Explicit same-origin Route Handlers serve client polling, cancellation commands, disruption commands, and history pagination by delegating to the same domain module.
- Route Handler action segments are allowlisted and all responses are private/no-store.
- Client Components never receive or read JWTs, backend URLs, or retry policy.
