import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  CancelOrderOutcome,
  CreateOrderInput,
  CreateOrderOutcome,
  FulfillmentGatewayPort,
  OrderSnapshotOutcome,
  PassengerEnrichmentInput,
  PersistedOrderEvidence,
  PortInvocationControl,
} from '@/payment-fulfillment/ports';
import { BoundedSemaphore } from '@/payment-fulfillment/utils/bounded-semaphore';
import { DuffelService } from './duffel.service';

@Injectable()
export class DuffelFulfillmentAdapter implements FulfillmentGatewayPort {
  private readonly logger = new Logger(DuffelFulfillmentAdapter.name);
  readonly semaphore: BoundedSemaphore;

  constructor(
    private readonly duffelService: DuffelService,
    @Optional() semaphore?: BoundedSemaphore,
  ) {
    if (semaphore) {
      this.semaphore = semaphore;
    } else {
      const activeLimit = process.env.DUFFEL_ADMISSION_ACTIVE_LIMIT
        ? Number.parseInt(process.env.DUFFEL_ADMISSION_ACTIVE_LIMIT, 10)
        : 10;
      const queueLimit = process.env.DUFFEL_ADMISSION_QUEUE_LIMIT
        ? Number.parseInt(process.env.DUFFEL_ADMISSION_QUEUE_LIMIT, 10)
        : 100;
      const timeoutMs = process.env.DUFFEL_ADMISSION_TIMEOUT_MS
        ? Number.parseInt(process.env.DUFFEL_ADMISSION_TIMEOUT_MS, 10)
        : 5000;

      this.semaphore = new BoundedSemaphore(activeLimit, queueLimit, timeoutMs);
    }
  }

  redactDuffelOrder(duffelOrder: unknown): PersistedOrderEvidence {
    if (!duffelOrder || typeof duffelOrder !== 'object') {
      return { id: '', bookingReference: undefined };
    }

    const orderCopy = JSON.parse(JSON.stringify(duffelOrder)) as Record<string, unknown>;

    if (Array.isArray(orderCopy.passengers)) {
      for (const passenger of orderCopy.passengers) {
        if (passenger && typeof passenger === 'object') {
          const p = passenger as Record<string, unknown>;
          p.email = 'REDACTED';
          p.born_on = 'REDACTED';
          p.given_name = 'REDACTED';
          p.family_name = 'REDACTED';
          p.phone_number = 'REDACTED';
        }
      }
    }

    const id = typeof orderCopy.id === 'string' ? orderCopy.id : '';
    const bookingReference =
      typeof orderCopy.booking_reference === 'string'
        ? orderCopy.booking_reference
        : typeof orderCopy.bookingReference === 'string'
          ? orderCopy.bookingReference
          : undefined;

    return {
      ...orderCopy,
      id,
      bookingReference,
    };
  }

  enrichRedactedDuffelOrder(
    duffelOrder: unknown,
    passengerEnrichment: PassengerEnrichmentInput[],
    contactEmail: string,
  ): unknown {
    if (!duffelOrder || typeof duffelOrder !== 'object') {
      return duffelOrder;
    }

    const cloned = JSON.parse(JSON.stringify(duffelOrder)) as Record<string, unknown>;

    if (Array.isArray(cloned.passengers)) {
      cloned.passengers = cloned.passengers.map((passenger, index) => {
        if (!passenger || typeof passenger !== 'object') {
          return passenger;
        }

        const p = { ...(passenger as Record<string, unknown>) };
        const matched =
          (p.id && typeof p.id === 'string'
            ? passengerEnrichment.find((pe) => pe.id === p.id)
            : undefined) ?? passengerEnrichment[index];

        if (matched) {
          const given =
            (matched as Record<string, unknown>).givenName ||
            (matched as Record<string, unknown>).given_name ||
            matched.firstName;
          if (typeof given === 'string') {
            p.given_name = given;
            p.givenName = given;
          }

          const family =
            (matched as Record<string, unknown>).familyName ||
            (matched as Record<string, unknown>).family_name ||
            matched.lastName;
          if (typeof family === 'string') {
            p.family_name = family;
            p.familyName = family;
          }

          const dob =
            (matched as Record<string, unknown>).born_on ||
            (matched as Record<string, unknown>).bornOn ||
            matched.dateOfBirth;
          if (dob instanceof Date) {
            p.born_on = dob.toISOString().split('T')[0];
          } else if (typeof dob === 'string') {
            p.born_on = dob.split('T')[0];
          }

          if (matched.title) {
            p.title = matched.title;
          }

          if (matched.email) {
            p.email = matched.email;
          }

          const phone =
            matched.phoneNumber || (matched as Record<string, unknown>).phone_number;
          if (typeof phone === 'string') {
            p.phone_number = phone;
          }
        }

        if (index === 0 && contactEmail && (!p.email || p.email === 'REDACTED')) {
          p.email = contactEmail;
        }

        return p;
      });
    }

    return cloned;
  }

  async createOrder(
    input: CreateOrderInput,
    control: PortInvocationControl,
  ): Promise<CreateOrderOutcome> {
    const release = await this.semaphore.acquire();
    try {
      await control.beforeInvoke();

      const services =
        input.services && input.services.length > 0
          ? input.services.map((s) => ({ id: s.serviceId, quantity: s.quantity }))
          : undefined;

      const metadata = {
        bookingIntentId: input.metadata.bookingIntentId,
        paymentId: input.metadata.paymentId,
      };

      const rawOrder = (await this.duffelService.createOrder(
        input.offerId,
        input.passengers as Parameters<DuffelService['createOrder']>[1],
        services,
        metadata,
        input.idempotencyKey,
      )) as Record<string, unknown>;

      const redactedEvidence = this.redactDuffelOrder(rawOrder);
      const orderId = typeof rawOrder?.id === 'string' ? rawOrder.id : '';
      const bookingReference =
        typeof rawOrder?.booking_reference === 'string'
          ? rawOrder.booking_reference
          : typeof rawOrder?.bookingReference === 'string'
            ? rawOrder.bookingReference
            : '';

      return {
        orderId,
        bookingReference,
        evidence: redactedEvidence,
      };
    } finally {
      release();
    }
  }

  async cancelOrder(
    orderId: string,
    control: PortInvocationControl,
  ): Promise<CancelOrderOutcome> {
    const release = await this.semaphore.acquire();
    try {
      await control.beforeInvoke();

      await this.duffelService.cancelOrder(orderId);

      return {
        success: true,
        orderId,
        status: 'CANCELLED',
      };
    } finally {
      release();
    }
  }

  async retrieveOrderSnapshot(
    orderId: string,
    fallbackEvidence: PersistedOrderEvidence,
    passengerEnrichment: PassengerEnrichmentInput[],
    contactEmail: string,
    control: PortInvocationControl,
  ): Promise<OrderSnapshotOutcome> {
    const release = await this.semaphore.acquire();
    try {
      await control.beforeInvoke();

      let completeOrder: unknown;
      try {
        completeOrder = await this.duffelService.retrieveCompleteOrder(orderId);
      } catch (err: unknown) {
        this.logger.warn(
          `Failed to retrieve complete Duffel order ${orderId}, falling back to enrichment: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        completeOrder = this.enrichRedactedDuffelOrder(
          fallbackEvidence,
          passengerEnrichment,
          contactEmail,
        );
      }

      const snaps = this.duffelService.mapDuffelOrderToSnapshots(completeOrder);
      const departureAtStr = snaps.flightSnapshot?.segments?.[0]?.departureAt;
      const departureAt = departureAtStr ? new Date(departureAtStr) : undefined;

      return {
        flightSnapshot: snaps.flightSnapshot,
        passengerSnapshot: snaps.passengerSnapshot,
        departureAt,
      };
    } finally {
      release();
    }
  }
}
