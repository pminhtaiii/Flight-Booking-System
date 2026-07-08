import { FlightSegmentDto } from './search-flight.dto';

export class FlightConditionChangeBeforeDepartureDto {
  allowed!: boolean;
  penaltyAmount!: string | null;
  penaltyCurrency!: string | null;
}

export class FlightConditionsDto {
  refundable!: boolean;
  changeable!: boolean;
  changeBeforeDeparture!: FlightConditionChangeBeforeDepartureDto | null;
}

export class FlightDetailResponseDto {
  id!: string;
  airline!: string;
  flightNumber!: string;
  departureAirport!: string;
  arrivalAirport!: string;
  departureTime!: string;
  arrivalTime!: string;
  duration!: number;
  stops!: number;
  originalPrice!: number;
  confirmedPrice!: number;
  priceChanged!: boolean;
  currency!: string;
  fareClass!: string | null;
  baggageAllowance!: string | null;
  segments!: FlightSegmentDto[];
  returnSegments!: FlightSegmentDto[] | null;
  expiresAt!: string;
  conditions!: FlightConditionsDto;
}
