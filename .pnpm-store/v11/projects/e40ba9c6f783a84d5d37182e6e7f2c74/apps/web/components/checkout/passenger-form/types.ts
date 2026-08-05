export interface PassengerFormClientProps {
  flight: {
    id: string;
    adults: number;
    children: number;
    infants: number;
  };
  prefill: {
    hasProfile: boolean;
    passenger?: PassengerProfile | null;
  };
  isInternational: boolean;
  accessToken: string;
  offerId: string;
}

export interface PassengerProfile {
  givenName?: string | null;
  familyName?: string | null;
  dateOfBirth?: string | null;
  gender?: string | null;
  nationality?: string | null;
  passportNumber?: string | null;
  passportExpiry?: string | null;
}

export interface FormPassenger {
  type: 'ADULT' | 'CHILD' | 'INFANT';
  givenName: string;
  familyName: string;
  dateOfBirth: string;
  gender: string;
  nationality: string;
  passportNumber: string;
  passportExpiry: string;
  useProfile?: boolean;
}

export type PassengerField = keyof FormPassenger;
