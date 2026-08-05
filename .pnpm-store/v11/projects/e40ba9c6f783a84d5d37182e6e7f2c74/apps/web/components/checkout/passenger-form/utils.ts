import type { FormPassenger, PassengerProfile } from './types';

const passengerTypes = ['ADULT', 'CHILD', 'INFANT'] as const;

const createPassenger = (type: FormPassenger['type']): FormPassenger => ({
  type,
  givenName: '',
  familyName: '',
  dateOfBirth: '',
  gender: 'male',
  nationality: '',
  passportNumber: '',
  passportExpiry: '',
});

export function createInitialPassengers(flight: { adults: number; children: number; infants: number }): FormPassenger[] {
  return passengerTypes.flatMap((type) => {
    const count = flight[`${type.toLowerCase()}s` as 'adults' | 'children' | 'infants'] || 0;
    return Array.from({ length: count }, () => createPassenger(type));
  });
}

export function applyProfilePrefill(passenger: FormPassenger, profile: PassengerProfile): FormPassenger {
  return {
    ...passenger,
    givenName: profile.givenName || '',
    familyName: profile.familyName || '',
    dateOfBirth: profile.dateOfBirth ? profile.dateOfBirth.slice(0, 10) : '',
    gender: profile.gender || 'male',
    nationality: profile.nationality || '',
    passportNumber: profile.passportNumber || '',
    passportExpiry: profile.passportExpiry ? profile.passportExpiry.slice(0, 10) : '',
    useProfile: true,
  };
}

export function validatePassengers(passengers: FormPassenger[], isInternational: boolean): Record<string, string> {
  const errors: Record<string, string> = {};
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

  passengers.forEach((passenger, index) => {
    if (!passenger.givenName.trim()) errors[`${index}-givenName`] = 'Given name is required';
    if (!passenger.familyName.trim()) errors[`${index}-familyName`] = 'Family name is required';
    if (!passenger.dateOfBirth) errors[`${index}-dateOfBirth`] = 'Date of birth is required';
    else if (!dateRegex.test(passenger.dateOfBirth)) errors[`${index}-dateOfBirth`] = 'Use YYYY-MM-DD format';

    if (isInternational) {
      if (!passenger.nationality.trim()) errors[`${index}-nationality`] = 'Nationality is required';
      else if (!/^[A-Za-z]{2}$/.test(passenger.nationality)) errors[`${index}-nationality`] = 'Must be a 2-character code';
      if (!passenger.passportNumber.trim()) errors[`${index}-passportNumber`] = 'Passport number is required';
      if (!passenger.passportExpiry) errors[`${index}-passportExpiry`] = 'Passport expiry is required';
      else if (!dateRegex.test(passenger.passportExpiry)) errors[`${index}-passportExpiry`] = 'Use YYYY-MM-DD format';
    }
  });

  return errors;
}

export function formatPassengersForSubmit(passengers: FormPassenger[], isInternational: boolean) {
  return passengers.map((passenger) => {
    const item: {
      type: FormPassenger['type']; givenName: string; familyName: string; dateOfBirth: string; gender: string;
      useProfile?: boolean; nationality?: string; passportNumber?: string; passportExpiry?: string;
    } = {
      type: passenger.type,
      givenName: passenger.givenName.trim(),
      familyName: passenger.familyName.trim(),
      dateOfBirth: passenger.dateOfBirth,
      gender: passenger.gender,
    };
    if (passenger.useProfile) item.useProfile = true;
    if (isInternational || passenger.nationality.trim()) item.nationality = passenger.nationality.toUpperCase().trim();
    if (isInternational || passenger.passportNumber.trim()) item.passportNumber = passenger.passportNumber.trim();
    if (isInternational || passenger.passportExpiry) item.passportExpiry = passenger.passportExpiry;
    return item;
  });
}
