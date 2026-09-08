import type {
  AttestedFlightSearchMetaDto,
  AgentFlightMatchResultDto,
} from './attested-flight-search.dto';

export type { AttestedFlightSearchMetaDto, AgentFlightMatchResultDto };

export class FlightResultDto {
  airline!: string;
  flightNumber!: string;
  departureAirport!: string;
  arrivalAirport!: string;
  departureTime!: string; // ISO 8601 string
  arrivalTime!: string; // ISO 8601 string
  duration!: number; // minutes
  stops!: number;
  price!: number;
  currency!: string; // ISO 4217 code
  fareClass?: string | null;
  baggageAllowance?: string | null;
  matchResult?: AgentFlightMatchResultDto | null;
}

export class FlightSearchResponseDto {
  mode?: 'MATCHED' | 'RANKED';
  results!: FlightResultDto[];
  meta?: AttestedFlightSearchMetaDto;
}
