# Quickstart: Cancellation & Refund Recovery

## Prerequisites

- Docker services are running (`docker compose up -d`).
- The Feature 10 payment/refund and Feature 11 booking migrations are applied.
- Duffel and Stripe test credentials are configured.

## Validation scenarios

1. A booking before its stored cancellation deadline returns a supplier quote;
   the UI shows the exact quoted airline/customer refund amount and expiry.
2. Confirming the quote changes the booking to `CANCELLATION_PENDING`, cancels
   Duffel first, and then records a Stripe refund. A successful webhook leaves
   it `CANCELLED`.
3. Make Stripe return transient errors. Verify inline attempts, a persisted due
   retry, worker CAS ownership, and the same idempotency key on every attempt.
4. Make Stripe return a deterministic error or age the key past 22 hours.
   Verify `REFUND_FAILED_NEEDS_ATTENTION`, an audit record, notification, and
   no further automatic refund attempt.
5. Start two cancellation requests and one worker run concurrently. Verify only
   one supplier cancellation and one Stripe refund are made.
6. Simulate a process crash after Duffel succeeds. On recovery, verify Duffel is
   checked first and the system proceeds straight to refund without recancelling.

## Automated checks

```bash
npm run test:e2e --workspace=apps/api
npx playwright test --config=apps/web/tests/playwright.config.ts
```
