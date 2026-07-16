import { IsString, IsOptional, IsBoolean } from 'class-validator';

export class CreatePaymentDto {
  @IsString()
  bookingIntentId!: string;

  @IsOptional()
  @IsString()
  paymentMethodId?: string;

  @IsOptional()
  @IsBoolean()
  saveCard?: boolean;
}
