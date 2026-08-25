export class ChatHandoffDisplayDto {
  airline?: string;
  origin?: string;
  destination?: string;
  departureAt?: string;
  arrivalAt?: string;
  price?: string;
  currency?: string;
}

export class ChatHandoffResponseDto {
  token!: string;
  handoffToken!: string;
  expiresAt!: string;
  display?: ChatHandoffDisplayDto;
}
