import { Injectable } from '@nestjs/common';
import type { FlightSnapshot, PassengerSnapshot } from '@shared/booking-types';
import { OrderSnapshotNormalizer } from './order-snapshot.normalizer';
import { DuffelOrderAdapter } from './duffel-order.adapter';

export type DuffelRecoveredOrder = Awaited<ReturnType<DuffelOrderAdapter['retrieveOrder']>>;

@Injectable()
export class DuffelRecoveryService {
  constructor(
    private readonly orderAdapter: DuffelOrderAdapter,
    private readonly normalizer: OrderSnapshotNormalizer,
  ) {}

  retrieveOrder(orderId: string): Promise<DuffelRecoveredOrder> {
    return this.orderAdapter.retrieveOrder(orderId);
  }

  retrieveCompleteOrder(orderId: string): Promise<unknown> {
    return this.orderAdapter.retrieveCompleteOrder(orderId);
  }

  async recoverOrderSnapshots(orderId: string): Promise<{
    flightSnapshot: FlightSnapshot;
    passengerSnapshot: PassengerSnapshot;
  }> {
    const order = await this.retrieveCompleteOrder(orderId);
    return this.mapOrderToSnapshots(order);
  }

  mapOrderToSnapshots(order: unknown): {
    flightSnapshot: FlightSnapshot;
    passengerSnapshot: PassengerSnapshot;
  } {
    return this.normalizer.mapDuffelOrderToSnapshots(order);
  }
}
