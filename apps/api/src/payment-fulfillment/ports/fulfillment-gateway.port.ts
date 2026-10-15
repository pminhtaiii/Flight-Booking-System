import { FlightSnapshot, PassengerSnapshot } from '@shared/booking-types';
import {
  PortInvocationControl,
  NormalizedProviderOutcome,
  ProviderObservationProvenance,
  ObservationLinkageFacts,
} from './payment-gateway.port';

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

/**
 * Authoritative Supplier Observation Contracts
 */
export interface SupplierOrderObservation {
  outcome: NormalizedProviderOutcome;
  orderId: string | null;
  bookingReference?: string | null;
  rawStatus?: string | null;
  confirmed: boolean;
  slices?: PersistedOrderSlice[];
  passengers?: PersistedOrderPassenger[];
  observedAt: Date;
  provenance: ProviderObservationProvenance;
  linkage: ObservationLinkageFacts;
  errorMessage?: string;
}

export interface SupplierOrderPaymentObservation {
  outcome: NormalizedProviderOutcome;
  orderId: string;
  paymentId?: string | null;
  amount?: number;
  currency?: string;
  paidFromBalance: boolean;
  rawStatus?: string | null;
  observedAt: Date;
  provenance: ProviderObservationProvenance;
  linkage: ObservationLinkageFacts;
  errorMessage?: string;
}

export interface SupplierCancellationObservation {
  outcome: NormalizedProviderOutcome;
  orderId: string;
  cancellationId?: string | null;
  canceledAt?: Date;
  refundAmount?: number;
  refundCurrency?: string;
  rawStatus?: string | null;
  confirmed: boolean;
  observedAt: Date;
  provenance: ProviderObservationProvenance;
  linkage: ObservationLinkageFacts;
  errorMessage?: string;
}

/**
 * Candidate Discovery Contracts
 * Discovery uses only verified provider filters/pagination.
 * Discovery inquiry alone never grants financial authority or declares order confirmation.
 * Discovered candidates must pass supplier identity, booking linkage, itinerary,
 * passenger identity, and known order evidence validation before any action (FR-006).
 */
export interface SupplierCandidateDiscoveryCriteria {
  offerId?: string;
  bookingReference?: string;
  bookingIntentId: string;
  expectedDepartureDate?: string;
  passengerCount?: number;
  expectedPassengers?: Array<{
    givenName?: string;
    familyName?: string;
    type?: string;
    dateOfBirth?: string | Date;
  }>;
  supplierEnvironment?: string;
  supplierAccountId?: string;
  knownOrderIds?: string[];
}

export interface SupplierDiscoveredCandidate {
  orderId: string;
  bookingReference?: string;
  offerId?: string;
  createdAt?: Date;
  slices?: PersistedOrderSlice[];
  passengers?: PersistedOrderPassenger[];
  supplierEnvironment?: string;
  supplierAccountId?: string;
  observedTotalAmount?: number;
  observedCurrency?: string;
  rawStatus?: string | null;
  linkage?: ObservationLinkageFacts;
}

export type CandidateMatchStatus =
  | 'NONE'
  | 'SINGLE_MATCHED'
  | 'MULTIPLE_AMBIGUOUS'
  | 'UNLINKED_CANDIDATES'
  | 'PROVIDER_UNAVAILABLE';

export interface SupplierCandidateDiscoveryOutcome {
  outcome: NormalizedProviderOutcome;
  candidates: SupplierDiscoveredCandidate[];
  matchStatus: CandidateMatchStatus;
  observedAt: Date;
  provenance: ProviderObservationProvenance;
  errorMessage?: string;
}

/**
 * Core Fulfillment Gateway Port Interface
 * Preserves legacy contracts while defining optional authoritative observation methods.
 */
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

  observeOrder?(
    orderId: string,
    control?: PortInvocationControl,
  ): Promise<SupplierOrderObservation>;

  observeOrderPayment?(
    orderId: string,
    control?: PortInvocationControl,
  ): Promise<SupplierOrderPaymentObservation>;

  observeOrderCancellation?(
    orderId: string,
    control?: PortInvocationControl,
  ): Promise<SupplierCancellationObservation>;

  discoverCandidates?(
    criteria: SupplierCandidateDiscoveryCriteria,
    control?: PortInvocationControl,
  ): Promise<SupplierCandidateDiscoveryOutcome>;
}

/**
 * Authoritative Fulfillment Gateway Port Interface
 * Mandates complete observation and candidate discovery capabilities.
 */
export interface AuthoritativeFulfillmentGatewayPort extends FulfillmentGatewayPort {
  observeOrder(orderId: string, control?: PortInvocationControl): Promise<SupplierOrderObservation>;

  observeOrderPayment(
    orderId: string,
    control?: PortInvocationControl,
  ): Promise<SupplierOrderPaymentObservation>;

  observeOrderCancellation(
    orderId: string,
    control?: PortInvocationControl,
  ): Promise<SupplierCancellationObservation>;

  discoverCandidates(
    criteria: SupplierCandidateDiscoveryCriteria,
    control?: PortInvocationControl,
  ): Promise<SupplierCandidateDiscoveryOutcome>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isAuthoritativeFulfillmentGateway(
  port: unknown,
): port is AuthoritativeFulfillmentGatewayPort {
  if (!isRecord(port)) {
    return false;
  }
  return (
    typeof port.createOrder === 'function' &&
    typeof port.cancelOrder === 'function' &&
    typeof port.retrieveOrderSnapshot === 'function' &&
    typeof port.observeOrder === 'function' &&
    typeof port.observeOrderPayment === 'function' &&
    typeof port.observeOrderCancellation === 'function' &&
    typeof port.discoverCandidates === 'function'
  );
}
