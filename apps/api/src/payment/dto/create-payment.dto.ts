import { IsBoolean, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class CreatePaymentDto {
  @IsString()
  bookingIntentId!: string;

  @IsOptional()
  @IsString()
  ancillarySelectionId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  ancillarySelectionVersion?: number;

  @IsOptional()
  @IsString()
  paymentMethodId?: string;

  @IsOptional()
  @IsBoolean()
  saveCard?: boolean;
}
