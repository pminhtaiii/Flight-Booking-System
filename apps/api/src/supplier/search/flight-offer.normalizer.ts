import * as crypto from 'crypto';
import { FlightOffer } from './flight-search.port';

export type NormalizationResult = {
  readonly normalizedOffers: readonly FlightOffer[];
  readonly droppedCount: number;
  readonly rejectionCounts: Readonly<Record<string, number>>;
  readonly currency: string | null;
};

/**
 * Generates a deterministic RFC 4122 v4-formatted UUID from an input string using SHA-256.
 */
export function generateDeterministicUUID(input: string): string {
  const hash = crypto.createHash('sha256').update(input).digest('hex');
  return [
    hash.substring(0, 8),
    hash.substring(8, 12),
    '4' + hash.substring(13, 16),
    '8' + hash.substring(17, 20),
    hash.substring(20, 32),
  ].join('-');
}

/**
 * Normalizes a live Duffel offer into a neutral FlightOffer domain model.
 * TDD RED stub for Feature 029 Phase 3 Slice 1 (Task T014); full implementation in T018.
 */
export function normalizeDuffelOffer(
  _rawOffer: unknown,
  _originalIndex = 0,
): FlightOffer | null {
  throw new Error('Not implemented: normalizeDuffelOffer TDD RED stub');
}

/**
 * Decodes a legacy stored JSON snapshot into a neutral FlightOffer domain model.
 * Enforces fail-closed behavior, returning null for malformed or invalid inputs.
 * TDD RED stub for Feature 029 Phase 3 Slice 1 (Task T014); full implementation in T018.
 */
export function normalizeStoredOffer(_rawOffer: unknown): FlightOffer | null {
  throw new Error('Not implemented: normalizeStoredOffer TDD RED stub');
}

/**
 * Normalizes a batch of raw Duffel offers with canonical ordering, originalIndex preservation,
 * and mixed currency rejection.
 * TDD RED stub for Feature 029 Phase 3 Slice 1 (Task T014); full implementation in T018.
 */
export function normalizeFlightOffers(
  _rawOffers: readonly unknown[],
): NormalizationResult {
  throw new Error('Not implemented: normalizeFlightOffers TDD RED stub');
}
