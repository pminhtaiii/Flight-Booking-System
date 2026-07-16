export type PaymentStatus =
  | 'CREATED'
  | 'AUTHORIZED'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'REFUND_PENDING'
  | 'PARTIALLY_REFUNDED'
  | 'REFUNDED'
  | 'DISPUTED'
  | 'CHARGEBACK_LOST';

export type RefundStatus =
  | 'REFUND_PENDING'
  | 'SUCCEEDED'
  | 'FAILED';

export type RefundTriggerType =
  | 'ADMIN'
  | 'SYSTEM_AUTOMATED';

export type LedgerEntryType =
  | 'DEBIT'
  | 'CREDIT';

export type PaymentEventSource =
  | 'WEBHOOK'
  | 'API'
  | 'CRON'
  | 'SYSTEM';

export type Payment = {
  id: string;
  bookingIntentId: string;
  attemptNumber: number;
  idempotencyKeyId: string;
  stripePaymentIntentId: string;
  stripeCustomerId?: string | null;
  amount: number;
  currency: string;
  paymentMethodType?: string | null;
  status: PaymentStatus;
  preDisputeStatus?: PaymentStatus | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};
