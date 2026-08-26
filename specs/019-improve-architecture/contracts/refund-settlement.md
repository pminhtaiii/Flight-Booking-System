# Refund Settlement Contract

## Public in-process operation

```ts
type RefundSettlementInput = {
  transactionId: string;
  money: { amount: number; currency: string };
  outcome:
    | { status: 'SUCCEEDED'; providerReference: string; occurredAt: string }
    | { status: 'FAILED'; errorCode: string; occurredAt: string };
  provenance: {
    source: 'INLINE' | 'WEBHOOK' | 'CRON' | 'ADMIN';
    externalEventId?: string;
    actorId?: string;
    metadata?: Record<string, unknown>;
  };
};

type RefundSettlementResult = {
  applied: boolean;
  transactionStatus: 'SUCCEEDED' | 'FAILED' | 'REFUND_FAILED_NEEDS_ATTENTION';
  paymentStatus: PaymentStatus;
  bookingStatus?: BookingStatus;
};

settleVerifiedOutcome(input: RefundSettlementInput): Promise<RefundSettlementResult>;
```

## Preconditions

- The Refund Transaction and reservation already exist.
- The caller has obtained and verified the provider or administrative outcome.
- Input amount and currency match persisted transaction facts.
- Provider calls and retry decisions are complete or owned by the caller.

## Guarantees

- One database transaction owns transaction, ledger, Payment, obligation, Booking, payment-event, and audit writes.
- Duplicate and out-of-order delivery is idempotent.
- A successful transaction produces exactly one balanced reversal pair.
- Provenance affects audit metadata only.
- Settlement performs no Stripe/Duffel calls, retry scheduling, or authorization.

## Reservation operation

```ts
type ReserveRefundTransactionInput = {
  paymentId: string;
  cancellationRefundObligationId?: string;
  amount: number;
  currency: string;
  reason: string;
  triggerType: RefundTriggerType;
  actorId?: string;
  idempotencyKey: string;
};

reserveTransaction(input: ReserveRefundTransactionInput): Promise<RefundTransaction>;
```

The operation locks Payment then obligation, validates both capacities, and creates one transaction/idempotency record before any provider call.
