import { Injectable } from '@nestjs/common';

/** Owns cancellation refund processing, recovery, and escalation workflows. */
@Injectable()
export class CancellationRefundService {
  execute<T>(workflow: () => Promise<T>): Promise<T> {
    return workflow();
  }
}
