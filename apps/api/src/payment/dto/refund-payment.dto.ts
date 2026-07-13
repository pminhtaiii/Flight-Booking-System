import { IsInt, IsPositive, IsString, IsNotEmpty } from 'class-validator';

export class RefundPaymentDto {
  @IsInt()
  @IsPositive()
  amount!: number;

  @IsString()
  @IsNotEmpty()
  reason!: string;
}
