export class BookingIntentFlightDto {
  origin!: string;
  destination!: string;
  departureDate!: string;
  returnDate!: string | null;
  cabinClass!: string;
  adults?: number;
  children?: number;
  infants?: number;
}

export class BookingIntentCreationPassengerDto {
  id!: string;
  type!: string;
  givenName!: string;
  familyName!: string;
  dateOfBirth!: string;
  gender!: string;
  nationality!: string | null;
  preFilledFromProfile!: boolean;
}

export class BookingIntentPassengerDetailDto extends BookingIntentCreationPassengerDto {
  passportNumber!: string | null;
  passportExpiry!: string | null;
}

export class CreateBookingIntentResponseDto {
  intentId!: string;
  status!: string;
  originalPrice!: number;
  confirmedPrice!: number;
  priceChanged!: boolean;
  currency!: string;
  pricedAt!: string;
  intentExpiresAt!: string;
  offerExpiresAt!: string | null;
  passengers!: BookingIntentCreationPassengerDto[];
  flight!: BookingIntentFlightDto;
}

export class GetBookingIntentResponseDto {
  intentId!: string;
  status!: string;
  originalPrice!: number;
  confirmedPrice!: number;
  priceChanged!: boolean;
  currency!: string;
  pricedAt!: string;
  intentExpiresAt!: string;
  offerExpiresAt!: string | null;
  createdAt!: string;
  passengers!: BookingIntentPassengerDetailDto[];
  flight!: BookingIntentFlightDto;
}

export class BookingIntentPrefillPassengerDto {
  givenName!: string | null;
  familyName!: string | null;
  dateOfBirth!: string | null;
  gender!: string | null;
  nationality!: string | null;
  passportNumber!: string | null;
  passportExpiry!: string | null;
  seatPreference!: string | null;
  classPreference!: string | null;
}

export class BookingIntentPrefillResponseDto {
  hasProfile!: boolean;
  passenger!: BookingIntentPrefillPassengerDto | null;
  missingFields!: string[];
}
