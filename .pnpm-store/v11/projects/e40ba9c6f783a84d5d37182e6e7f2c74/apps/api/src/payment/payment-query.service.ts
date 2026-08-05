import { Injectable } from '@nestjs/common';

/** Owns read-only payment status queries. */
@Injectable()
export class PaymentQueryService {
  getPaymentStatus(execute: () => Promise<unknown>, _paymentId: string, _userId: string): Promise<unknown> {
    return execute();
  }
}
