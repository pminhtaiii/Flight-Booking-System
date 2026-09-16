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

export interface PersistedOrderEvidence {
  id: string;
  bookingReference?: string;
  [key: string]: unknown;
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
