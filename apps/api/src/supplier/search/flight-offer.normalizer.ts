import { Injectable } from '@nestjs/common';
import { DuffelOffer } from '@/duffel/duffel.types';
import { FlightOffer } from './flight-search.port';

@Injectable()
export class FlightOfferNormalizer {
  generateDeterministicUUID(_input: string): string {
    throw new Error('Not implemented: FlightOfferNormalizer.generateDeterministicUUID TDD RED stub');
  }

  static generateDeterministicUUID(_input: string): string {
    throw new Error('Not implemented: FlightOfferNormalizer.generateDeterministicUUID TDD RED stub');
  }

  normalizeOffer(
    _offer: DuffelOffer,
    _requestedCabinClass?: string,
    _originalIndex?: number,
  ): FlightOffer | null {
    throw new Error('Not implemented: FlightOfferNormalizer.normalizeOffer TDD RED stub');
  }

  static normalizeOffer(
    _offer: DuffelOffer,
    _requestedCabinClass?: string,
    _originalIndex?: number,
  ): FlightOffer | null {
    throw new Error('Not implemented: FlightOfferNormalizer.normalizeOffer TDD RED stub');
  }

  normalizeStoredOffer(_rawOffer: unknown): FlightOffer | null {
    throw new Error('Not implemented: FlightOfferNormalizer.normalizeStoredOffer TDD RED stub');
  }

  static normalizeStoredOffer(_rawOffer: unknown): FlightOffer | null {
    throw new Error('Not implemented: FlightOfferNormalizer.normalizeStoredOffer TDD RED stub');
  }
}

export function generateDeterministicUUID(input: string): string {
  return FlightOfferNormalizer.generateDeterministicUUID(input);
}

export function normalizeOffer(
  offer: DuffelOffer,
  requestedCabinClass?: string,
  originalIndex?: number,
): FlightOffer | null {
  return FlightOfferNormalizer.normalizeOffer(offer, requestedCabinClass, originalIndex);
}

export function normalizeStoredOffer(rawOffer: unknown): FlightOffer | null {
  return FlightOfferNormalizer.normalizeStoredOffer(rawOffer);
}
