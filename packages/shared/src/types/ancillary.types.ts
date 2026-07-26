import type { PassengerType } from './booking-intent.types';

export type AncillaryStatus = 'EMPTY' | 'DRAFT_COMMITTED' | 'VALIDATED' | 'STALE';
export type AncillarySelectionStatus = 'DRAFT_COMMITTED' | 'VALIDATED' | 'STALE' | 'PAYMENT_BOUND';
export type AncillaryCacheStatus = 'HIT' | 'MISS' | 'REFRESHED';
export type BaggageType = 'CHECKED' | 'CARRY_ON';
export type WeightUnit = 'KG' | 'LB';
export type AncillaryErrorCode =
  | 'ANCILLARY_VERSION_CONFLICT'
  | 'ANCILLARY_SELECTION_STALE'
  | 'ANCILLARY_PRICE_CHANGED'
  | 'ANCILLARY_SCOPE_INVALID'
  | 'ANCILLARY_CURRENCY_MISMATCH';

export type MoneyAmount = {
  amount: string;
  currency: string;
};

export type AncillaryPriceBreakdown = {
  seats: string;
  baggage: string;
  ancillaries: string;
  estimatedGrandTotal: string;
  currency?: string;
};

export type AncillaryCatalogSeat = {
  serviceId: string;
  seatDesignator: string;
  amount: string;
  currency: string;
  available: boolean;
  duffelPassengerIds: string[];
};

export type AncillarySeatMapElement = {
  type: 'SEAT' | 'AISLE' | 'EMPTY';
  seat?: AncillaryCatalogSeat;
};

export type AncillarySeatMapRow = {
  rowNumber: string;
  elements: AncillarySeatMapElement[];
};

export type AncillarySeatMapCabin = {
  cabinClass: string;
  rows: AncillarySeatMapRow[];
};

export type AncillaryCatalogSegment = {
  segmentId: string;
  origin: string;
  destination: string;
  seatMapAvailable: boolean;
  seatMap?: { cabins: AncillarySeatMapCabin[] };
};

export type AncillaryBaggageService = {
  serviceId: string;
  duffelPassengerIds: string[];
  segmentIds: string[];
  type: BaggageType;
  weightValue?: number;
  weightUnit?: WeightUnit;
  maximumQuantity: number;
  amount: string;
  currency: string;
};

export type AncillaryCatalog = {
  fetchedAt: string;
  cache: { status: AncillaryCacheStatus; ttlSeconds: number | null };
  fingerprint: string;
  segments: AncillaryCatalogSegment[];
  baggageServices: AncillaryBaggageService[];
};

export type AncillaryPassenger = {
  intentPassengerId: string;
  duffelPassengerId: string;
  displayName: string;
  type: PassengerType;
  seatEligible: boolean;
};

export type AncillarySeatSelection = {
  intentPassengerId: string;
  duffelPassengerId: string;
  segmentId: string;
  serviceId: string;
  seatDesignator: string;
  amount: string;
  currency: string;
};

export type AncillaryBaggageSelection = {
  intentPassengerId: string;
  duffelPassengerId: string;
  serviceId: string;
  type: BaggageType;
  quantity: number;
  segmentIds: string[];
  amount: string;
  currency: string;
};

export type AncillarySelection = {
  id: string;
  version: number;
  status: AncillarySelectionStatus;
  seats: AncillarySeatSelection[];
  baggage: AncillaryBaggageSelection[];
  totals: AncillaryPriceBreakdown;
};

export type AncillaryCatalogResponse = {
  intentId: string;
  selectionId: string | null;
  selectionVersion: number;
  selectionStatus: AncillaryStatus;
  currency: string;
  baseAmount: string;
  catalog: AncillaryCatalog;
  passengers: AncillaryPassenger[];
  selection: Omit<AncillarySelection, 'id' | 'version' | 'status'>;
};

export type CommitAncillarySelectionRequest = {
  expectedVersion: number;
  catalogFingerprint: string;
  seats: Array<Pick<AncillarySeatSelection, 'intentPassengerId' | 'segmentId' | 'serviceId'>>;
  baggage: Array<Pick<AncillaryBaggageSelection, 'intentPassengerId' | 'serviceId' | 'quantity'>>;
};

export type CommitAncillarySelectionResponse = {
  intentId: string;
  selectionId: string;
  selectionVersion: number;
  selectionStatus: 'DRAFT_COMMITTED';
  intentExpiresAt: string;
  selection: Omit<AncillarySelection, 'id' | 'version' | 'status'>;
};

export type AncillaryInvalidSelection = {
  kind: 'SEAT' | 'BAGGAGE';
  serviceId: string;
  intentPassengerId: string;
  segmentIds: string[];
  reason: string;
};

export type AncillaryErrorResponse = {
  statusCode: number;
  code: AncillaryErrorCode;
  message: string;
  intentId: string;
  currentVersion?: number;
  invalidSelections?: AncillaryInvalidSelection[];
  pricing?: {
    previousGrandTotal: string;
    currentGrandTotal: string;
    currency: string;
  };
};
