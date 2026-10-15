/**
 * Payment Gateway Port
 *
 * Provider-blind port defining normalized payment gateway contract.
 * Dependency-free: no NestJS modules, no external SDK types, strictly no any.
 */

export interface PortInvocationControl {
  beforeInvoke: () => Promise<void>;
  timeoutMs?: number;
  idempotencyKey?: string;
  attemptId?: string;
  operationId?: string;
  claimFence?: bigint;
}

export const PAYMENT_GATEWAY_PORT = Symbol('PaymentGatewayPort');

export type PaymentAuthorizationStatus =
  | 'authorized'
  | 'captured'
  | 'voided'
  | 'nonfinal'
  | 'invalid';

export interface AuthorizeHoldOutcome {
  status: PaymentAuthorizationStatus;
  intentId: string;
  amount?: number;
  currency?: string;
  rawStatus?: string;
}

export interface CapturePaymentOutcome {
  success: boolean;
  intentId: string;
  status: string;
  capturedAmount?: number;
  currency?: string;
}

export interface VoidHoldOutcome {
  success: boolean;
  intentId: string;
  status: string;
}

/**
 * Normalized outcome classification across provider-blind operations.
 * CONFIRMED: Verified success with immutable evidence.
 * DEFINITIVE_FAILURE: Provider confirms request failed with no uncertain side effect.
 * NONFINAL: Legitimate in-flight state (e.g. requires_action, processing).
 * UNRESOLVED: Unknown outcome (e.g. timeout, network error, ambiguous discovery).
 */
export type NormalizedProviderOutcome =
  | 'CONFIRMED'
  | 'DEFINITIVE_FAILURE'
  | 'NONFINAL'
  | 'UNRESOLVED';

export type ProviderEvidenceSource =
  | 'HTTP_RESPONSE'
  | 'AUTHORITATIVE_READ'
  | 'WEBHOOK'
  | 'CANDIDATE_DISCOVERY';

export type ProviderKind = 'STRIPE' | 'DUFFEL';

export interface ProviderObservationProvenance {
  provider: ProviderKind;
  source: ProviderEvidenceSource;
  observedAt: Date;
  attemptId?: string;
  operationId?: string;
  claimFence?: bigint;
  rawStatus?: string;
  providerEventId?: string | null;
}

/**
 * Authoritative Stripe Observation Linkage Facts
 *
 * Exposes allowlisted observed Stripe customer ID and metadata booking-intent/payment IDs.
 * Fields are required nullable (string | null).
 * Matched flags are optional and not forced on reads lacking expected context;
 * domain caller compares observed identifiers against its durable persisted expectations.
 * Null/absent required linkage never grants confirmation or financial authority.
 */
export interface StripeObservationLinkageFacts {
  observedStripeCustomerId: string | null;
  observedBookingIntentId: string | null;
  observedPaymentId: string | null;
  bookingIntentMatched?: boolean;
  customerMatched?: boolean;
  amountMatched?: boolean;
  currencyMatched?: boolean;
}

export interface ObservationLinkageFacts {
  bookingIntentMatched?: boolean;
  supplierIdentityMatched?: boolean;
  supplierAccountMatched?: boolean;
  supplierEnvironmentMatched?: boolean;
  offerMatched?: boolean;
  passengerSetMatched?: boolean;
  itineraryMatched?: boolean;
  knownOrderMatched?: boolean;
  amountMatched?: boolean;
  currencyMatched?: boolean;
  customerMatched?: boolean;
  observedOrderId?: string | null;
  observedBookingReference?: string | null;
  observedOfferId?: string | null;
  observedSupplierAccount?: string | null;
  observedSupplierEnvironment?: string | null;
  observedStripeCustomerId?: string | null;
  observedBookingIntentId?: string | null;
  observedPaymentId?: string | null;
}

/**
 * Payment-create reservation semantics:
 * Reserves workflow, Payment, and PAYMENT_INTENT_CREATE operation under shared claim
 * before Stripe creation. Payment.stripePaymentIntentId starts null until verified intent.
 */
export type PaymentReservationStatus = 'RESERVED';

export interface PaymentReservationTerms {
  paymentId: string;
  bookingIntentId: string;
  idempotencyKeyId: string;
  attemptNumber: number;
  amount: number;
  currency: string;
  stripeCustomerId?: string | null;
}

export interface PaymentCreateReservationInput {
  bookingIntentId: string;
  idempotencyKeyId: string;
  attemptNumber: 1 | 2;
  amount: number;
  currency: string;
  stripeCustomerId?: string | null;
}

export interface PaymentCreateReservationOutcome {
  paymentId: string;
  status: PaymentReservationStatus;
  terms: PaymentReservationTerms;
  operationId: string;
  stripePaymentIntentId: null;
}

export interface CreatePaymentIntentInput {
  paymentId: string;
  bookingIntentId: string;
  idempotencyKey: string;
  amount: number;
  currency: string;
  stripeCustomerId?: string | null;
  metadata?: Record<string, string>;
}

export interface CreatePaymentIntentOutcome {
  outcome: NormalizedProviderOutcome;
  intentId: string | null;
  clientSecret: string | null;
  amount?: number;
  currency?: string;
  rawStatus?: string;
  observedAt: Date;
  provenance: ProviderObservationProvenance;
  linkage: StripeObservationLinkageFacts;
  errorMessage?: string;
}

/**
 * Authoritative Stripe Observation Contracts
 */
export interface StripeIntentObservation {
  outcome: NormalizedProviderOutcome;
  intentId: string | null;
  status?: string;
  rawStatus?: string;
  amount?: number;
  currency?: string;
  capturable: boolean;
  expiresAt?: Date | null;
  clientSecretPresent?: boolean;
  observedAt: Date;
  provenance: ProviderObservationProvenance;
  linkage: StripeObservationLinkageFacts;
  errorMessage?: string;
}

export interface StripeCaptureObservation {
  outcome: NormalizedProviderOutcome;
  intentId: string;
  capturedAmount?: number;
  currency?: string;
  capturedAt?: Date;
  rawStatus?: string;
  succeeded: boolean;
  observedAt: Date;
  provenance: ProviderObservationProvenance;
  linkage: StripeObservationLinkageFacts;
  errorMessage?: string;
}

export interface StripeReleaseObservation {
  outcome: NormalizedProviderOutcome;
  intentId: string;
  releasedAt?: Date;
  rawStatus?: string;
  voided: boolean;
  observedAt: Date;
  provenance: ProviderObservationProvenance;
  linkage: StripeObservationLinkageFacts;
  errorMessage?: string;
}

export interface StripeRefundObservation {
  outcome: NormalizedProviderOutcome;
  intentId: string;
  refundId?: string | null;
  refundedAmount?: number;
  currency?: string;
  refundedAt?: Date;
  rawStatus?: string;
  succeeded: boolean;
  observedAt: Date;
  provenance: ProviderObservationProvenance;
  linkage: StripeObservationLinkageFacts;
  errorMessage?: string;
}

/**
 * Core Payment Gateway Port Interface
 * Preserves backward compatibility with existing adapters while defining optional
 * authoritative observation and creation methods.
 */
export interface PaymentGatewayPort {
  authorizeHold(intentId: string, control: PortInvocationControl): Promise<AuthorizeHoldOutcome>;
  capturePayment(
    intentId: string,
    captureKey: string,
    control: PortInvocationControl,
  ): Promise<CapturePaymentOutcome>;
  voidHold(intentId: string, control: PortInvocationControl): Promise<VoidHoldOutcome>;

  createPaymentIntent?(
    input: CreatePaymentIntentInput,
    control: PortInvocationControl,
  ): Promise<CreatePaymentIntentOutcome>;

  observePaymentIntent?(
    intentId: string | null,
    control?: PortInvocationControl,
  ): Promise<StripeIntentObservation>;

  observeCapture?(
    intentId: string,
    captureKey?: string,
    control?: PortInvocationControl,
  ): Promise<StripeCaptureObservation>;

  observeRelease?(
    intentId: string,
    control?: PortInvocationControl,
  ): Promise<StripeReleaseObservation>;

  observeRefund?(
    intentId: string,
    refundKey?: string,
    control?: PortInvocationControl,
  ): Promise<StripeRefundObservation>;
}

/**
 * Authoritative Payment Gateway Port Interface
 * Mandates complete observation and creation capabilities.
 */
export interface AuthoritativePaymentGatewayPort extends PaymentGatewayPort {
  createPaymentIntent(
    input: CreatePaymentIntentInput,
    control: PortInvocationControl,
  ): Promise<CreatePaymentIntentOutcome>;

  observePaymentIntent(
    intentId: string | null,
    control?: PortInvocationControl,
  ): Promise<StripeIntentObservation>;

  observeCapture(
    intentId: string,
    captureKey?: string,
    control?: PortInvocationControl,
  ): Promise<StripeCaptureObservation>;

  observeRelease(
    intentId: string,
    control?: PortInvocationControl,
  ): Promise<StripeReleaseObservation>;

  observeRefund(
    intentId: string,
    refundKey?: string,
    control?: PortInvocationControl,
  ): Promise<StripeRefundObservation>;
}

const VALID_PROVIDER_OUTCOMES = [
  'CONFIRMED',
  'DEFINITIVE_FAILURE',
  'NONFINAL',
  'UNRESOLVED',
] as const;

export function isNormalizedProviderOutcome(value: unknown): value is NormalizedProviderOutcome {
  if (typeof value !== 'string') {
    return false;
  }
  for (const outcome of VALID_PROVIDER_OUTCOMES) {
    if (value === outcome) {
      return true;
    }
  }
  return false;
}

export function isDefinitiveOutcome(outcome: NormalizedProviderOutcome): boolean {
  return outcome === 'CONFIRMED' || outcome === 'DEFINITIVE_FAILURE';
}

export function isUnresolvedOutcome(outcome: NormalizedProviderOutcome): boolean {
  return outcome === 'UNRESOLVED' || outcome === 'NONFINAL';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const ALLOWED_RESERVATION_KEYS = new Set([
  'paymentId',
  'bookingIntentId',
  'idempotencyKeyId',
  'attemptNumber',
  'amount',
  'currency',
  'stripeCustomerId',
]);

export function validatePaymentReservationTerms(terms: unknown): {
  valid: boolean;
  normalizedCurrency?: string;
  reason?: string;
} {
  if (!isRecord(terms)) {
    return { valid: false, reason: 'Reservation terms must be an object' };
  }

  for (const key of Object.keys(terms)) {
    if (!ALLOWED_RESERVATION_KEYS.has(key)) {
      return { valid: false, reason: `Unrecognized extra field: ${key}` };
    }
  }

  const {
    paymentId,
    bookingIntentId,
    idempotencyKeyId,
    attemptNumber,
    amount,
    currency,
    stripeCustomerId,
  } = terms;

  if (typeof paymentId !== 'string' || paymentId.trim().length === 0) {
    return { valid: false, reason: 'Payment ID is required' };
  }
  if (typeof bookingIntentId !== 'string' || bookingIntentId.trim().length === 0) {
    return { valid: false, reason: 'Booking intent ID is required' };
  }
  if (typeof idempotencyKeyId !== 'string' || idempotencyKeyId.trim().length === 0) {
    return { valid: false, reason: 'Idempotency key ID is required' };
  }
  if (typeof attemptNumber !== 'number' || (attemptNumber !== 1 && attemptNumber !== 2)) {
    return { valid: false, reason: 'Attempt number must be 1 or 2' };
  }
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) {
    return { valid: false, reason: 'Amount must be a positive integer in minor units' };
  }
  if (typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency)) {
    return { valid: false, reason: 'Currency must be a 3-letter ISO code' };
  }
  if (stripeCustomerId !== undefined && stripeCustomerId !== null) {
    if (typeof stripeCustomerId !== 'string' || stripeCustomerId.trim().length === 0) {
      return { valid: false, reason: 'Stripe customer ID must be null or a non-empty string' };
    }
  }

  return {
    valid: true,
    normalizedCurrency: currency.toLowerCase(),
  };
}

export function isAuthoritativePaymentGateway(
  port: unknown,
): port is AuthoritativePaymentGatewayPort {
  if (!isRecord(port)) {
    return false;
  }
  return (
    typeof port.authorizeHold === 'function' &&
    typeof port.capturePayment === 'function' &&
    typeof port.voidHold === 'function' &&
    typeof port.createPaymentIntent === 'function' &&
    typeof port.observePaymentIntent === 'function' &&
    typeof port.observeCapture === 'function' &&
    typeof port.observeRelease === 'function' &&
    typeof port.observeRefund === 'function'
  );
}
