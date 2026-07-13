import { PaymentStatus, BookingIntentStatus } from '@prisma/client';

export class CreatePaymentResponseDto {
  paymentId!: string;
  stripeClientSecret!: string | null;
  attemptNumber!: number;
  amount!: number;
  currency!: string;
  status!: PaymentStatus;
  requiresAction!: boolean;
}

export class ConfirmPaymentResponseDto {
  paymentId!: string;
  status!: PaymentStatus;
  bookingIntentStatus!: BookingIntentStatus;
  pnrReference?: string;
}

export class AsyncConfirmPaymentResponseDto {
  paymentId!: string;
  status!: PaymentStatus;
  message!: string;
  pollUrl!: string;
}

