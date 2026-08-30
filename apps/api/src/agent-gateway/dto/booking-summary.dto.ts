import { Type } from 'class-transformer';
import { IsArray, IsISO8601, IsInt, IsString, Min, ValidateNested } from 'class-validator';

export class BookingSummaryDto {
  @IsString()
  bookingReference!: string;

  @IsString()
  airline!: string;

  @IsString()
  origin!: string;

  @IsString()
  destination!: string;

  @IsISO8601()
  departureTime!: string;

  @IsISO8601()
  arrivalTime!: string;

  @IsString()
  status!: string;

  @IsInt()
  @Min(0)
  durationMinutes!: number;

  @IsInt()
  @Min(0)
  stops!: number;
}

export class BookingSummariesResponseDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BookingSummaryDto)
  bookings!: BookingSummaryDto[];
}
