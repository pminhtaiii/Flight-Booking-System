export type BookingIntentStatus = 'PENDING' | 'EXPIRED' | 'COMPLETED' | 'AWAITING_PAYMENT' | 'PAYMENT_EXHAUSTED' | 'CONFIRMED' | 'CANCELLED';

export type PassengerType = 'ADULT' | 'CHILD' | 'INFANT';

export type PassengerSource =
  | {
      type: 'traveler_profile';
      travelerProfileId: string;
      expectedProfileRevision?: number;
    }
  | {
      type: 'inline';
      givenName?: string | null;
      familyName?: string | null;
      dateOfBirth?: string | null;
      gender?: string | null;
      nationality?: string | null;
      passportNumber?: string | null;
      passportExpiry?: string | null;
      email?: string | null;
      phoneCountryCode?: string | null;
      phoneNumber?: string | null;
      title?: string | null;
      middleName?: string | null;
      documentType?: string | null;
      issuingCountry?: string | null;
    };