import { FlightSnapshot, PassengerSnapshot } from '@shared/booking-types';
import { PortInvocationControl } from './payment-gateway.port';

/**
 * Fulfillment Gateway Port
 *
 * Provider-blind port defining normalized fulfillment gateway contract.
 * Dependency-free: no NestJS modules, no external SDK types, strictly no any.
 */

export const FULFILLMENT_GATEWAY_PORT = Symbol('FulfillmentGatewayPort');

export interface EphemeralPassenger {
  id?: string;
  firstName?: string;
  lastName?: string;
  givenName?: string;
  familyName?: string;
  middleName?: string;
  title?: string;
  gender?: string;
  dateOfBirth?: string | Date;
  passengerType?: string;
  type?: string;
  email?: string;
  phoneNumber?: string;
  phoneCountryCode?: string;
  nationality?: string;
  passportNumber?: string;
  passportExpiry?: string;
  travelerProfileId?: string;
  duffelPassengerId?: string;
  documentType?: string;
  issuingCountry?: string;
  bornOn?: string | Date;
  given_name?: string;
  family_name?: string;
  born_on?: string;
  phone_number?: string;
}

export interface FulfillmentServiceItem {
  serviceId: string;
  quantity: number;
}

export interface FulfillmentMetadata {
  bookingIntentId: string;
  paymentId: string;
}

export interface PersistedOrderLocation {
  iata_code?: string;
  name?: string;
  city_name?: string;
  city?: {
    name?: string;
  };
}

export interface PersistedOrderCarrier {
  iata_code?: string;
  name?: string;
}

export interface PersistedOrderSegmentPassenger {
  cabin_class?: string;
}

export interface PersistedOrderSegment {
  id?: string;
  duration?: string;
  departing_at?: string;
  arriving_at?: string;
  origin?: PersistedOrderLocation;
  destination?: PersistedOrderLocation;
  origin_terminal?: string | null;
  destination_terminal?: string | null;
  operating_carrier?: PersistedOrderCarrier;
  marketing_carrier?: PersistedOrderCarrier;
  marketing_carrier_flight_number?: string;
  aircraft?: {
    name?: string;
  };
  passengers?: PersistedOrderSegmentPassenger[];
}

export interface PersistedOrderSlice {
  duration?: string;
  segments?: PersistedOrderSegment[];
}

export interface PersistedOrderPassenger {
  id: string;
  type?: string;
  title?: string | null;
  given_name?: string | null;
  family_name?: string | null;
  born_on?: string | null;
  email?: string | null;
  phone_number?: string | null;
}

/**
 * The allowlisted, privacy-safe evidence retained for checkpoint recovery.
 *
 * `booking_reference` remains readable for legacy payment events. New writes also
 * include the normalized `bookingReference` field. No provider response fields
 * outside this explicit recovery shape may cross the fulfillment port.
 */
export interface PersistedOrderEvidence {
  id: string;
  bookingReference?: string;
  booking_reference?: string;
  slices?: PersistedOrderSlice[];
  passengers?: PersistedOrderPassenger[];
}

export interface PassengerEnrichmentInput {
  id?: string;
  firstName?: string;
  lastName?: string;
  title?: string;
  gender?: string;
  dateOfBirth?: string;
  passengerType?: string;
  email?: string;
  phoneNumber?: string;
}

export interface CreateOrderInput {
  offerId: string;
  passengers: EphemeralPassenger[];
  services?: FulfillmentServiceItem[];
  metadata: FulfillmentMetadata;
  idempotencyKey: string;
}

export interface CreateOrderOutcome {
  orderId: string;
  bookingReference: string;
  evidence: PersistedOrderEvidence;
}

export interface CancelOrderOutcome {
  success: boolean;
  orderId: string;
  status?: string;
}

export interface OrderSnapshotOutcome {
  flightSnapshot: FlightSnapshot;
  passengerSnapshot: PassengerSnapshot;
  departureAt?: Date;
}

export interface FulfillmentGatewayPort {
  createOrder(input: CreateOrderInput, control: PortInvocationControl): Promise<CreateOrderOutcome>;
  cancelOrder(orderId: string, control: PortInvocationControl): Promise<CancelOrderOutcome>;
  retrieveOrderSnapshot(
    orderId: string,
    fallbackEvidence: PersistedOrderEvidence,
    passengerEnrichment: PassengerEnrichmentInput[],
    contactEmail: string,
    control: PortInvocationControl,
  ): Promise<OrderSnapshotOutcome>;
}
