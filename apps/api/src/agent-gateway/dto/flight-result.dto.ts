export class FlightResultDto {
  airline!: string;
  flightNumber!: string;
  departureAirport!: string;
  arrivalAirport!: string;
  departureTime!: string; // ISO 8601 string
  arrivalTime!: string;   // ISO 8601 string
  duration!: number;      // minutes
  stops!: number;
  price!: number;
  currency!: string;      // ISO 4217 code
  fareClass?: string | null;
  baggageAllowance?: string | null;
}

export class FlightSearchResponseDto {
  results!: FlightResultDto[];
}
