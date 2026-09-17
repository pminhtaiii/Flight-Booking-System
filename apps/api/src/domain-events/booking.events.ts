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

  constructor(init: BookingCreatedEventInit) {
    this.bookingId = init.bookingId;
    this.eventId = init.eventId;
    this.sourceVersion = init.sourceVersion;
    this.timestamp = init.timestamp ?? new Date();
    if (init.status !== undefined) {
      this.status = init.status;
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

  constructor(init: BookingConfirmedEventInit) {
    this.bookingId = init.bookingId;
    this.eventId = init.eventId;
    this.sourceVersion = init.sourceVersion;
    this.timestamp = init.timestamp ?? new Date();
    if (init.status !== undefined) {
      this.status = init.status;
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

  constructor(init: BookingFailedEventInit) {
    this.bookingId = init.bookingId;
    this.eventId = init.eventId;
    this.sourceVersion = init.sourceVersion;
    this.timestamp = init.timestamp ?? new Date();
    if (init.status !== undefined) {
      this.status = init.status;
    }
    if (init.failureReason !== undefined) {
      this.failureReason = init.failureReason;
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

  constructor(init: BookingCompletedEventInit) {
    this.bookingId = init.bookingId;
    this.eventId = init.eventId;
    this.sourceVersion = init.sourceVersion;
    this.timestamp = init.timestamp ?? new Date();
    if (init.status !== undefined) {
      this.status = init.status;
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

  constructor(init: BookingRecoveryResolvedEventInit) {
    this.bookingId = init.bookingId;
    this.eventId = init.eventId;
    this.sourceVersion = init.sourceVersion;
    this.timestamp = init.timestamp ?? new Date();
    if (init.status !== undefined) {
      this.status = init.status;
    }
    if (init.recoveryOutcome !== undefined) {
      this.recoveryOutcome = init.recoveryOutcome;
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

  constructor(init: BookingCancellationPendingEventInit) {
    this.bookingId = init.bookingId;
    this.eventId = init.eventId;
    this.sourceVersion = init.sourceVersion;
    this.timestamp = init.timestamp ?? new Date();
    if (init.status !== undefined) {
      this.status = init.status;
    }
    if (init.reason !== undefined) {
      this.reason = init.reason;
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

  constructor(init: BookingCancelledEventInit) {
    this.bookingId = init.bookingId;
    this.eventId = init.eventId;
    this.sourceVersion = init.sourceVersion;
    this.timestamp = init.timestamp ?? new Date();
    if (init.status !== undefined) {
      this.status = init.status;
    }
    if (init.reason !== undefined) {
      this.reason = init.reason;
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

  constructor(init: BookingDisruptionSyncedEventInit) {
    this.bookingId = init.bookingId;
    this.eventId = init.eventId;
    this.sourceVersion = init.sourceVersion;
    this.timestamp = init.timestamp ?? new Date();
    if (init.status !== undefined) {
      this.status = init.status;
    }
    if (init.revisionId !== undefined) {
      this.revisionId = init.revisionId;
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

  constructor(init: BookingDisruptionAcknowledgedEventInit) {
    this.bookingId = init.bookingId;
    this.eventId = init.eventId;
    this.sourceVersion = init.sourceVersion;
    this.timestamp = init.timestamp ?? new Date();
    if (init.status !== undefined) {
      this.status = init.status;
    }
    if (init.disruptionId !== undefined) {
      this.disruptionId = init.disruptionId;
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

  constructor(init: BookingDisruptionAcceptedEventInit) {
    this.bookingId = init.bookingId;
    this.eventId = init.eventId;
    this.sourceVersion = init.sourceVersion;
    this.timestamp = init.timestamp ?? new Date();
    if (init.status !== undefined) {
      this.status = init.status;
    }
    if (init.disruptionId !== undefined) {
      this.disruptionId = init.disruptionId;
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

  constructor(init: BookingRefundUpdatedEventInit) {
    this.bookingId = init.bookingId;
    this.eventId = init.eventId;
    this.sourceVersion = init.sourceVersion;
    this.timestamp = init.timestamp ?? new Date();
    if (init.status !== undefined) {
      this.status = init.status;
    }
    if (init.refundStatus !== undefined) {
      this.refundStatus = init.refundStatus;
    }
    if (init.reason !== undefined) {
      this.reason = init.reason;
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
