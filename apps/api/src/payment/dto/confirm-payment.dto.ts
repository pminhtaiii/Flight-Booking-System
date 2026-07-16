import { IsString } from 'class-validator';

export class ConfirmPaymentDto {
  @IsString()
  paymentId!: string;
}
