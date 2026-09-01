import { Injectable, Logger } from '@nestjs/common';
import { DuffelOffer } from '@/duffel/duffel.types';
import { ScoredOffer, ScoringPreferences } from '@/flight-match/flight-match.types';
import { ProfileService } from '@/profile/profile.service';
import { FlightMatchScorerService } from '@/flight-match/flight-match-scorer.service';
import { normalizeFlightOffers } from './flight-offer-normalizer';

export interface OrchestratorParams {
  readonly rawOffers: readonly DuffelOffer[];
  readonly query: {
    readonly origin: string;
    readonly destination: string;
    readonly departureDate: string;
    readonly returnDate?: string;
    readonly adults: number;
    readonly children?: number;
    readonly infants?: number;
    readonly cabinClass?: string;
  };
  readonly userId?: string | null;
  readonly searchHash: string;
  readonly cached: boolean;
}

export interface OrchestratedFlightResult {
  readonly rawOffer: DuffelOffer;
  readonly scoredOffer: ScoredOffer;
}

export interface SearchMeta {
  readonly totalResults: number;
  readonly searchHash: string;
  readonly cached: boolean;
  readonly requestedCabinClass: string;
  readonly scoringVersion: 'flight-match-v1';
  readonly eligibleCount: number;
  readonly matchLevelCounts: {
    readonly STRONG: number;
    readonly GOOD: number;
    readonly FAIR: number;
    readonly WEAK: number;
  };
}

export interface OrchestratedSearchResponse {
  readonly mode: 'MATCHED';
  readonly results: readonly OrchestratedFlightResult[];
  readonly meta: SearchMeta;
  readonly droppedCount: number;
  readonly rejectionCounts: Readonly<Record<string, number>>;
}

@Injectable()
export class FlightSearchOrchestratorService {
  private readonly logger = new Logger(FlightSearchOrchestratorService.name);

  constructor(
    private readonly profileService: ProfileService,
    private readonly scorer: FlightMatchScorerService,
  ) {}

  async orchestrateSearch(params: OrchestratorParams): Promise<OrchestratedSearchResponse> {
    const normalized = normalizeFlightOffers(params.rawOffers);
    const canonicalOffers = normalized.normalizedOffers.slice(0, 20);

    if (normalized.droppedCount > 0) {
      this.logger.warn(
        `Dropped ${normalized.droppedCount} invalid offers for searchHash ${params.searchHash}`,
        {
          searchHash: params.searchHash,
          droppedCount: normalized.droppedCount,
          rejectionCounts: normalized.rejectionCounts,
        },
      );
    }

    let profilePrefs: ScoringPreferences;
    const trimmedUserId = params.userId?.trim();

    if (trimmedUserId) {
      const fetched = await this.profileService.getScoringPreferences(trimmedUserId);
      profilePrefs = {
        preferredAirlines: fetched.preferredAirlines,
        blacklistedAirlines: fetched.blacklistedAirlines,
        classPreference: fetched.classPreference,
        preferredDepartureWindow: fetched.preferredDepartureWindow,
        preferredArrivalWindow: fetched.preferredArrivalWindow,
        maxStops: fetched.maxStops,
        priceSensitivity: fetched.priceSensitivity,
        requiresCheckedBaggage: fetched.requiresCheckedBaggage,
      };
    } else {
      profilePrefs = {
        preferredAirlines: [],
        blacklistedAirlines: [],
        classPreference: null,
        preferredDepartureWindow: null,
        preferredArrivalWindow: null,
        maxStops: null,
        priceSensitivity: null,
        requiresCheckedBaggage: null,
      };
    }

    const effectiveClassPreference =
      profilePrefs.classPreference !== null
        ? (params.query.cabinClass ?? profilePrefs.classPreference)
        : null;

    const effectivePreferences: ScoringPreferences = {
      ...profilePrefs,
      classPreference: effectiveClassPreference,
    };

    const scoredOffers = this.scorer.scoreAll(canonicalOffers, effectivePreferences);

    const results: OrchestratedFlightResult[] = scoredOffers.map((scoredOffer) => ({
      rawOffer: params.rawOffers[scoredOffer.offer.originalIndex],
      scoredOffer,
    }));

    let eligibleCount = 0;
    const matchLevelCounts = { STRONG: 0, GOOD: 0, FAIR: 0, WEAK: 0 };

    for (const scored of scoredOffers) {
      if (scored.matchResult.eligibility.eligible) {
        eligibleCount++;
        if (scored.matchResult.matchLevel) {
          matchLevelCounts[scored.matchResult.matchLevel]++;
        }
      }
    }

    const meta: SearchMeta = {
      totalResults: canonicalOffers.length,
      searchHash: params.searchHash,
      cached: params.cached,
      requestedCabinClass: params.query.cabinClass || 'economy',
      scoringVersion: 'flight-match-v1',
      eligibleCount,
      matchLevelCounts,
    };

    return {
      mode: 'MATCHED',
      results,
      meta,
      droppedCount: normalized.droppedCount,
      rejectionCounts: normalized.rejectionCounts,
    };
  }
}
