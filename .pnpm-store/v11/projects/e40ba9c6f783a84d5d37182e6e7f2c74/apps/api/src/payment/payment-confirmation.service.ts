import { Injectable } from '@nestjs/common';
import { ConfirmPaymentDto } from './dto/confirm-payment.dto';

/** Owns the confirm-and-capture workflow boundary. */
@Injectable()
export class PaymentConfirmationService {
  confirmPayment(execute: () => Promise<unknown>, _dto: ConfirmPaymentDto): Promise<unknown> {
    return execute();
  }

  executeConfirmPayment(execute: () => Promise<unknown>, _dto: ConfirmPaymentDto): Promise<unknown> {
    return execute();
  }
}
