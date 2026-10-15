import {
  PAYMENT_GATEWAY_PORT,
  type PaymentGatewayPort,
  type AuthoritativePaymentGatewayPort,
  type NormalizedProviderOutcome,
  type PaymentReservationTerms,
  type StripeObservationLinkageFacts,
  type StripeIntentObservation,
  type StripeCaptureObservation,
  type StripeReleaseObservation,
  type StripeRefundObservation,
  type CreatePaymentIntentOutcome,
  isNormalizedProviderOutcome,
  isDefinitiveOutcome,
  isUnresolvedOutcome,
  validatePaymentReservationTerms,
  isAuthoritativePaymentGateway,
} from './payment-gateway.port';
import {
  FULFILLMENT_GATEWAY_PORT,
  type FulfillmentGatewayPort,
  type AuthoritativeFulfillmentGatewayPort,
  isAuthoritativeFulfillmentGateway,
} from './fulfillment-gateway.port';

describe('Payment and Fulfillment Gateway Port Contracts (T021)', () => {
  describe('DI Port Tokens', () => {
    it('exports stable Symbols for dependency injection', () => {
      expect(typeof PAYMENT_GATEWAY_PORT).toBe('symbol');
      expect(typeof FULFILLMENT_GATEWAY_PORT).toBe('symbol');
      expect(PAYMENT_GATEWAY_PORT.toString()).toContain('PaymentGatewayPort');
      expect(FULFILLMENT_GATEWAY_PORT.toString()).toContain('FulfillmentGatewayPort');
    });
  });

  describe('Normalized Outcome Contracts', () => {
    it('identifies valid NormalizedProviderOutcome variants', () => {
      const validOutcomes: readonly NormalizedProviderOutcome[] = [
        'CONFIRMED',
        'DEFINITIVE_FAILURE',
        'NONFINAL',
        'UNRESOLVED',
      ] as const;
      for (const outcome of validOutcomes) {
        expect(isNormalizedProviderOutcome(outcome)).toBe(true);
      }
      expect(isNormalizedProviderOutcome('UNKNOWN')).toBe(false);
      expect(isNormalizedProviderOutcome('')).toBe(false);
      expect(isNormalizedProviderOutcome('confirmed')).toBe(false);
      expect(isNormalizedProviderOutcome(null)).toBe(false);
      expect(isNormalizedProviderOutcome(123)).toBe(false);
      expect(isNormalizedProviderOutcome(undefined)).toBe(false);
      expect(isNormalizedProviderOutcome(true)).toBe(false);
      expect(isNormalizedProviderOutcome({})).toBe(false);
      expect(isNormalizedProviderOutcome([])).toBe(false);
    });

    it('distinguishes definitive outcomes from unresolved or nonfinal outcomes', () => {
      expect(isDefinitiveOutcome('CONFIRMED')).toBe(true);
      expect(isDefinitiveOutcome('DEFINITIVE_FAILURE')).toBe(true);
      expect(isDefinitiveOutcome('NONFINAL')).toBe(false);
      expect(isDefinitiveOutcome('UNRESOLVED')).toBe(false);

      expect(isUnresolvedOutcome('UNRESOLVED')).toBe(true);
      expect(isUnresolvedOutcome('NONFINAL')).toBe(true);
      expect(isUnresolvedOutcome('CONFIRMED')).toBe(false);
      expect(isUnresolvedOutcome('DEFINITIVE_FAILURE')).toBe(false);
    });
  });

  describe('Payment Reservation Semantics Contract', () => {
    it('validates conforming payment reservation terms', () => {
      const terms: PaymentReservationTerms = {
        paymentId: 'pay_01h7abc',
        bookingIntentId: 'bi_01h7xyz',
        idempotencyKeyId: 'idem_01h7key',
        attemptNumber: 1,
        amount: 25000,
        currency: 'USD',
        stripeCustomerId: 'cus_12345',
      };
      const result = validatePaymentReservationTerms(terms);
      expect(result.valid).toBe(true);
      expect(result.normalizedCurrency).toBe('usd');

      const termsAttemptTwo: PaymentReservationTerms = {
        ...terms,
        attemptNumber: 2,
        currency: 'eur',
        stripeCustomerId: null,
      };
      const resultTwo = validatePaymentReservationTerms(termsAttemptTwo);
      expect(resultTwo.valid).toBe(true);
      expect(resultTwo.normalizedCurrency).toBe('eur');
    });

    it('rejects invalid reservation terms (amount <= 0, invalid currency, attempt > 2)', () => {
      expect(
        validatePaymentReservationTerms({
          paymentId: 'pay_01',
          bookingIntentId: 'bi_01',
          idempotencyKeyId: 'idem_01',
          attemptNumber: 0,
          amount: 100,
          currency: 'usd',
        }).valid,
      ).toBe(false);

      expect(
        validatePaymentReservationTerms({
          paymentId: 'pay_01',
          bookingIntentId: 'bi_01',
          idempotencyKeyId: 'idem_01',
          attemptNumber: 3,
          amount: 100,
          currency: 'usd',
        }).valid,
      ).toBe(false);

      expect(
        validatePaymentReservationTerms({
          paymentId: 'pay_01',
          bookingIntentId: 'bi_01',
          idempotencyKeyId: 'idem_01',
          attemptNumber: 1,
          amount: -50,
          currency: 'usd',
        }).valid,
      ).toBe(false);

      expect(
        validatePaymentReservationTerms({
          paymentId: 'pay_01',
          bookingIntentId: 'bi_01',
          idempotencyKeyId: 'idem_01',
          attemptNumber: 1,
          amount: 0,
          currency: 'usd',
        }).valid,
      ).toBe(false);

      expect(
        validatePaymentReservationTerms({
          paymentId: 'pay_01',
          bookingIntentId: 'bi_01',
          idempotencyKeyId: 'idem_01',
          attemptNumber: 1,
          amount: 2500.5,
          currency: 'usd',
        }).valid,
      ).toBe(false);

      expect(
        validatePaymentReservationTerms({
          paymentId: 'pay_01',
          bookingIntentId: 'bi_01',
          idempotencyKeyId: 'idem_01',
          attemptNumber: 1,
          amount: 100,
          currency: 'US_DOLLARS',
        }).valid,
      ).toBe(false);

      expect(
        validatePaymentReservationTerms({
          paymentId: 'pay_01',
          bookingIntentId: 'bi_01',
          idempotencyKeyId: 'idem_01',
          attemptNumber: 1,
          amount: 100,
          currency: 'US',
        }).valid,
      ).toBe(false);

      expect(
        validatePaymentReservationTerms({
          paymentId: '',
          bookingIntentId: 'bi_01',
          idempotencyKeyId: 'idem_01',
          attemptNumber: 1,
          amount: 100,
          currency: 'usd',
        }).valid,
      ).toBe(false);

      expect(
        validatePaymentReservationTerms({
          paymentId: '   ',
          bookingIntentId: 'bi_01',
          idempotencyKeyId: 'idem_01',
          attemptNumber: 1,
          amount: 100,
          currency: 'usd',
        }).valid,
      ).toBe(false);

      expect(
        validatePaymentReservationTerms({
          paymentId: 'pay_01',
          bookingIntentId: '   ',
          idempotencyKeyId: 'idem_01',
          attemptNumber: 1,
          amount: 100,
          currency: 'usd',
        }).valid,
      ).toBe(false);

      expect(
        validatePaymentReservationTerms({
          paymentId: 'pay_01',
          bookingIntentId: 'bi_01',
          idempotencyKeyId: '   ',
          attemptNumber: 1,
          amount: 100,
          currency: 'usd',
        }).valid,
      ).toBe(false);

      expect(validatePaymentReservationTerms(null).valid).toBe(false);
      expect(validatePaymentReservationTerms(undefined).valid).toBe(false);
      expect(validatePaymentReservationTerms('not-an-object').valid).toBe(false);
      expect(validatePaymentReservationTerms([]).valid).toBe(false);
    });

    it('rejects reservation terms with unrecognized extra fields or malformed customer ID', () => {
      const validTerms: PaymentReservationTerms = {
        paymentId: 'pay_01h7abc',
        bookingIntentId: 'bi_01h7xyz',
        idempotencyKeyId: 'idem_01h7key',
        attemptNumber: 1,
        amount: 25000,
        currency: 'USD',
      };

      expect(
        validatePaymentReservationTerms({
          ...validTerms,
          unexpectedField: 'forbidden',
        }).valid,
      ).toBe(false);

      expect(
        validatePaymentReservationTerms({
          ...validTerms,
          stripeCustomerId: '   ',
        }).valid,
      ).toBe(false);

      expect(
        validatePaymentReservationTerms({
          ...validTerms,
          stripeCustomerId: 12345,
        }).valid,
      ).toBe(false);
    });
  });

  describe('Authoritative Stripe Linkage Contract Capability (T021 Correction)', () => {
    it('statically enforces allowlisted observed Stripe customer, booking-intent, and payment identifiers on observation linkage', () => {
      // Meaningful compile-contract capability check:
      // Verifies that Stripe observation types expose allowlisted observed identifiers
      // (observedStripeCustomerId, observedBookingIntentId, observedPaymentId)
      // as required nullable properties on linkage.
      type ExtractObservedCustomer<
        T extends { linkage: { observedStripeCustomerId: string | null } },
      > = T['linkage']['observedStripeCustomerId'];
      type ExtractObservedBooking<
        T extends { linkage: { observedBookingIntentId: string | null } },
      > = T['linkage']['observedBookingIntentId'];
      type ExtractObservedPayment<T extends { linkage: { observedPaymentId: string | null } }> =
        T['linkage']['observedPaymentId'];

      type _IntentCustomer = ExtractObservedCustomer<StripeIntentObservation>;
      type _IntentBooking = ExtractObservedBooking<StripeIntentObservation>;
      type _IntentPayment = ExtractObservedPayment<StripeIntentObservation>;

      type _CaptureCustomer = ExtractObservedCustomer<StripeCaptureObservation>;
      type _CaptureBooking = ExtractObservedBooking<StripeCaptureObservation>;
      type _CapturePayment = ExtractObservedPayment<StripeCaptureObservation>;

      type _ReleaseCustomer = ExtractObservedCustomer<StripeReleaseObservation>;
      type _ReleaseBooking = ExtractObservedBooking<StripeReleaseObservation>;
      type _ReleasePayment = ExtractObservedPayment<StripeReleaseObservation>;

      type _RefundCustomer = ExtractObservedCustomer<StripeRefundObservation>;
      type _RefundBooking = ExtractObservedBooking<StripeRefundObservation>;
      type _RefundPayment = ExtractObservedPayment<StripeRefundObservation>;

      type _CreateCustomer = ExtractObservedCustomer<CreatePaymentIntentOutcome>;
      type _CreateBooking = ExtractObservedBooking<CreatePaymentIntentOutcome>;
      type _CreatePayment = ExtractObservedPayment<CreatePaymentIntentOutcome>;

      // Direct linkage type conformation check
      type AssertLinkageType =
        StripeIntentObservation['linkage'] extends StripeObservationLinkageFacts ? true : false;
      const linkageTypeConforms: AssertLinkageType = true;
      expect(linkageTypeConforms).toBe(true);

      // Behavioral assertion verifying DI symbol stability alongside static capability
      expect(typeof PAYMENT_GATEWAY_PORT).toBe('symbol');
    });

    it('demonstrates compile-contract requirement that reads lacking expected context do not require forced matched flags', () => {
      // Compile-contract capability check:
      // Reads (intent, capture, release, refund) receive only provider ID/control without expected context.
      // Their linkage must NOT force matched-flag booleans (e.g. bookingIntentMatched).
      type PureObservedFacts = {
        observedStripeCustomerId: string | null;
        observedBookingIntentId: string | null;
        observedPaymentId: string | null;
      };

      // When matched flags are not forced, PureObservedFacts must be assignable to StripeIntentObservation['linkage']
      type AssertAssignable<T extends StripeIntentObservation['linkage']> = T;
      type _Check = AssertAssignable<PureObservedFacts>;

      expect(typeof PAYMENT_GATEWAY_PORT).toBe('symbol');
    });
  });

  describe('Authoritative Stripe Observation and Gateway Seams', () => {
    it('preserves compatibility with legacy-only PaymentGatewayPort implementations', () => {
      const legacyPort: PaymentGatewayPort = {
        authorizeHold: jest.fn(),
        capturePayment: jest.fn(),
        voidHold: jest.fn(),
      };
      expect(typeof legacyPort.authorizeHold).toBe('function');
      expect(legacyPort.observePaymentIntent).toBeUndefined();
      expect(isAuthoritativePaymentGateway(legacyPort)).toBe(false);
    });

    it('recognizes authoritative payment gateway implementations', () => {
      const legacyPort: PaymentGatewayPort = {
        authorizeHold: jest.fn(),
        capturePayment: jest.fn(),
        voidHold: jest.fn(),
      };

      const authoritativePort: AuthoritativePaymentGatewayPort = {
        ...legacyPort,
        createPaymentIntent: jest.fn(),
        observePaymentIntent: jest.fn(),
        observeCapture: jest.fn(),
        observeRelease: jest.fn(),
        observeRefund: jest.fn(),
      };
      expect(isAuthoritativePaymentGateway(authoritativePort)).toBe(true);
    });

    it('rejects incomplete or non-object payment gateway implementations', () => {
      expect(isAuthoritativePaymentGateway(null)).toBe(false);
      expect(isAuthoritativePaymentGateway(undefined)).toBe(false);
      expect(isAuthoritativePaymentGateway('not-a-port')).toBe(false);
      expect(isAuthoritativePaymentGateway({})).toBe(false);

      const baseAuthoritative = {
        authorizeHold: jest.fn(),
        capturePayment: jest.fn(),
        voidHold: jest.fn(),
        createPaymentIntent: jest.fn(),
        observePaymentIntent: jest.fn(),
        observeCapture: jest.fn(),
        observeRelease: jest.fn(),
        observeRefund: jest.fn(),
      };

      const { createPaymentIntent: _omittedCreate, ...withoutCreate } = baseAuthoritative;
      expect(isAuthoritativePaymentGateway(withoutCreate)).toBe(false);

      const { observePaymentIntent: _omittedObserve, ...withoutObserveIntent } = baseAuthoritative;
      expect(isAuthoritativePaymentGateway(withoutObserveIntent)).toBe(false);

      const { observeCapture: _omittedCapture, ...withoutObserveCapture } = baseAuthoritative;
      expect(isAuthoritativePaymentGateway(withoutObserveCapture)).toBe(false);

      const { observeRelease: _omittedRelease, ...withoutObserveRelease } = baseAuthoritative;
      expect(isAuthoritativePaymentGateway(withoutObserveRelease)).toBe(false);

      const { observeRefund: _omittedRefund, ...withoutObserveRefund } = baseAuthoritative;
      expect(isAuthoritativePaymentGateway(withoutObserveRefund)).toBe(false);

      expect(
        isAuthoritativePaymentGateway({ ...baseAuthoritative, observeRefund: 'not-a-function' }),
      ).toBe(false);
    });
  });

  describe('Authoritative Supplier Observation and Fulfillment Gateway Seams', () => {
    it('preserves compatibility with legacy-only FulfillmentGatewayPort implementations', () => {
      const legacyPort: FulfillmentGatewayPort = {
        createOrder: jest.fn(),
        cancelOrder: jest.fn(),
        retrieveOrderSnapshot: jest.fn(),
      };
      expect(typeof legacyPort.createOrder).toBe('function');
      expect(legacyPort.observeOrder).toBeUndefined();
      expect(isAuthoritativeFulfillmentGateway(legacyPort)).toBe(false);
    });

    it('recognizes authoritative fulfillment gateway implementations', () => {
      const legacyPort: FulfillmentGatewayPort = {
        createOrder: jest.fn(),
        cancelOrder: jest.fn(),
        retrieveOrderSnapshot: jest.fn(),
      };

      const authoritativePort: AuthoritativeFulfillmentGatewayPort = {
        ...legacyPort,
        observeOrder: jest.fn(),
        observeOrderPayment: jest.fn(),
        observeOrderCancellation: jest.fn(),
        discoverCandidates: jest.fn(),
      };
      expect(isAuthoritativeFulfillmentGateway(authoritativePort)).toBe(true);
    });

    it('rejects incomplete or non-object fulfillment gateway implementations', () => {
      expect(isAuthoritativeFulfillmentGateway(null)).toBe(false);
      expect(isAuthoritativeFulfillmentGateway(undefined)).toBe(false);
      expect(isAuthoritativeFulfillmentGateway('not-a-port')).toBe(false);
      expect(isAuthoritativeFulfillmentGateway({})).toBe(false);

      const baseAuthoritative = {
        createOrder: jest.fn(),
        cancelOrder: jest.fn(),
        retrieveOrderSnapshot: jest.fn(),
        observeOrder: jest.fn(),
        observeOrderPayment: jest.fn(),
        observeOrderCancellation: jest.fn(),
        discoverCandidates: jest.fn(),
      };

      const { observeOrder: _omittedObserve, ...withoutObserveOrder } = baseAuthoritative;
      expect(isAuthoritativeFulfillmentGateway(withoutObserveOrder)).toBe(false);

      const { observeOrderPayment: _omittedPayment, ...withoutObservePayment } = baseAuthoritative;
      expect(isAuthoritativeFulfillmentGateway(withoutObservePayment)).toBe(false);

      const { observeOrderCancellation: _omittedCancellation, ...withoutObserveCancellation } =
        baseAuthoritative;
      expect(isAuthoritativeFulfillmentGateway(withoutObserveCancellation)).toBe(false);

      const { discoverCandidates: _omittedDiscover, ...withoutDiscover } = baseAuthoritative;
      expect(isAuthoritativeFulfillmentGateway(withoutDiscover)).toBe(false);

      expect(
        isAuthoritativeFulfillmentGateway({ ...baseAuthoritative, discoverCandidates: true }),
      ).toBe(false);
    });
  });
});
