import { IsUUID, IsString, IsOptional, IsBoolean } from 'class-validator';

export class CreatePaymentDto {
  @IsUUID()
  bookingIntentId!: string;

  @IsOptional()
  @IsString()
  paymentMethodId?: string;

  @IsOptional()
  @IsBoolean()
  saveCard?: boolean;
}
