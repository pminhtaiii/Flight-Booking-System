export interface AmadeusCarrierDictionary {
  [code: string]: string;
}

export interface AmadeusDictionaries {
  carriers?: AmadeusCarrierDictionary;
  locations?: Record<string, unknown>;
  aircraft?: Record<string, unknown>;
  currencies?: Record<string, unknown>;
}

export interface AmadeusSegment {
  departure: {
    iataCode: string;
    terminal?: string;
    at: string;
  };
  arrival: {
    iataCode: string;
    terminal?: string;
    at: string;
  };
  carrierCode: string;
  number: string;
  aircraft?: {
    code: string;
  };
  duration?: string;
  numberOfStops?: number;
}

export interface AmadeusItinerary {
  duration: string;
  segments: AmadeusSegment[];
}

export interface AmadeusBaggageAllowance {
  quantity?: number;
  weight?: number;
  weightUnit?: string;
}

export interface AmadeusFareDetailsBySegment {
  segmentId: string;
  cabin: string;
  fareBasis?: string;
  class?: string;
  includedCheckedBags?: AmadeusBaggageAllowance;
}

export interface AmadeusTravelerPricing {
  travelerId: string;
  fareOption: string;
  travelerType: string;
  price: {
    currency: string;
    total: string;
    base: string;
  };
  fareDetailsBySegment: AmadeusFareDetailsBySegment[];
}

export interface AmadeusFlightOffer {
  id: string;
  source: string;
  instantTicketingRequired: boolean;
  nonHomogeneous: boolean;
  oneWay: boolean;
  lastTicketingDate: string;
  numberOfBookableSeats: number;
  itineraries: AmadeusItinerary[];
  price: {
    currency: string;
    total: string;
    base: string;
    fees?: unknown[];
    grandTotal?: string;
  };
  pricingOptions: {
    fareType: string[];
    includedCheckedBagsOnly: boolean;
  };
  validatingCarrierCodes: string[];
  travelerPricings: AmadeusTravelerPricing[];
}

export interface AmadeusFlightSearchResponse {
  data: AmadeusFlightOffer[];
  dictionaries?: AmadeusDictionaries;
}
