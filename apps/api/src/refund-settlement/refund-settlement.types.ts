import { PaymentStatus, BookingStatus } from '@prisma/client';

export type RefundProvenanceSource = 'INLINE' | 'WEBHOOK' | 'CRON' | 'ADMIN';

export type RefundProvenance = {
  source: RefundProvenanceSource;
  externalEventId?: string;
  actorId?: string;
  traceId?: string;
  correlationId?: string;
  metadata?: Record<string, unknown>;
};

export type RefundSettlementOutcome =
  | { status: 'SUCCEEDED'; providerReference: string; occurredAt: string }
  | { status: 'FAILED'; errorCode: string; occurredAt: string };

export type RefundSettlementInput = {
  transactionId: string;
  money: { amount: number; currency: string };
  outcome: RefundSettlementOutcome;
  provenance: RefundProvenance;
};

export type RefundSettlementResult = {
  applied: boolean;
  transactionStatus: 'SUCCEEDED' | 'FAILED' | 'REFUND_FAILED_NEEDS_ATTENTION';
  paymentStatus: PaymentStatus;
  bookingStatus?: BookingStatus;
};
