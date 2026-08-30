import { BadRequestException } from '@nestjs/common';
import { PaymentStatus } from '@prisma/client';
import {
  canTransition,
  enforceTransition,
  getPreDisputeStatus,
  resolveDisputeStatus,
} from './payment-state-machine';

describe('PaymentStateMachine', () => {
  describe('canTransition', () => {
    it('allows valid transitions from CREATED', () => {
      expect(canTransition(PaymentStatus.CREATED, PaymentStatus.AUTHORIZED)).toBe(true);
      expect(canTransition(PaymentStatus.CREATED, PaymentStatus.FAILED)).toBe(true);
      expect(canTransition(PaymentStatus.CREATED, PaymentStatus.CANCELLED)).toBe(true);
    });

    it('rejects invalid transitions from CREATED', () => {
      expect(canTransition(PaymentStatus.CREATED, PaymentStatus.SUCCEEDED)).toBe(false);
      expect(canTransition(PaymentStatus.CREATED, PaymentStatus.REFUNDED)).toBe(false);
    });

    it('allows valid transitions from AUTHORIZED', () => {
      expect(canTransition(PaymentStatus.AUTHORIZED, PaymentStatus.SUCCEEDED)).toBe(true);
      expect(canTransition(PaymentStatus.AUTHORIZED, PaymentStatus.EXPIRED)).toBe(true);
      expect(canTransition(PaymentStatus.AUTHORIZED, PaymentStatus.CANCELLED)).toBe(true);
    });

    it('allows valid transitions from SUCCEEDED', () => {
      expect(canTransition(PaymentStatus.SUCCEEDED, PaymentStatus.REFUND_PENDING)).toBe(true);
      expect(canTransition(PaymentStatus.SUCCEEDED, PaymentStatus.DISPUTED)).toBe(true);
    });

    it('allows valid transitions from REFUND_PENDING', () => {
      expect(canTransition(PaymentStatus.REFUND_PENDING, PaymentStatus.PARTIALLY_REFUNDED)).toBe(
        true,
      );
      expect(canTransition(PaymentStatus.REFUND_PENDING, PaymentStatus.REFUNDED)).toBe(true);
      expect(canTransition(PaymentStatus.REFUND_PENDING, PaymentStatus.SUCCEEDED)).toBe(true);
    });

    it('allows valid transitions from PARTIALLY_REFUNDED', () => {
      expect(canTransition(PaymentStatus.PARTIALLY_REFUNDED, PaymentStatus.REFUND_PENDING)).toBe(
        true,
      );
      expect(canTransition(PaymentStatus.PARTIALLY_REFUNDED, PaymentStatus.DISPUTED)).toBe(true);
    });

    it('allows valid transitions from REFUNDED', () => {
      expect(canTransition(PaymentStatus.REFUNDED, PaymentStatus.DISPUTED)).toBe(true);
    });

    it('allows valid transitions from DISPUTED', () => {
      expect(canTransition(PaymentStatus.DISPUTED, PaymentStatus.SUCCEEDED)).toBe(true);
      expect(canTransition(PaymentStatus.DISPUTED, PaymentStatus.PARTIALLY_REFUNDED)).toBe(true);
      expect(canTransition(PaymentStatus.DISPUTED, PaymentStatus.REFUNDED)).toBe(true);
      expect(canTransition(PaymentStatus.DISPUTED, PaymentStatus.CHARGEBACK_LOST)).toBe(true);
    });

    it('rejects transitions from terminal states', () => {
      expect(canTransition(PaymentStatus.FAILED, PaymentStatus.CREATED)).toBe(false);
      expect(canTransition(PaymentStatus.EXPIRED, PaymentStatus.AUTHORIZED)).toBe(false);
      expect(canTransition(PaymentStatus.CANCELLED, PaymentStatus.CREATED)).toBe(false);
      expect(canTransition(PaymentStatus.CHARGEBACK_LOST, PaymentStatus.SUCCEEDED)).toBe(false);
    });
  });

  describe('enforceTransition', () => {
    it('does not throw on valid transition', () => {
      expect(() =>
        enforceTransition(PaymentStatus.CREATED, PaymentStatus.AUTHORIZED),
      ).not.toThrow();
    });

    it('throws BadRequestException on invalid transition', () => {
      expect(() => enforceTransition(PaymentStatus.CREATED, PaymentStatus.SUCCEEDED)).toThrow(
        BadRequestException,
      );
    });
  });

  describe('getPreDisputeStatus', () => {
    it('returns valid status when current status is SUCCEEDED, PARTIALLY_REFUNDED, or REFUNDED', () => {
      expect(getPreDisputeStatus(PaymentStatus.SUCCEEDED)).toBe(PaymentStatus.SUCCEEDED);
      expect(getPreDisputeStatus(PaymentStatus.PARTIALLY_REFUNDED)).toBe(
        PaymentStatus.PARTIALLY_REFUNDED,
      );
      expect(getPreDisputeStatus(PaymentStatus.REFUNDED)).toBe(PaymentStatus.REFUNDED);
    });

    it('throws BadRequestException if current status is invalid for entering dispute', () => {
      expect(() => getPreDisputeStatus(PaymentStatus.CREATED)).toThrow(BadRequestException);
      expect(() => getPreDisputeStatus(PaymentStatus.AUTHORIZED)).toThrow(BadRequestException);
      expect(() => getPreDisputeStatus(PaymentStatus.FAILED)).toThrow(BadRequestException);
    });
  });

  describe('resolveDisputeStatus', () => {
    it('resolves won disputes to pre-dispute status', () => {
      expect(resolveDisputeStatus('won', PaymentStatus.SUCCEEDED)).toBe(PaymentStatus.SUCCEEDED);
      expect(resolveDisputeStatus('won', PaymentStatus.PARTIALLY_REFUNDED)).toBe(
        PaymentStatus.PARTIALLY_REFUNDED,
      );
      expect(resolveDisputeStatus('won', PaymentStatus.REFUNDED)).toBe(PaymentStatus.REFUNDED);
    });

    it('resolves lost disputes to CHARGEBACK_LOST', () => {
      expect(resolveDisputeStatus('lost', PaymentStatus.SUCCEEDED)).toBe(
        PaymentStatus.CHARGEBACK_LOST,
      );
      expect(resolveDisputeStatus('lost', PaymentStatus.PARTIALLY_REFUNDED)).toBe(
        PaymentStatus.CHARGEBACK_LOST,
      );
      expect(resolveDisputeStatus('lost', PaymentStatus.REFUNDED)).toBe(
        PaymentStatus.CHARGEBACK_LOST,
      );
    });

    it('throws BadRequestException on invalid dispute outcome', () => {
      expect(() =>
        resolveDisputeStatus('invalid' as unknown as 'won', PaymentStatus.SUCCEEDED),
      ).toThrow(BadRequestException);
    });
  });
});
