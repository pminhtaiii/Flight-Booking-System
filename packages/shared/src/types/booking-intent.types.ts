export type BookingIntentStatus =
  | 'PENDING'
  | 'EXPIRED'
  | 'COMPLETED'
  | 'AWAITING_PAYMENT'
  | 'PAYMENT_EXHAUSTED'
  | 'CONFIRMED'
  | 'CANCELLED';

export type PassengerType = 'ADULT' | 'CHILD' | 'INFANT';

export type PassengerSource =
  | {
      type: 'traveler_profile';
      travelerProfileId: string;
      expectedProfileRevision: number;
    }
  | {
      type: 'inline';
      givenName: string;
      familyName: string;
      dateOfBirth: string;
      gender: string;
      nationality: string;
      passportNumber?: string | null;
      passportExpiry?: string | null;
      email: string;
      phoneCountryCode: string;
      phoneNumber: string;
      title: string;
      middleName?: string | null;
      documentType?: string | null;
      issuingCountry?: string | null;
    };
