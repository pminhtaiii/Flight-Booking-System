import { BookingStatus, RefundStatus } from '@prisma/client';

export class CancellationStatusResponseDto {
  bookingId!: string;
  bookingStatus!: BookingStatus;
  cancellationDeadline!: string | null;
  airlineRefundAmount!: string | null;
  customerRefundAmount!: string | null;
  duffelCancellationQuoteId!: string | null;
  refundStatus!: RefundStatus | null;
  retryCount!: number | null;
  nextRetryAt!: string | null;
  lastErrorCode!: string | null;
  escalationMessage!: string | null;
}
