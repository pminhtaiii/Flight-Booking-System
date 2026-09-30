import { Injectable } from '@nestjs/common';
import { FlightSearchCriteria } from './flight-search.port';

@Injectable()
export class DuffelSearchAdapter {
  async searchOffers(_query: unknown): Promise<unknown> {
    throw new Error('Not implemented: DuffelSearchAdapter.searchOffers TDD RED stub');
  }

  async getOffer(_supplierOfferId: string, _timeoutMs?: number): Promise<unknown> {
    throw new Error('Not implemented: DuffelSearchAdapter.getOffer TDD RED stub');
  }
}
