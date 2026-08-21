# Booking Module Contracts

## Booking Lifecycle

```ts
type BookingPipelineOutcome =
  | {
      status: 'CONFIRMED';
      bookingId: string;
      paymentId: string;
      pnrReference: string;
      duffelOrderId: string;
      flightSnapshot: unknown;
      passengerSnapshot: unknown;
      occurredAt: string;
    }
  | {
      status: 'FAILED';
      bookingId: string;
      paymentId: string;
      category: BookingFailureReason;
      partialState?: unknown;
      occurredAt: string;
    };

applyPipelineOutcome(outcome: BookingPipelineOutcome): Promise<Booking>;
checkAndCompleteBooking(bookingId: string): Promise<BookingCompletionResult>;
```

Booking Lifecycle owns booking state, agent-projection refresh, and audit persistence. Stripe authorization/capture and Duffel order creation remain in the Payment pipeline. Provider-aware stale recovery is an internal lifecycle adapter that normalizes facts before calling the state-transition core.

## Booking Management

```ts
listBookings(userId: string, query: BookingListQuery): Promise<BookingListView>;
getBookingDetail(userId: string, bookingId: string): Promise<BookingDetailView>;
```

The returned views preserve current owner-facing data and exclude raw supplier/payment payloads.

## Cancellation

```ts
getCancellationStatus(userId: string, bookingId: string): Promise<CancellationStatusView>;
getCancellationQuote(userId: string, bookingId: string): Promise<CancellationQuoteView>;
cancelBooking(userId: string, bookingId: string, quoteId: string): Promise<CancellationResult>;
```

Cancellation owns eligibility, the supplier-first state machine, quote validation, cancellation recovery, obligation creation, and provider refund triggering. It never performs terminal settlement writes.

## Dependency rule

```text
Payment → Booking Lifecycle
Disruption Reconciliation → Booking Lifecycle
Booking HTTP Composition → Booking Management + Cancellation
Cancellation → Refund Transaction Orchestration → Refund Settlement
```

No Payment↔Booking `forwardRef` or broad BookingService facade is permitted.
