import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { BookingSummaryDto } from './booking-summary.dto';

export class BookingDetailDto extends BookingSummaryDto {
  @IsOptional()
  @IsString()
  flightNumber?: string | null;

  @IsOptional()
  @IsString()
  baggageAllowance?: string | null;

  @IsOptional()
  @IsBoolean()
  changeable?: boolean | null;

  @IsOptional()
  @IsBoolean()
  refundable?: boolean | null;
}
