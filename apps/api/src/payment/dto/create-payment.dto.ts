import { IsString, IsOptional, IsBoolean, IsInt } from 'class-validator';

export class CreatePaymentDto {
  @IsString()
  bookingIntentId!: string;

  @IsOptional()
  @IsString()
  paymentMethodId?: string;

  @IsOptional()
  @IsBoolean()
  saveCard?: boolean;

  @IsOptional()
  @IsString()
  ancillarySelectionId?: string;

  @IsOptional()
  @IsInt()
  ancillarySelectionVersion?: number;
}
