export class BookingResultDto {
  id!: string;
  airline!: string;
  flightNumber!: string;
  origin!: string;
  destination!: string;
  departureTime!: string; // ISO 8601
  arrivalTime!: string;   // ISO 8601
  duration!: number;
  stops!: number;
  fareClass?: string | null;
  price!: number;
  currency!: string;
  passengers!: number;
  baggageAllowance?: string | null;
  status!: 'CONFIRMED' | 'PENDING' | 'CANCELLED' | 'REFUNDED';
}

export class UserBookingsResponseDto {
  bookings!: BookingResultDto[];
}
