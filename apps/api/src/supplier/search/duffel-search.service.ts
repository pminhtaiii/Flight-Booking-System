import { Injectable } from '@nestjs/common';
import { CacheService } from '@/cache/cache.service';
import { DuffelRateBudgetService } from '../core/duffel-rate-budget.service';
import { DuffelSearchAdapter } from './duffel-search.adapter';
import {
  FlightOffer,
  FlightSearchCriteria,
  FlightSearchPort,
  FlightSearchResult,
} from './flight-search.port';

@Injectable()
export class DuffelSearchService implements FlightSearchPort {
  constructor(
    private readonly cacheService: CacheService,
    private readonly rateBudgetService: DuffelRateBudgetService,
    private readonly searchAdapter: DuffelSearchAdapter,
  ) {}

  async search(
    _criteria: FlightSearchCriteria,
    _caller: 'user' | 'agent',
  ): Promise<FlightSearchResult> {
    throw new Error('Not implemented: DuffelSearchService.search TDD RED stub');
  }

  async getOfferById(
    _supplierOfferId: string,
    _timeoutMs?: number,
  ): Promise<FlightOffer> {
    throw new Error('Not implemented: DuffelSearchService.getOfferById TDD RED stub');
  }

  normalizeStoredOffer(_rawOffer: unknown): FlightOffer | null {
    throw new Error('Not implemented: DuffelSearchService.normalizeStoredOffer TDD RED stub');
  }
}
