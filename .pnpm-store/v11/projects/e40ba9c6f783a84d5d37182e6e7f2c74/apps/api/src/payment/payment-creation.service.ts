import { Injectable } from '@nestjs/common';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { PaymentResponseDto } from './dto/payment-response.dto';

/** Owns the boundary for the create-and-authorize payment workflow. */
@Injectable()
export class PaymentCreationService {
  createPayment(
    execute: () => Promise<PaymentResponseDto>,
    _dto: CreatePaymentDto,
  ): Promise<PaymentResponseDto> {
    return execute();
  }
}
