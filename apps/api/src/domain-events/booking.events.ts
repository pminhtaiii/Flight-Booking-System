import { DomainEventBase } from './domain-event.base';

/**
 * Booking Event Catalog Constants
 *
 * Exact 11 contract event names emitted on committed booking aggregate transitions.
 */
export const BOOKING_EVENTS = {
  CREATED: 'booking.created',
  CONFIRMED: 'booking.confirmed',
  FAILED: 'booking.failed',
  COMPLETED: 'booking.completed',
  RECOVERY_RESOLVED: 'booking.recovery.resolved',
  CANCELLATION_PENDING: 'booking.cancellation.pending',
  CANCELLED: 'booking.cancelled',
  DISRUPTION_SYNCED: 'booking.disruption.synced',
  DISRUPTION_ACKNOWLEDGED: 'booking.disruption.acknowledged',
  DISRUPTION_ACCEPTED: 'booking.disruption.accepted',
  REFUND_UPDATED: 'booking.refund.updated',
} as const;

export type BookingEventType = (typeof BOOKING_EVENTS)[keyof typeof BOOKING_EVENTS];

export type BookingCreatedEventInit = {
  bookingId: string;
  eventId: string;
  sourceVersion: number;
  timestamp?: Date;
  status?: string;
};

export class BookingCreatedEvent implements DomainEventBase {
  readonly bookingId: string;
  readonly eventId: string;
  readonly sourceVersion: number;
  readonly timestamp: Date;
  readonly status?: string;

  constructor(
    initOrBookingId: BookingCreatedEventInit | string,
    eventId?: string,
    sourceVersion?: number,
    timestamp?: Date,
    status?: string,
  ) {
    if (typeof initOrBookingId === 'string') {
      this.bookingId = initOrBookingId;
      this.eventId = eventId ?? '';
      this.sourceVersion = sourceVersion ?? 1;
      this.timestamp = timestamp ?? new Date();
      if (status !== undefined) {
        this.status = status;
      }
    } else {
      this.bookingId = initOrBookingId.bookingId;
      this.eventId = initOrBookingId.eventId;
      this.sourceVersion = initOrBookingId.sourceVersion;
      this.timestamp = initOrBookingId.timestamp ?? new Date();
      if (initOrBookingId.status !== undefined) {
        this.status = initOrBookingId.status;
      }
    }
  }
}

export type BookingConfirmedEventInit = {
  bookingId: string;
  eventId: string;
  sourceVersion: number;
  timestamp?: Date;
  status?: string;
};

export class BookingConfirmedEvent implements DomainEventBase {
  readonly bookingId: string;
  readonly eventId: string;
  readonly sourceVersion: number;
  readonly timestamp: Date;
  readonly status?: string;

  constructor(
    initOrBookingId: BookingConfirmedEventInit | string,
    eventId?: string,
    sourceVersion?: number,
    timestamp?: Date,
    status?: string,
  ) {
    if (typeof initOrBookingId === 'string') {
      this.bookingId = initOrBookingId;
      this.eventId = eventId ?? '';
      this.sourceVersion = sourceVersion ?? 1;
      this.timestamp = timestamp ?? new Date();
      if (status !== undefined) {
        this.status = status;
      }
    } else {
      this.bookingId = initOrBookingId.bookingId;
      this.eventId = initOrBookingId.eventId;
      this.sourceVersion = initOrBookingId.sourceVersion;
      this.timestamp = initOrBookingId.timestamp ?? new Date();
      if (initOrBookingId.status !== undefined) {
        this.status = initOrBookingId.status;
      }
    }
  }
}

export type BookingFailedEventInit = {
  bookingId: string;
  eventId: string;
  sourceVersion: number;
  timestamp?: Date;
  status?: string;
  failureReason?: string;
};

export class BookingFailedEvent implements DomainEventBase {
  readonly bookingId: string;
  readonly eventId: string;
  readonly sourceVersion: number;
  readonly timestamp: Date;
  readonly status?: string;
  readonly failureReason?: string;

  constructor(
    initOrBookingId: BookingFailedEventInit | string,
    eventId?: string,
    sourceVersion?: number,
    timestamp?: Date,
    status?: string,
    failureReason?: string,
  ) {
    if (typeof initOrBookingId === 'string') {
      this.bookingId = initOrBookingId;
      this.eventId = eventId ?? '';
      this.sourceVersion = sourceVersion ?? 1;
      this.timestamp = timestamp ?? new Date();
      if (status !== undefined) {
        this.status = status;
      }
      if (failureReason !== undefined) {
        this.failureReason = failureReason;
      }
    } else {
      this.bookingId = initOrBookingId.bookingId;
      this.eventId = initOrBookingId.eventId;
      this.sourceVersion = initOrBookingId.sourceVersion;
      this.timestamp = initOrBookingId.timestamp ?? new Date();
      if (initOrBookingId.status !== undefined) {
        this.status = initOrBookingId.status;
      }
      if (initOrBookingId.failureReason !== undefined) {
        this.failureReason = initOrBookingId.failureReason;
      }
    }
  }
}

export type BookingCompletedEventInit = {
  bookingId: string;
  eventId: string;
  sourceVersion: number;
  timestamp?: Date;
  status?: string;
};

export class BookingCompletedEvent implements DomainEventBase {
  readonly bookingId: string;
  readonly eventId: string;
  readonly sourceVersion: number;
  readonly timestamp: Date;
  readonly status?: string;

  constructor(
    initOrBookingId: BookingCompletedEventInit | string,
    eventId?: string,
    sourceVersion?: number,
    timestamp?: Date,
    status?: string,
  ) {
    if (typeof initOrBookingId === 'string') {
      this.bookingId = initOrBookingId;
      this.eventId = eventId ?? '';
      this.sourceVersion = sourceVersion ?? 1;
      this.timestamp = timestamp ?? new Date();
      if (status !== undefined) {
        this.status = status;
      }
    } else {
      this.bookingId = initOrBookingId.bookingId;
      this.eventId = initOrBookingId.eventId;
      this.sourceVersion = initOrBookingId.sourceVersion;
      this.timestamp = initOrBookingId.timestamp ?? new Date();
      if (initOrBookingId.status !== undefined) {
        this.status = initOrBookingId.status;
      }
    }
  }
}

export type BookingRecoveryResolvedEventInit = {
  bookingId: string;
  eventId: string;
  sourceVersion: number;
  timestamp?: Date;
  status?: string;
  recoveryOutcome?: string;
};

export class BookingRecoveryResolvedEvent implements DomainEventBase {
  readonly bookingId: string;
  readonly eventId: string;
  readonly sourceVersion: number;
  readonly timestamp: Date;
  readonly status?: string;
  readonly recoveryOutcome?: string;

  constructor(
    initOrBookingId: BookingRecoveryResolvedEventInit | string,
    eventId?: string,
    sourceVersion?: number,
    timestamp?: Date,
    status?: string,
    recoveryOutcome?: string,
  ) {
    if (typeof initOrBookingId === 'string') {
      this.bookingId = initOrBookingId;
      this.eventId = eventId ?? '';
      this.sourceVersion = sourceVersion ?? 1;
      this.timestamp = timestamp ?? new Date();
      if (status !== undefined) {
        this.status = status;
      }
      if (recoveryOutcome !== undefined) {
        this.recoveryOutcome = recoveryOutcome;
      }
    } else {
      this.bookingId = initOrBookingId.bookingId;
      this.eventId = initOrBookingId.eventId;
      this.sourceVersion = initOrBookingId.sourceVersion;
      this.timestamp = initOrBookingId.timestamp ?? new Date();
      if (initOrBookingId.status !== undefined) {
        this.status = initOrBookingId.status;
      }
      if (initOrBookingId.recoveryOutcome !== undefined) {
        this.recoveryOutcome = initOrBookingId.recoveryOutcome;
      }
    }
  }
}

export type BookingCancellationPendingEventInit = {
  bookingId: string;
  eventId: string;
  sourceVersion: number;
  timestamp?: Date;
  status?: string;
  reason?: string;
};

export class BookingCancellationPendingEvent implements DomainEventBase {
  readonly bookingId: string;
  readonly eventId: string;
  readonly sourceVersion: number;
  readonly timestamp: Date;
  readonly status?: string;
  readonly reason?: string;

  constructor(
    initOrBookingId: BookingCancellationPendingEventInit | string,
    eventId?: string,
    sourceVersion?: number,
    timestamp?: Date,
    status?: string,
    reason?: string,
  ) {
    if (typeof initOrBookingId === 'string') {
      this.bookingId = initOrBookingId;
      this.eventId = eventId ?? '';
      this.sourceVersion = sourceVersion ?? 1;
      this.timestamp = timestamp ?? new Date();
      if (status !== undefined) {
        this.status = status;
      }
      if (reason !== undefined) {
        this.reason = reason;
      }
    } else {
      this.bookingId = initOrBookingId.bookingId;
      this.eventId = initOrBookingId.eventId;
      this.sourceVersion = initOrBookingId.sourceVersion;
      this.timestamp = initOrBookingId.timestamp ?? new Date();
      if (initOrBookingId.status !== undefined) {
        this.status = initOrBookingId.status;
      }
      if (initOrBookingId.reason !== undefined) {
        this.reason = initOrBookingId.reason;
      }
    }
  }
}

export type BookingCancelledEventInit = {
  bookingId: string;
  eventId: string;
  sourceVersion: number;
  timestamp?: Date;
  status?: string;
  reason?: string;
};

export class BookingCancelledEvent implements DomainEventBase {
  readonly bookingId: string;
  readonly eventId: string;
  readonly sourceVersion: number;
  readonly timestamp: Date;
  readonly status?: string;
  readonly reason?: string;

  constructor(
    initOrBookingId: BookingCancelledEventInit | string,
    eventId?: string,
    sourceVersion?: number,
    timestamp?: Date,
    status?: string,
    reason?: string,
  ) {
    if (typeof initOrBookingId === 'string') {
      this.bookingId = initOrBookingId;
      this.eventId = eventId ?? '';
      this.sourceVersion = sourceVersion ?? 1;
      this.timestamp = timestamp ?? new Date();
      if (status !== undefined) {
        this.status = status;
      }
      if (reason !== undefined) {
        this.reason = reason;
      }
    } else {
      this.bookingId = initOrBookingId.bookingId;
      this.eventId = initOrBookingId.eventId;
      this.sourceVersion = initOrBookingId.sourceVersion;
      this.timestamp = initOrBookingId.timestamp ?? new Date();
      if (initOrBookingId.status !== undefined) {
        this.status = initOrBookingId.status;
      }
      if (initOrBookingId.reason !== undefined) {
        this.reason = initOrBookingId.reason;
      }
    }
  }
}

export type BookingDisruptionSyncedEventInit = {
  bookingId: string;
  eventId: string;
  sourceVersion: number;
  timestamp?: Date;
  status?: string;
  revisionId?: string;
};

export class BookingDisruptionSyncedEvent implements DomainEventBase {
  readonly bookingId: string;
  readonly eventId: string;
  readonly sourceVersion: number;
  readonly timestamp: Date;
  readonly status?: string;
  readonly revisionId?: string;

  constructor(
    initOrBookingId: BookingDisruptionSyncedEventInit | string,
    eventId?: string,
    sourceVersion?: number,
    timestamp?: Date,
    status?: string,
    revisionId?: string,
  ) {
    if (typeof initOrBookingId === 'string') {
      this.bookingId = initOrBookingId;
      this.eventId = eventId ?? '';
      this.sourceVersion = sourceVersion ?? 1;
      this.timestamp = timestamp ?? new Date();
      if (status !== undefined) {
        this.status = status;
      }
      if (revisionId !== undefined) {
        this.revisionId = revisionId;
      }
    } else {
      this.bookingId = initOrBookingId.bookingId;
      this.eventId = initOrBookingId.eventId;
      this.sourceVersion = initOrBookingId.sourceVersion;
      this.timestamp = initOrBookingId.timestamp ?? new Date();
      if (initOrBookingId.status !== undefined) {
        this.status = initOrBookingId.status;
      }
      if (initOrBookingId.revisionId !== undefined) {
        this.revisionId = initOrBookingId.revisionId;
      }
    }
  }
}

export type BookingDisruptionAcknowledgedEventInit = {
  bookingId: string;
  eventId: string;
  sourceVersion: number;
  timestamp?: Date;
  status?: string;
  disruptionId?: string;
};

export class BookingDisruptionAcknowledgedEvent implements DomainEventBase {
  readonly bookingId: string;
  readonly eventId: string;
  readonly sourceVersion: number;
  readonly timestamp: Date;
  readonly status?: string;
  readonly disruptionId?: string;

  constructor(
    initOrBookingId: BookingDisruptionAcknowledgedEventInit | string,
    eventId?: string,
    sourceVersion?: number,
    timestamp?: Date,
    status?: string,
    disruptionId?: string,
  ) {
    if (typeof initOrBookingId === 'string') {
      this.bookingId = initOrBookingId;
      this.eventId = eventId ?? '';
      this.sourceVersion = sourceVersion ?? 1;
      this.timestamp = timestamp ?? new Date();
      if (status !== undefined) {
        this.status = status;
      }
      if (disruptionId !== undefined) {
        this.disruptionId = disruptionId;
      }
    } else {
      this.bookingId = initOrBookingId.bookingId;
      this.eventId = initOrBookingId.eventId;
      this.sourceVersion = initOrBookingId.sourceVersion;
      this.timestamp = initOrBookingId.timestamp ?? new Date();
      if (initOrBookingId.status !== undefined) {
        this.status = initOrBookingId.status;
      }
      if (initOrBookingId.disruptionId !== undefined) {
        this.disruptionId = initOrBookingId.disruptionId;
      }
    }
  }
}

export type BookingDisruptionAcceptedEventInit = {
  bookingId: string;
  eventId: string;
  sourceVersion: number;
  timestamp?: Date;
  status?: string;
  disruptionId?: string;
};

export class BookingDisruptionAcceptedEvent implements DomainEventBase {
  readonly bookingId: string;
  readonly eventId: string;
  readonly sourceVersion: number;
  readonly timestamp: Date;
  readonly status?: string;
  readonly disruptionId?: string;

  constructor(
    initOrBookingId: BookingDisruptionAcceptedEventInit | string,
    eventId?: string,
    sourceVersion?: number,
    timestamp?: Date,
    status?: string,
    disruptionId?: string,
  ) {
    if (typeof initOrBookingId === 'string') {
      this.bookingId = initOrBookingId;
      this.eventId = eventId ?? '';
      this.sourceVersion = sourceVersion ?? 1;
      this.timestamp = timestamp ?? new Date();
      if (status !== undefined) {
        this.status = status;
      }
      if (disruptionId !== undefined) {
        this.disruptionId = disruptionId;
      }
    } else {
      this.bookingId = initOrBookingId.bookingId;
      this.eventId = initOrBookingId.eventId;
      this.sourceVersion = initOrBookingId.sourceVersion;
      this.timestamp = initOrBookingId.timestamp ?? new Date();
      if (initOrBookingId.status !== undefined) {
        this.status = initOrBookingId.status;
      }
      if (initOrBookingId.disruptionId !== undefined) {
        this.disruptionId = initOrBookingId.disruptionId;
      }
    }
  }
}

export type BookingRefundUpdatedEventInit = {
  bookingId: string;
  eventId: string;
  sourceVersion: number;
  timestamp?: Date;
  status?: string;
  refundStatus?: string;
  reason?: string;
};

export class BookingRefundUpdatedEvent implements DomainEventBase {
  readonly bookingId: string;
  readonly eventId: string;
  readonly sourceVersion: number;
  readonly timestamp: Date;
  readonly status?: string;
  readonly refundStatus?: string;
  readonly reason?: string;

  constructor(
    initOrBookingId: BookingRefundUpdatedEventInit | string,
    eventId?: string,
    sourceVersion?: number,
    timestamp?: Date,
    status?: string,
    refundStatus?: string,
    reason?: string,
  ) {
    if (typeof initOrBookingId === 'string') {
      this.bookingId = initOrBookingId;
      this.eventId = eventId ?? '';
      this.sourceVersion = sourceVersion ?? 1;
      this.timestamp = timestamp ?? new Date();
      if (status !== undefined) {
        this.status = status;
      }
      if (refundStatus !== undefined) {
        this.refundStatus = refundStatus;
      }
      if (reason !== undefined) {
        this.reason = reason;
      }
    } else {
      this.bookingId = initOrBookingId.bookingId;
      this.eventId = initOrBookingId.eventId;
      this.sourceVersion = initOrBookingId.sourceVersion;
      this.timestamp = initOrBookingId.timestamp ?? new Date();
      if (initOrBookingId.status !== undefined) {
        this.status = initOrBookingId.status;
      }
      if (initOrBookingId.refundStatus !== undefined) {
        this.refundStatus = initOrBookingId.refundStatus;
      }
      if (initOrBookingId.reason !== undefined) {
        this.reason = initOrBookingId.reason;
      }
    }
  }
}

export type AnyBookingEvent =
  | BookingCreatedEvent
  | BookingConfirmedEvent
  | BookingFailedEvent
  | BookingCompletedEvent
  | BookingRecoveryResolvedEvent
  | BookingCancellationPendingEvent
  | BookingCancelledEvent
  | BookingDisruptionSyncedEvent
  | BookingDisruptionAcknowledgedEvent
  | BookingDisruptionAcceptedEvent
  | BookingRefundUpdatedEvent;
