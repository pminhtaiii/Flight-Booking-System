# Supplier boundary contracts

## Nest module dependencies

```text
FlightsModule ── FLIGHT_SEARCH_PORT ── SupplierSearchModule ── DuffelCoreModule
BookingIntentModule ── FLIGHT_SEARCH_PORT ── SupplierSearchModule
BookingReadinessService / AgentBookingReadinessService / ChatHandoffService ── FLIGHT_SEARCH_PORT ── SupplierSearchModule
AncillariesModule / PaymentModule ── DuffelAncillaryService ── SupplierAncillaryModule ── DuffelCoreModule
PaymentFulfillmentModule ── FULFILLMENT_GATEWAY_PORT ── SupplierOrderModule ── DuffelCoreModule
CancellationModule ── DuffelCancellationService ── SupplierOrderModule
BookingLifecycleModule / DisruptionModule ── DuffelRecoveryService ── SupplierOrderModule
```

`DuffelCoreModule` is imported only by these supplier capability modules. The concrete SDK factory supplies one configured client per Nest application. SDK calls live only in concrete adapters and the Duffel webhook path. `SupplierOrderModule` re-exports the existing fulfillment token bound to `DuffelFulfillmentAdapter`; it does not define a wider order port. No ancillary, cancellation, or recovery port is added.

## `FLIGHT_SEARCH_PORT`

```typescript
type FlightSearchCriteria = {
  origin: string;
  destination: string;
  departureDate: string;
  returnDate?: string;
  adults: number;
  children?: number;
  infants?: number;
  cabinClass?: string;
};

type FlightOffer = {
  id: string;                 // same deterministic application offer ID as current normalizer
  supplierOfferId: string;    // opaque upstream identity
  totalAmount: string;
  price: number;
  currency: string;
  offerExpiresAt: string | null;
  passengers: readonly { supplierPassengerId: string; type: 'ADULT' | 'CHILD' | 'INFANT' }[];
  airline: string;
  flightNumber: string;
  departureAirport: string;
  arrivalAirport: string;
  departureTime: string;
  arrivalTime: string;
  duration: number;
  stops: number;
  fareClass: string | null;
  baggageAllowance: string | null;
  segments: readonly FlightSegment[];
  returnSegments: readonly FlightSegment[] | null;
  conditions: {
    refundable: boolean;
    changeable: boolean;
    changeBeforeDeparture: {
      allowed: boolean; penaltyAmount: string | null; penaltyCurrency: string | null;
    } | null;
  };
  matchInput: FlightMatchInput; // price/currency/stops/duration, departure/arrival hours,
                               // carrier codes/names, cabin, checked baggage, originalIndex
  rawSupplierPayload: unknown; // storage only; no consumer may inspect its shape
};

type FlightSegment = {
  supplierSegmentId: string | null;
  carrierCode: string; flightNumber: string; operatingCarrier: string;
  departureAirport: string; departureTerminal: string | null; departureTime: string;
  arrivalAirport: string; arrivalTerminal: string | null; arrivalTime: string;
  duration: number; aircraft: string | null;
  cabinClass: 'economy' | 'premium_economy' | 'business' | 'first';
};

type FlightSearchResult = {
  offers: readonly FlightOffer[];
  searchHash: string;
  cached: boolean;
};

interface FlightSearchPort {
  search(criteria: FlightSearchCriteria, caller: 'user' | 'agent'): Promise<FlightSearchResult>;
  getOfferById(supplierOfferId: string, timeoutMs?: number): Promise<FlightOffer>;
  normalizeStoredOffer(rawOffer: unknown): FlightOffer | null;
}

declare const FLIGHT_SEARCH_PORT: unique symbol;
```

These are contract shapes, not implementation bodies. `FlightOffer` contains all current search/detail/readiness/handoff data; the current requested-cabin comparison and adult/child/infant counts remain request/DB context supplied by `FlightsService`, not properties inferred from Duffel. Preserve the deterministic ID function, original-index association, rejection counts, and top-20 selection order. The port's `normalizeStoredOffer` delegates to the module-internal normalizer for legacy persisted rows; it accepts raw JSON only as opaque input and returns a neutral offer or `null` for malformed evidence so each existing reader keeps its fail-closed outcome. Live lookup normalization failure maps to the existing safe upstream-unavailable result. The search service owns normalized-query hashing, raw cache policy, and user/agent sub-budget admission. The adapter owns Duffel request construction, per-attempt budget reservation, and supplier-specific backpressure. The normalizer owns Duffel shape interpretation. `FlightsService` owns airport validation, user search history, transactional offer/recovery persistence, audit records, and HTTP mapping. `rawSupplierPayload` is written verbatim to existing `FlightOffer.rawOffer`; no domain consumer parses it.

**Compatibility**: `searchHash`, cached flag, order of results, match metadata, offer freshness, 404/410 expiry recovery, and current `RATE_LIMIT_EXCEEDED` status/code remain. The port does not expose `DuffelOffer`, `DuffelOfferRequest`, or the SDK client.

## Ancillary concrete capability

`DuffelAncillaryService` offers the existing catalog and repricing operations to `AncillaryCatalogService` and `AncillaryPaymentValidationService`. It keeps catalog cache and force-refresh policy, request-scoped passenger mapping, freshness buffer, and authoritative total validation. `DuffelAncillaryAdapter` owns `seatMaps.get`, `offers.get(...available_services)`, and `offers.getPriced`. Each actual call reserves budget separately. `AncillaryNormalizer` converts supplier seat/service/price data into the existing shared ancillary domain shapes. Missing supplier seat maps preserve current graceful fallback; no provider ID is trusted from an unauthenticated client.

## Order and fulfillment

`FULFILLMENT_GATEWAY_PORT`, `CreateOrderInput/Outcome`, `PortInvocationControl.beforeInvoke`, `cancelOrder`, and `retrieveOrderSnapshot` stay exactly as currently declared in `apps/api/src/payment-fulfillment/ports/fulfillment-gateway.port.ts`. `DuffelFulfillmentAdapter` keeps its bounded semaphore, idempotency key behavior, immediate ownership check before each remote call, PII redaction of persisted evidence, and fallback snapshot enrichment. `DuffelOrderAdapter` owns the existing manual order POST plus order retrieval and cancellation SDK calls. `DuffelCancellationService` and `DuffelRecoveryService` stay concrete and flat inside `SupplierOrderModule`; they call the same adapter and order snapshot normalizer.

No database transaction spans a remote Duffel call. Existing cancellation/refund, duplicate-effect guards, and public errors remain. Both inline capture-failure compensation and `PaymentFulfillmentSaga.handleBackgroundError` keep the order-created checkpoint retryable if supplier cancellation is unconfirmed; neither completes the idempotency key, voids the payment hold, nor terminally fails the booking on that branch. `BookingRecoveryService` follows the same rule. It uses an existing `CacheService` TTL key `booking:recovery:defer:{bookingId}` containing only the next allowed UTC time; the 10-minute sweeper skips until due. A missing key permits a safe recheck. Once cancellation is confirmed (including already-cancelled), the existing void/failure transition may complete. A total-budget denial before order creation occurs before remote effect and uses the existing safe upstream-failure path where the flow has no 429 contract.

## Shared budget contract

`DuffelRateBudget.reserveAttempt(extraConstraint?: { key: string; limit: number })` atomically checks the daily total and, when supplied, one extra counter before incrementing. It returns success or a typed budget-exhausted/unavailable outcome with a retry time when known. Search service chooses `user`/`agent` keys and limits; core never interprets callers. Every actual SDK/manual HTTP attempt invokes it once. The next UTC midnight is the expiry. There is no decrement after a failed network call because an attempt may have reached Duffel. Cached responses and skipped reconciliation runs never call it. Adapter semaphores bound concurrent requests independently of this daily accounting. Remove the old monthly `budget:duffel:YYYY-MM` checks in both `DuffelService.searchFlights` and `disruption/sync/reconciliation.service.ts`; the latter retains its `budgetBlocked` metric by catching the typed denial and deferring the booking without double charging.

The current monthly `budget:duffel:YYYY-MM` data and `DUFFEL_BUDGET_LIMIT_*` defaults are not interpreted as new daily state. New policy keys/configuration and deployment notes must be explicit, and the old keys may expire naturally. Search caller allocations are caps, not guaranteed reservations against later order calls; the global cap still wins.

## Existing wire and security contract

- HTTP route paths, verbs, status codes, error codes, and current JSON keys remain unchanged. API DTOs and shared wire schemas may retain `duffelOfferId`, `duffelOrderId`, `duffelCancellationQuoteId`, and other currently exposed keys only at compatibility boundaries; internal values are supplier-named.
- `SelectionAttestationService` signs and verifies the original `sel_v1_` JSON byte shape, including `duffelOfferId` in ordered offer objects. Mapping must occur outside the signed object; no silent signature migration.
- Web views continue to strip provider identities where they already do. The checkout denylist still rejects `duffelOfferId` and must also reject any newly introduced `supplierOfferId` from untrusted payloads.
- The Python agent keeps its existing HTTP/SSE field aliases. Strict old Redis snapshots that cannot be safely parsed fail closed to a fresh search. Attestation verification never accepts an unsigned alternative field.
- `DuffelWebhookEvent` and its signature/payload processor retain their concrete shape and HMAC verification.

## Final boundary audit

Search for `DuffelService`, `DuffelModule`, private SDK access, `@duffel/api`, and Duffel identifier spellings after the rename. Expected remaining locations are concrete supplier adapters/core, Duffel webhook code, historical migrations, and enumerated wire compatibility tests/DTOs. Each other hit must be removed or documented as a specific compatibility requirement; no broad ignore pattern.
