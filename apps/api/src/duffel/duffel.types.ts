export interface DuffelBaggage {
  type: 'checked' | 'carry_on' | string;
  quantity?: number;
  weight?: number;
  weight_unit?: string;
}

export interface DuffelPassenger {
  id: string;
  type: 'adult' | 'child' | 'infant' | string;
  baggages?: DuffelBaggage[];
}

export interface DuffelSegmentPassenger {
  passenger_id: string;
  cabin_class: string;
  baggages?: DuffelBaggage[];
}

export interface DuffelPlace {
  id: string;
  name: string;
  iata_code: string;
  type: string;
}

export interface DuffelAirline {
  id: string;
  name: string;
  iata_code: string;
}

export interface DuffelAircraft {
  id: string;
  name: string;
  iata_code: string;
}

export interface DuffelSegment {
  id: string;
  duration: string;
  departing_at: string;
  arriving_at: string;
  origin: DuffelPlace;
  destination: DuffelPlace;
  origin_terminal?: string | null;
  destination_terminal?: string | null;
  operating_carrier: DuffelAirline;
  marketing_carrier: DuffelAirline;
  marketing_carrier_flight_number: string;
  aircraft?: DuffelAircraft;
  passengers?: DuffelSegmentPassenger[];
}

export interface DuffelSlice {
  id: string;
  duration: string;
  origin: DuffelPlace;
  destination: DuffelPlace;
  segments: DuffelSegment[];
  departure_date?: string;
}

export interface DuffelOffer {
  id: string;
  total_amount: string;
  total_currency: string;
  slices: DuffelSlice[];
  passengers: DuffelPassenger[];
  passenger_identity_documents_required: boolean;
}

export interface DuffelOfferRequest {
  id: string;
  offers: DuffelOffer[];
  slices: DuffelSlice[];
  passengers: DuffelPassenger[];
}

export interface DuffelOrder {
  id: string;
  slices: DuffelSlice[];
  passengers: {
    id: string;
    type: string;
    title?: string | null;
    given_name?: string | null;
    family_name?: string | null;
    born_on?: string | null;
    email?: string | null;
    phone_number?: string | null;
  }[];
  cancelled_at?: string | null;
  cancellation?: {
    id: string;
    confirmed_at: string | null;
  } | null;
  booking_reference?: string;
  metadata?: Record<string, unknown>;
}

