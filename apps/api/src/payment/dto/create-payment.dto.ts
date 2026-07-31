import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, Min, ValidateIf } from 'class-validator';

export class CreatePaymentDto {
  @IsString()
  bookingIntentId!: string;

  @ValidateIf(
    (dto: CreatePaymentDto) =>
      dto.ancillarySelectionId !== undefined || dto.ancillarySelectionVersion !== undefined,
  )
  @IsUUID()
  ancillarySelectionId?: string;

  @ValidateIf(
    (dto: CreatePaymentDto) =>
      dto.ancillarySelectionId !== undefined || dto.ancillarySelectionVersion !== undefined,
  )
  @IsInt()
  @Min(1)
  ancillarySelectionVersion?: number;

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
