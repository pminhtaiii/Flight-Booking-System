import { IsString, IsInt, Min, ValidateNested, IsObject } from 'class-validator';
import { Type } from 'class-transformer';

export class FlightSearchQueryDto {
  @IsString()
  origin!: string;

  @IsString()
  destination!: string;

  @IsString()
  date!: string;

  @IsInt()
  @Min(1)
  adults!: number;
}

export class AttestedFlightSearchDto {
  @IsString()
  chatSessionId!: string;

  @IsInt()
  @Min(1)
  proposedSnapshotVersion!: number;

  @IsObject()
  @ValidateNested()
  @Type(() => FlightSearchQueryDto)
  search!: FlightSearchQueryDto;
}
