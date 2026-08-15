import { IsString, IsInt, Min, ValidateNested, IsObject } from 'class-validator';
import { Type } from 'class-transformer';
import { FlightSearchQueryDto } from './flight-search-query.dto';

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
