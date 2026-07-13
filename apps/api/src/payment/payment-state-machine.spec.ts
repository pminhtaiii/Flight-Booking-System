import { PaymentStatus } from '@prisma/client';
import { canTransition, enforceTransition, resolveDisputeStatus } from './payment-state-machine';

describe('Payment State Machine', () => {
  describe('canTransition', () => {
    it('should allow valid transitions', () => {
      // CREATED transitions
      expect(canTransition(PaymentStatus.CREATED, PaymentStatus.AUTHORIZED)).toBe(true);
      expect(canTransition(PaymentStatus.CREATED, PaymentStatus.FAILED)).toBe(true);
      expect(canTransition(PaymentStatus.CREATED, PaymentStatus.CANCELLED)).toBe(true);

      // AUTHORIZED transitions
      expect(canTransition(PaymentStatus.AUTHORIZED, PaymentStatus.SUCCEEDED)).toBe(true);
      expect(canTransition(PaymentStatus.AUTHORIZED, PaymentStatus.EXPIRED)).toBe(true);
      expect(canTransition(PaymentStatus.AUTHORIZED, PaymentStatus.CANCELLED)).toBe(true);

      // SUCCEEDED transitions
      expect(canTransition(PaymentStatus.SUCCEEDED, PaymentStatus.REFUND_PENDING)).toBe(true);
      expect(canTransition(PaymentStatus.SUCCEEDED, PaymentStatus.DISPUTED)).toBe(true);

      // REFUND_PENDING transitions
      expect(canTransition(PaymentStatus.REFUND_PENDING, PaymentStatus.PARTIALLY_REFUNDED)).toBe(true);
      expect(canTransition(PaymentStatus.REFUND_PENDING, PaymentStatus.REFUNDED)).toBe(true);
      expect(canTransition(PaymentStatus.REFUND_PENDING, PaymentStatus.SUCCEEDED)).toBe(true); // if refund fails/cancelled

      // PARTIALLY_REFUNDED transitions
      expect(canTransition(PaymentStatus.PARTIALLY_REFUNDED, PaymentStatus.REFUND_PENDING)).toBe(true);
      expect(canTransition(PaymentStatus.PARTIALLY_REFUNDED, PaymentStatus.DISPUTED)).toBe(true);

      // REFUNDED transitions
      expect(canTransition(PaymentStatus.REFUNDED, PaymentStatus.DISPUTED)).toBe(true);

      // DISPUTED transitions
      expect(canTransition(PaymentStatus.DISPUTED, PaymentStatus.SUCCEEDED)).toBe(true);
      expect(canTransition(PaymentStatus.DISPUTED, PaymentStatus.PARTIALLY_REFUNDED)).toBe(true);
      expect(canTransition(PaymentStatus.DISPUTED, PaymentStatus.REFUNDED)).toBe(true);
      expect(canTransition(PaymentStatus.DISPUTED, PaymentStatus.CHARGEBACK_LOST)).toBe(true);
    });

    it('should reject invalid transitions', () => {
      // Terminal states should not transition
      expect(canTransition(PaymentStatus.FAILED, PaymentStatus.CREATED)).toBe(false);
      expect(canTransition(PaymentStatus.CHARGEBACK_LOST, PaymentStatus.SUCCEEDED)).toBe(false);

      // Random invalid transitions
      expect(canTransition(PaymentStatus.CREATED, PaymentStatus.SUCCEEDED)).toBe(false);
      expect(canTransition(PaymentStatus.SUCCEEDED, PaymentStatus.SUCCEEDED)).toBe(false);
      expect(canTransition(PaymentStatus.AUTHORIZED, PaymentStatus.REFUND_PENDING)).toBe(false);
      expect(canTransition(PaymentStatus.REFUNDED, PaymentStatus.SUCCEEDED)).toBe(false);
    });
  });

  describe('enforceTransition', () => {
    it('should not throw on valid transition', () => {
      expect(() => enforceTransition(PaymentStatus.CREATED, PaymentStatus.AUTHORIZED)).not.toThrow();
    });

    it('should throw Error on invalid transition', () => {
      expect(() => enforceTransition(PaymentStatus.FAILED, PaymentStatus.CREATED)).toThrow('Invalid payment status transition');
    });
  });

  describe('resolveDisputeStatus', () => {
    it('should return preDisputeStatus on won outcome', () => {
      expect(resolveDisputeStatus('won', PaymentStatus.SUCCEEDED)).toBe(PaymentStatus.SUCCEEDED);
      expect(resolveDisputeStatus('won', PaymentStatus.PARTIALLY_REFUNDED)).toBe(PaymentStatus.PARTIALLY_REFUNDED);
      expect(resolveDisputeStatus('won', PaymentStatus.REFUNDED)).toBe(PaymentStatus.REFUNDED);
    });

    it('should return CHARGEBACK_LOST on lost outcome', () => {
      expect(resolveDisputeStatus('lost', PaymentStatus.SUCCEEDED)).toBe(PaymentStatus.CHARGEBACK_LOST);
      expect(resolveDisputeStatus('lost', PaymentStatus.REFUNDED)).toBe(PaymentStatus.CHARGEBACK_LOST);
    });

    it('should throw Error if preDisputeStatus is not valid for dispute', () => {
      expect(() => resolveDisputeStatus('won', PaymentStatus.CREATED)).toThrow('Invalid pre-dispute status');
      expect(() => resolveDisputeStatus('won', PaymentStatus.FAILED)).toThrow('Invalid pre-dispute status');
    });
  });
});
