import { BadRequestException } from '@nestjs/common';
import { PaymentStatus } from '@prisma/client';

const ALLOWED_TRANSITIONS: Record<PaymentStatus, Set<PaymentStatus>> = {
  [PaymentStatus.CREATED]: new Set([
    PaymentStatus.AUTHORIZED,
    PaymentStatus.FAILED,
    PaymentStatus.CANCELLED,
  ]),
  [PaymentStatus.AUTHORIZED]: new Set([
    PaymentStatus.SUCCEEDED,
    PaymentStatus.EXPIRED,
    PaymentStatus.CANCELLED,
  ]),
  [PaymentStatus.SUCCEEDED]: new Set([
    PaymentStatus.REFUND_PENDING,
    PaymentStatus.DISPUTED,
  ]),
  [PaymentStatus.REFUND_PENDING]: new Set([
    PaymentStatus.PARTIALLY_REFUNDED,
    PaymentStatus.REFUNDED,
    PaymentStatus.SUCCEEDED,
  ]),
  [PaymentStatus.PARTIALLY_REFUNDED]: new Set([
    PaymentStatus.REFUND_PENDING,
    PaymentStatus.DISPUTED,
  ]),
  [PaymentStatus.REFUNDED]: new Set([
    PaymentStatus.DISPUTED,
  ]),
  [PaymentStatus.DISPUTED]: new Set([
    PaymentStatus.SUCCEEDED,
    PaymentStatus.PARTIALLY_REFUNDED,
    PaymentStatus.REFUNDED,
    PaymentStatus.CHARGEBACK_LOST,
  ]),
  [PaymentStatus.FAILED]: new Set(),
  [PaymentStatus.EXPIRED]: new Set(),
  [PaymentStatus.CANCELLED]: new Set(),
  [PaymentStatus.CHARGEBACK_LOST]: new Set(),
};

/**
 * Checks if a transition from currentStatus to targetStatus is allowed.
 */
export function canTransition(currentStatus: PaymentStatus, targetStatus: PaymentStatus): boolean {
  const allowed = ALLOWED_TRANSITIONS[currentStatus];
  return allowed ? allowed.has(targetStatus) : false;
}

/**
 * Enforces the state transition. Throws a BadRequestException if invalid.
 */
export function enforceTransition(currentStatus: PaymentStatus, targetStatus: PaymentStatus): void {
  if (!canTransition(currentStatus, targetStatus)) {
    throw new BadRequestException(
      `Invalid payment status transition from ${currentStatus} to ${targetStatus}`
    );
  }
}

/**
 * Resolves the dispute outcome to the correct next PaymentStatus.
 */
export function resolveDisputeStatus(
  outcome: 'won' | 'lost',
  preDisputeStatus: PaymentStatus
): PaymentStatus {
  const validPreDisputeStates = new Set<PaymentStatus>([
    PaymentStatus.SUCCEEDED,
    PaymentStatus.PARTIALLY_REFUNDED,
    PaymentStatus.REFUNDED,
  ]);

  if (!validPreDisputeStates.has(preDisputeStatus)) {
    throw new BadRequestException(`Invalid pre-dispute status: ${preDisputeStatus}`);
  }

  if (outcome === 'lost') {
    return PaymentStatus.CHARGEBACK_LOST;
  }

  return preDisputeStatus;
}
