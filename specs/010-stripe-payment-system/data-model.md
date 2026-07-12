# Data Model: Stripe Payment System

**Feature**: 010-stripe-payment-system | **Date**: 2026-07-12

---

## New Enums

### `PaymentStatus`

```prisma
enum PaymentStatus {
  CREATED
  AUTHORIZED
  SUCCEEDED
  FAILED
  EXPIRED
  CANCELLED
  REFUND_PENDING
  PARTIALLY_REFUNDED
  REFUNDED
  DISPUTED
  CHARGEBACK_LOST
}
```

### `RefundStatus`

```prisma
enum RefundStatus {
  REFUND_PENDING
  SUCCEEDED
  FAILED
}
```

### `RefundTriggerType`

```prisma
enum RefundTriggerType {
  ADMIN
  SYSTEM_AUTOMATED
}
```

### `LedgerEntryType`

```prisma
enum LedgerEntryType {
  DEBIT
  CREDIT
}
```

### `PaymentEventSource`

```prisma
enum PaymentEventSource {
  WEBHOOK
  API
  CRON
  SYSTEM
}
```

---

## Extended Enums (existing)

### `BookingIntentStatus` (add new values)

```prisma
enum BookingIntentStatus {
  PENDING           // existing
  EXPIRED           // existing
  COMPLETED         // existing — now also used for: payment captured, PNR created
  AWAITING_PAYMENT  // NEW — intent is valid, waiting for payment
  PAYMENT_EXHAUSTED // NEW — 2 attempts failed, no more allowed
  CANCELLED         // NEW — explicitly cancelled
}
```

---

## New Models

### `Payment`

```prisma
model Payment {
  id                     String         @id @default(uuid())
  bookingIntentId        String
  bookingIntent          BookingIntent  @relation(fields: [bookingIntentId], references: [id])
  attemptNumber          Int            // 1 or 2 (Database-level CHECK constraint attemptNumber IN (1, 2) enforced in migration)
  idempotencyKeyId       String
  idempotencyKey         IdempotencyKey @relation(fields: [idempotencyKeyId], references: [id])
  stripePaymentIntentId  String         @unique
  stripeCustomerId       String?
  amount                 Int            // smallest currency unit (cents)
  currency               String         // ISO 4217 (e.g., "usd")
  paymentMethodType      String?        // e.g., "card"
  status                 PaymentStatus  @default(CREATED)
  preDisputeStatus       PaymentStatus? // populated when entering DISPUTED
  version                Int            @default(0) // optimistic locking
  createdAt              DateTime       @default(now())
  updatedAt              DateTime       @updatedAt

  paymentEvents          PaymentEvent[]
  ledgerEntries          LedgerEntry[]
  refunds                Refund[]

  @@unique([bookingIntentId, attemptNumber])
  @@index([stripeCustomerId])
  @@index([status])
}
```

### `IdempotencyKey`

```prisma
model IdempotencyKey {
  id             String    @id @default(uuid())
  key            String    @unique
  requestHash    String    // SHA-256 of request body — catches key reuse with different payload
  customerId     String
  customer       User      @relation(fields: [customerId], references: [id])
  requestPath    String    // API endpoint path
  requestParams  Json?     // request body snapshot
  responseCode   Int?      // HTTP status code of cached response
  responseBody   Json?     // cached response for replay
  recoveryPoint  String    @default("started") // started → stripe_authorized → duffel_order_created → captured → completed
  lockedAt       DateTime? // claim mechanism for pessimistic lock
  createdAt      DateTime  @default(now())
  expiresAt      DateTime

  payments       Payment[]
  refunds        Refund[]

  @@index([customerId])
  @@index([expiresAt])
}
```

### `PaymentEvent` (immutable audit log)

```prisma
model PaymentEvent {
  id              BigInt             @id @default(autoincrement())
  paymentId       String
  payment         Payment            @relation(fields: [paymentId], references: [id])
  eventType       String             // e.g., "payment_intent.succeeded", "refund.created"
  previousStatus  PaymentStatus      // NOTE: for the first event (creation), use self-transition: previousStatus = CREATED
  newStatus       PaymentStatus
  amount          Int?               // amount involved in this event
  source          PaymentEventSource // WEBHOOK, API, CRON, SYSTEM
  stripeEventId   String?            @unique // webhook deduplication — nullable for non-webhook events
  metadata        Json?              // raw payload
  createdAt       DateTime           @default(now())
  createdBy       String             // user ID, "system", or service name

  @@index([paymentId, createdAt])
  @@index([eventType])
}
```

### `LedgerEntry` (double-entry bookkeeping)

```prisma
model LedgerEntry {
  id              String          @id @default(uuid())
  paymentId       String
  payment         Payment         @relation(fields: [paymentId], references: [id])
  transactionId   String          // groups paired debit/credit rows
  accountId       String          // CUSTOMER_RECEIVABLE | PLATFORM_REVENUE | DUFFEL_COST
  entryType       LedgerEntryType // DEBIT or CREDIT
  amount          Int             // smallest currency unit
  currency        String          // ISO 4217
  createdAt       DateTime        @default(now())

  @@index([paymentId])
  @@index([transactionId])
  @@index([accountId])
}
```

### `Refund`

```prisma
model Refund {
  id                  String            @id @default(uuid())
  paymentId           String
  payment             Payment           @relation(fields: [paymentId], references: [id])
  idempotencyKeyId    String
  idempotencyKey      IdempotencyKey    @relation(fields: [idempotencyKeyId], references: [id])
  stripeRefundId      String?           @unique
  amount              Int               // smallest currency unit
  currency            String            // ISO 4217
  reason              String?
  triggerType         RefundTriggerType // ADMIN or SYSTEM_AUTOMATED
  triggeredByUserId   String?           // NULL for automated refunds
  triggeredByUser     User?             @relation(fields: [triggeredByUserId], references: [id])
  requiresReview      Boolean           @default(false) // flags automated refunds for 24h human check
  status              RefundStatus      @default(REFUND_PENDING)
  createdAt           DateTime          @default(now())
  updatedAt           DateTime          @updatedAt

  @@index([paymentId])
  @@index([status])
}
```

### `PaymentMethod`

```prisma
model PaymentMethod {
  id                     String   @id @default(uuid())
  stripeCustomerId       String
  stripePaymentMethodId  String   @unique
  cardBrand              String?  // visa, mastercard, etc.
  cardLast4              String?  // last 4 digits for display
  userId                 String
  user                   User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  isDefault              Boolean  @default(false)
  savedWithConsent       Boolean  @default(false) // only set to true through validated saveCard opt-in path
  createdAt              DateTime @default(now())

  status                 PaymentMethodStatus @default(ACTIVE)
  expMonth               Int?
  expYear                Int?

  @@index([stripeCustomerId])
  @@index([userId])
}

enum PaymentMethodStatus {
  ACTIVE
  DETACHED
  EXPIRED
}

// NOTE: Add partial unique index via raw SQL migration:
// CREATE UNIQUE INDEX idx_one_default_per_user ON "payment_methods" ("userId") WHERE "isDefault" = true;
```

---

## Modified Models

### `User` (add fields)

```prisma
model User {
  // ... existing fields ...
  stripeCustomerId    String?           @unique // nullable, populated at first payment
  // ... existing relations ...
  idempotencyKeys     IdempotencyKey[]  // NEW relation
  refundsTriggered    Refund[]          // NEW relation
  paymentMethods      PaymentMethod[]   // NEW relation
}
```

### `BookingIntent` (add payment fields)

```prisma
model BookingIntent {
  // ... existing fields ...
  paymentAttemptCount  Int              @default(0) // max 2
  // status enum extended with AWAITING_PAYMENT, PAYMENT_EXHAUSTED, CANCELLED (COMPLETED already exists as terminal state)
  // ... existing relations ...
  payments             Payment[]        // NEW relation (max 2)
}
```

---

## State Machine Transitions (enforced in application layer)

```
CREATED → AUTHORIZED
CREATED → FAILED (terminal)
CREATED → CANCELLED

AUTHORIZED → SUCCEEDED (capture after Duffel confirms)
AUTHORIZED → EXPIRED (hold timed out)
AUTHORIZED → CANCELLED (voided)

SUCCEEDED → REFUND_PENDING
SUCCEEDED → DISPUTED

REFUND_PENDING → PARTIALLY_REFUNDED
REFUND_PENDING → REFUNDED

PARTIALLY_REFUNDED → REFUND_PENDING (another refund cycle)
PARTIALLY_REFUNDED → DISPUTED

REFUNDED → DISPUTED

DISPUTED → [pre_dispute_status] (dispute won — returns to state before dispute)
DISPUTED → CHARGEBACK_LOST (dispute lost)
```

---

## Recovery Point → Payment Status Mapping

| Recovery Point | Payment Status | Description |
|---------------|---------------|-------------|
| `started` | `CREATED` | PaymentIntent created, pipeline starting |
| `stripe_authorized` | `AUTHORIZED` | Card authorized, funds held |
| `duffel_order_created` | `AUTHORIZED` | Duffel PNR confirmed, capture not yet done |
| `captured` | `SUCCEEDED` | Stripe capture confirmed |
| `completed` | `SUCCEEDED` | All post-capture steps done (ledger, audit) |

> **CRITICAL CONSTRAINT:** `recoveryPoint` and `Payment.status` MUST be written in the same DB transaction. A mismatch between them is an invariant violation, not a valid intermediate state.

---

## V1 Chart of Accounts (ledger_entries.account_id)

| Account ID | Purpose |
|------------|---------|
| `CUSTOMER_RECEIVABLE` | Money owed by/to the customer |
| `PLATFORM_REVENUE` | Platform's revenue from bookings |
| `DUFFEL_COST` | What the platform owes Duffel for the ticket |

> **CRITICAL CONSTRAINT:** `LedgerEntry` rows MUST be written in the same transaction as the triggering Payment or Refund state change. SUM(debits) must equal SUM(credits) per transactionId at all times.

---

## Relationship to Existing Models

```
User (1) ─── (N) BookingIntent (1) ─── (0..2) Payment (1) ─── (N) PaymentEvent
                                                        (1) ─── (N) LedgerEntry
                                                        (1) ─── (N) Refund
User (1) ─── (N) IdempotencyKey
User (1) ─── (0..1) stripeCustomerId
```
