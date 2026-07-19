import { IsInt, Min, IsOptional, IsString } from 'class-validator';

export class RefundPaymentDto {
  @IsInt()
  @Min(1)
  amount!: number; // in cents

  @IsOptional()
  @IsString()
  reason?: string;
}
