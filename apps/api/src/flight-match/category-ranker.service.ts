import { Injectable } from '@nestjs/common';
import { compareObjectiveTiers } from './flight-match.policy';
import type { FlightMatchInput } from './flight-match.types';

/**
 * Pure, deterministic service that applies the 5-tier objective sorting criteria
 * for cold-start (unpersonalized) flight search results:
 *
 * 1. stops ascending (direct/nonstop flights first, then 1 stop, then 2 stops...)
 * 2. price ascending (cheapest flight first among equal stops)
 * 3. duration ascending (shortest total travel duration among equal price and stops)
 * 4. departure red-eye penalty ascending (daytime departure 0 ahead of red-eye departure 1)
 * 5. originalIndex ascending (stable final tie-breaker preserving supplier index)
 *
 * Invariants:
 * - Pure computation: 0 DB, 0 HTTP, 0 Redis, 0 logs.
 * - Deterministic, non-mutating.
 */
@Injectable()
export class CategoryRankerService {
  /**
   * Sorts the given flight offers according to the 5-tier objective category ordering.
   *
   * @param offers Readonly array of normalized flight match inputs.
   * @returns Readonly array of ranked flight match inputs.
   */
  rank(offers: readonly FlightMatchInput[]): readonly FlightMatchInput[] {
    if (offers.length <= 1) {
      return [...offers];
    }

    return [...offers].sort(compareObjectiveTiers);
  }
}

