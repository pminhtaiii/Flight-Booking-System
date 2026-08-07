import { IsString, IsNumber, IsObject, ValidateNested, IsUUID, IsNotEmpty } from 'class-validator';
import { Type } from 'class-transformer';

export class FlightSearchQueryDto {
  @IsString()
  @IsNotEmpty()
  origin: string;

  @IsString()
  @IsNotEmpty()
  destination: string;

  @IsString()
  @IsNotEmpty()
  date: string;

  @IsNumber()
  adults: number;
}

export class AttestedFlightSearchDto {
  @IsUUID()
  chatSessionId: string;

  @IsNumber()
  proposedSnapshotVersion: number;

  @IsObject()
  @ValidateNested()
  @Type(() => FlightSearchQueryDto)
  search: FlightSearchQueryDto;
}
