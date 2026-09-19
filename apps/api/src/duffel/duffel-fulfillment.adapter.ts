import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  CancelOrderOutcome,
  CreateOrderInput,
  CreateOrderOutcome,
  FulfillmentGatewayPort,
  OrderSnapshotOutcome,
  PassengerEnrichmentInput,
  PersistedOrderEvidence,
  PersistedOrderCarrier,
  PersistedOrderLocation,
  PersistedOrderPassenger,
  PersistedOrderSegment,
  PersistedOrderSegmentPassenger,
  PersistedOrderSlice,
  PortInvocationControl,
} from '@/payment-fulfillment/ports';
import {
  BoundedSemaphore,
  parsePositiveIntegerSetting,
} from '@/payment-fulfillment/utils/bounded-semaphore';
import { DuffelService } from './duffel.service';

type UnknownRecord = Record<string, unknown>;

type EnrichmentRecord = PassengerEnrichmentInput & {
  givenName?: string;
  familyName?: string;
  given_name?: string;
  family_name?: string;
  bornOn?: string | Date;
  born_on?: string;
  phone_number?: string;
};

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function readString(record: UnknownRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readNullableString(record: UnknownRecord, key: string): string | null | undefined {
  if (!(key in record)) {
    return undefined;
  }
  const value = record[key];
  return value === null ? null : typeof value === 'string' ? value : undefined;
}

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
      const activeLimit = parsePositiveIntegerSetting(
        process.env.DUFFEL_ADMISSION_ACTIVE_LIMIT,
        10,
        'DUFFEL_ADMISSION_ACTIVE_LIMIT',
      );
      const queueLimit = parsePositiveIntegerSetting(
        process.env.DUFFEL_ADMISSION_QUEUE_LIMIT,
        100,
        'DUFFEL_ADMISSION_QUEUE_LIMIT',
      );
      const timeoutMs = parsePositiveIntegerSetting(
        process.env.DUFFEL_ADMISSION_TIMEOUT_MS,
        5000,
        'DUFFEL_ADMISSION_TIMEOUT_MS',
      );

      this.semaphore = new BoundedSemaphore(activeLimit, queueLimit, timeoutMs);
    }
  }

  redactDuffelOrder(duffelOrder: unknown): PersistedOrderEvidence {
    const order = asRecord(duffelOrder);
    if (!order) {
      return { id: '' };
    }

    const evidence: PersistedOrderEvidence = {
      id: readString(order, 'id') ?? '',
    };
    const bookingReference =
      readString(order, 'booking_reference') ?? readString(order, 'bookingReference');

    if (bookingReference !== undefined) {
      evidence.bookingReference = bookingReference;
      // Keep the legacy key for recovery code and existing payment events.
      evidence.booking_reference = bookingReference;
    }

    if (Array.isArray(order.slices)) {
      evidence.slices = order.slices
        .map((slice) => this.toPersistedSlice(slice))
        .filter((slice): slice is PersistedOrderSlice => slice !== undefined);
    }

    if (Array.isArray(order.passengers)) {
      evidence.passengers = order.passengers
        .map((passenger) => this.toPersistedPassenger(passenger))
        .filter((passenger): passenger is PersistedOrderPassenger => passenger !== undefined);
    }

    return evidence;
  }

  enrichRedactedDuffelOrder(
    duffelOrder: unknown,
    passengerEnrichment: PassengerEnrichmentInput[],
    contactEmail: string,
  ): unknown {
    const cloned = this.redactDuffelOrder(duffelOrder);

    if (Array.isArray(cloned.passengers)) {
      cloned.passengers = cloned.passengers.map((passenger, index) => {
        const p: PersistedOrderPassenger = { ...passenger };
        const matched =
          passengerEnrichment.find((pe) => pe.id === p.id) ?? passengerEnrichment[index];

        if (matched) {
          const enrichment = matched as EnrichmentRecord;
          const given = enrichment.givenName || enrichment.given_name || matched.firstName;
          if (typeof given === 'string') {
            p.given_name = given;
          }

          const family = enrichment.familyName || enrichment.family_name || matched.lastName;
          if (typeof family === 'string') {
            p.family_name = family;
          }

          const dob = enrichment.born_on || enrichment.bornOn || matched.dateOfBirth;
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

          const phone = matched.phoneNumber || enrichment.phone_number;
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

  private toPersistedSlice(value: unknown): PersistedOrderSlice | undefined {
    const source = asRecord(value);
    if (!source) return undefined;

    const slice: PersistedOrderSlice = {};
    const duration = readString(source, 'duration');
    if (duration !== undefined) slice.duration = duration;

    if (Array.isArray(source.segments)) {
      slice.segments = source.segments
        .map((segment) => this.toPersistedSegment(segment))
        .filter((segment): segment is PersistedOrderSegment => segment !== undefined);
    }

    return slice;
  }

  private toPersistedSegment(value: unknown): PersistedOrderSegment | undefined {
    const source = asRecord(value);
    if (!source) return undefined;

    const segment: PersistedOrderSegment = {};
    for (const field of [
      'id',
      'duration',
      'departing_at',
      'arriving_at',
      'marketing_carrier_flight_number',
    ] as const) {
      const valueAtField = readString(source, field);
      if (valueAtField !== undefined) segment[field] = valueAtField;
    }

    for (const field of ['origin_terminal', 'destination_terminal'] as const) {
      const valueAtField = readNullableString(source, field);
      if (valueAtField !== undefined) segment[field] = valueAtField;
    }

    const origin = this.toPersistedLocation(source.origin);
    if (origin) segment.origin = origin;
    const destination = this.toPersistedLocation(source.destination);
    if (destination) segment.destination = destination;

    const operatingCarrier = this.toPersistedCarrier(source.operating_carrier);
    if (operatingCarrier) segment.operating_carrier = operatingCarrier;
    const marketingCarrier = this.toPersistedCarrier(source.marketing_carrier);
    if (marketingCarrier) segment.marketing_carrier = marketingCarrier;

    const aircraft = asRecord(source.aircraft);
    const aircraftName = aircraft ? readString(aircraft, 'name') : undefined;
    if (aircraftName !== undefined) segment.aircraft = { name: aircraftName };

    if (Array.isArray(source.passengers)) {
      segment.passengers = source.passengers
        .map((passenger) => this.toPersistedSegmentPassenger(passenger))
        .filter(
          (passenger): passenger is PersistedOrderSegmentPassenger => passenger !== undefined,
        );
    }

    return segment;
  }

  private toPersistedLocation(value: unknown): PersistedOrderLocation | undefined {
    const source = asRecord(value);
    if (!source) return undefined;

    const location: PersistedOrderLocation = {};
    for (const field of ['iata_code', 'name', 'city_name'] as const) {
      const valueAtField = readString(source, field);
      if (valueAtField !== undefined) location[field] = valueAtField;
    }

    const city = asRecord(source.city);
    const cityName = city ? readString(city, 'name') : undefined;
    if (cityName !== undefined) location.city = { name: cityName };

    return Object.keys(location).length > 0 ? location : undefined;
  }

  private toPersistedCarrier(value: unknown): PersistedOrderCarrier | undefined {
    const source = asRecord(value);
    if (!source) return undefined;

    const carrier: PersistedOrderCarrier = {};
    for (const field of ['iata_code', 'name'] as const) {
      const valueAtField = readString(source, field);
      if (valueAtField !== undefined) carrier[field] = valueAtField;
    }

    return Object.keys(carrier).length > 0 ? carrier : undefined;
  }

  private toPersistedSegmentPassenger(
    value: unknown,
  ): PersistedOrderSegmentPassenger | undefined {
    const source = asRecord(value);
    if (!source) return undefined;
    const cabinClass = readString(source, 'cabin_class');
    return cabinClass === undefined ? {} : { cabin_class: cabinClass };
  }

  private toPersistedPassenger(value: unknown): PersistedOrderPassenger | undefined {
    const source = asRecord(value);
    if (!source) return undefined;
    const id = readString(source, 'id');
    if (!id) return undefined;

    const passenger: PersistedOrderPassenger = { id };
    const type = readString(source, 'type');
    if (type !== undefined) passenger.type = type;
    const title = readNullableString(source, 'title');
    if (title !== undefined) passenger.title = title;

    for (const field of [
      'given_name',
      'family_name',
      'born_on',
      'email',
      'phone_number',
    ] as const) {
      const valueAtField = readNullableString(source, field);
      if (valueAtField !== undefined) {
        passenger[field] = valueAtField === null ? null : 'REDACTED';
      }
    }

    return passenger;
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
