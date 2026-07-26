export type AncillaryCabinClass = 'economy' | 'premium_economy' | 'business' | 'first' | string;

export type AncillaryRowElementType =
  | 'seat'
  | 'empty'
  | 'aisle'
  | 'lavatory'
  | 'galley'
  | 'closet'
  | 'stairs'
  | 'elevator'
  | 'bassinet'
  | 'exits'
  | 'exit_row'
  | string;

export type AncillarySeatService = {
  serviceId: string;
  passengerId: string; // Supplier (Duffel) passenger ID
  amount: string;
  currency: string;
};

export type AncillaryRowElement = {
  type: AncillaryRowElementType;
  designator?: string;
  availableServices?: AncillarySeatService[];
  restricted?: boolean;
};

export type AncillaryRow = {
  rowNumber: number;
  elements: AncillaryRowElement[];
};

export type AncillaryCabin = {
  cabinClass: AncillaryCabinClass;
  rows: AncillaryRow[];
};

export type AncillarySeatMap = {
  cabins: AncillaryCabin[];
};

export type AncillarySegment = {
  segmentId: string;
  origin: string;
  destination: string;
  seatMapAvailable: boolean;
  seatMap: AncillarySeatMap | null;
};

export type AncillaryBaggageService = {
  serviceId: string;
  passengerId: string; // Supplier (Duffel) passenger ID
  segmentIds: string[];
  type: 'checked' | 'carry_on' | string;
  weightValue: number | null;
  weightUnit: string | null;
  maxQuantity: number;
  amount: string;
  currency: string;
};

export type AncillaryCatalog = {
  fetchedAt: string;
  cache: {
    status: 'HIT' | 'MISS';
    ttlSeconds: number;
  };
  segments: AncillarySegment[];
  baggageServices: AncillaryBaggageService[];
};

export type NormalizedSeatSelection = {
  intentPassengerId: string;
  segmentId: string;
  serviceId: string;
  seatDesignator: string;
  amount: string;
  currency: string;
};

export type NormalizedBaggageSelection = {
  intentPassengerId: string;
  serviceId: string;
  type: 'checked' | 'carry_on' | string;
  weightValue: number | null;
  weightUnit: string | null;
  quantity: number;
  amount: string;
  currency: string;
  segmentIds: string[];
};

export type AncillaryTotals = {
  seats: string;
  baggage: string;
  ancillaries: string;
  estimatedGrandTotal: string;
  currency: string;
};

export type AncillarySelectionSnapshot = {
  seats: NormalizedSeatSelection[];
  baggage: NormalizedBaggageSelection[];
  totals: AncillaryTotals;
};

export type AncillaryPassenger = {
  intentPassengerId: string;
  duffelPassengerId: string;
  displayName: string;
  type: 'ADULT' | 'CHILD' | 'INFANT';
  seatEligible: boolean;
};

export type AncillaryCatalogResponse = {
  intentId: string;
  selectionId: string | null;
  selectionVersion: number;
  selectionStatus: 'EMPTY' | 'DRAFT_COMMITTED' | 'VALIDATED' | 'STALE' | 'PAYMENT_BOUND';
  currency: string | null;
  baseAmount: string | null;
  catalog: AncillaryCatalog;
  passengers: AncillaryPassenger[];
  selection: AncillarySelectionSnapshot;
};

export type AncillaryRepriceInput = {
  offerId: string;
  intendedServices: {
    serviceId: string;
    quantity: number;
  }[];
};

export type AncillaryServiceLine = {
  serviceId: string;
  amount: string;
  quantity: number;
};

export type AncillaryRepriceOutput = {
  totalAmount: string;
  baseAmount: string;
  serviceLines: AncillaryServiceLine[];
  currency: string;
  invalidServiceIdentities: string[];
};
