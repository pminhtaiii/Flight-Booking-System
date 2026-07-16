import { IsString } from 'class-validator';

export class PaymentResponseDto {
  @IsString()
  paymentId!: string;

  @IsString()
  clientSecret!: string;

  @IsString()
  status!: string;
}
