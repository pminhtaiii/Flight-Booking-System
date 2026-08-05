import { IsString, IsUUID } from 'class-validator';

export class ConfirmPaymentDto {
  @IsUUID('4')
  bookingId!: string;

  @IsString()
  paymentId!: string;
}
