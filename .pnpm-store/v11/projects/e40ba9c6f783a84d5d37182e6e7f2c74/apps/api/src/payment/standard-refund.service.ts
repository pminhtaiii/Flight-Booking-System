import { Injectable } from '@nestjs/common';

/** Owns standard and webhook-originated refund workflows. */
@Injectable()
export class StandardRefundService {
  execute<T>(workflow: () => Promise<T>): Promise<T> {
    return workflow();
  }
}
