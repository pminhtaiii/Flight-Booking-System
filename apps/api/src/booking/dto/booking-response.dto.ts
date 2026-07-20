import { BookingFailureReason, BookingStatus, Prisma } from '@prisma/client';

export class BookingListItemResponseDto {
  id!: string;
  status!: BookingStatus;
  failureReason!: BookingFailureReason | null;
  pnrReference!: string | null;
  totalAmount!: string;
  currency!: string;
  departureAt!: string | null;
  flightSnapshot!: Prisma.JsonValue | null;
  createdAt!: string;
}

export class BookingListResponseDto {
  bookings!: BookingListItemResponseDto[];
  pagination!: { page: number; limit: number; total: number; totalPages: number };
}

export class BookingDetailResponseDto extends BookingListItemResponseDto {
  duffelOrderId!: string | null;
  passengerSnapshot!: Prisma.JsonValue | null;
  payment!: { id: string; status: string; stripePaymentIntentId: string } | null;
  bookingIntent!: { id: string; offerId: string };
  updatedAt!: string;
}
