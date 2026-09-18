/**
 * Domain Event Base
 *
 * Passive, behavior-free envelope contract.
 * Contains only identifiers, committed version, and timestamp.
 * Strictly no customer PII, no provider payloads, no methods, and no DB/SDK instances.
 */

export type DomainEventBase = {
  readonly bookingId: string;
  readonly eventId: string;
  readonly sourceVersion: number;
  readonly timestamp: Date;
};
