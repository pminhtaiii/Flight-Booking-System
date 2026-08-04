'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { TravelerProfileResponse } from '@/lib/profile-contract';
import type { BookingReadinessResponse, CheckoutPassengerRequest } from '@/lib/checkout';

interface PassengerFormClientProps {
  flight: {
    id: string;
    adults: number;
    children: number;
    infants: number;
  };
  profile: TravelerProfileResponse | null;
  offerPassengers: Array<{ id: string; type: 'ADULT' | 'CHILD' | 'INFANT' }>;
  accessToken: string;
  offerId: string;
}

interface FormPassenger {
  offerPassengerId: string;
  type: 'ADULT' | 'CHILD' | 'INFANT';
  givenName: string;
  familyName: string;
  dateOfBirth: string;
  gender: string;
  title: string;
  email: string;
  phoneCountryCode: string;
  phoneNumber: string;
  nationality: string;
  documentType: string;
  passportNumber: string;
  passportExpiry: string;
  issuingCountry: string;
}

function initialPassengers(
  flight: PassengerFormClientProps['flight'],
  offerPassengers: PassengerFormClientProps['offerPassengers'],
): FormPassenger[] {
  const source = offerPassengers.length > 0
    ? offerPassengers
    : [
        ...Array.from({ length: flight.adults }, () => ({ id: '', type: 'ADULT' as const })),
        ...Array.from({ length: flight.children || 0 }, () => ({ id: '', type: 'CHILD' as const })),
        ...Array.from({ length: flight.infants || 0 }, () => ({ id: '', type: 'INFANT' as const })),
      ];

  return source.map((passenger) => ({
    offerPassengerId: passenger.id,
    type: passenger.type,
    givenName: '',
    familyName: '',
    dateOfBirth: '',
    gender: 'male',
    title: 'Mr',
    email: '',
    phoneCountryCode: '+1',
    phoneNumber: '',
    nationality: '',
    documentType: '',
    passportNumber: '',
    passportExpiry: '',
    issuingCountry: '',
  }));
}

function profileValues(profile: TravelerProfileResponse): Partial<FormPassenger> {
  return {
    givenName: profile.identity?.givenName ?? '',
    familyName: profile.identity?.familyName ?? '',
    dateOfBirth: profile.identity?.dateOfBirth?.slice(0, 10) ?? '',
    gender: profile.identity?.gender ?? 'male',
    title: profile.identity?.title ?? 'Mr',
    email: profile.contact?.email ?? '',
    phoneCountryCode: profile.contact?.phoneCountryCode ?? '+1',
    phoneNumber: profile.contact?.phoneNumber ?? '',
    nationality: profile.travelDocument?.nationality ?? '',
    documentType: profile.travelDocument?.documentType ?? '',
    passportNumber: profile.travelDocument?.passportNumber ?? '',
    passportExpiry: profile.travelDocument?.passportExpiry?.slice(0, 10) ?? '',
    issuingCountry: profile.travelDocument?.issuingCountry ?? '',
  };
}

function safeErrorMessage(status: number, code: unknown): string {
  if (status === 409 && code === 'PROFILE_CHANGED') {
    return 'Your traveler profile changed. Review the passenger details before trying again.';
  }
  if (status === 422 && code === 'BOOKING_NOT_READY') {
    return 'The server needs more passenger details before this booking can continue.';
  }
  if (status === 400 && code === 'PASSENGER_SOURCE_CONFLICT') {
    return 'Passenger details need to be reviewed before this booking can continue.';
  }
  return 'We could not continue this booking. Please review the passenger details and try again.';
}

export function PassengerFormClient({
  flight,
  profile,
  offerPassengers,
  accessToken,
  offerId,
}: PassengerFormClientProps) {
  const router = useRouter();
  const [passengers, setPassengers] = useState<FormPassenger[]>(() => initialPassengers(flight, offerPassengers));
  const [profileSelected, setProfileSelected] = useState(false);
  const [profileStale, setProfileStale] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});

  const handleUseProfile = () => {
    if (!profile?.profileId || !passengers[0]) return;
    const updated = [...passengers];
    updated[0] = { ...updated[0], ...profileValues(profile) };
    setPassengers(updated);
    setProfileSelected(true);
    setError(null);
  };

  const handleFieldChange = (index: number, field: keyof FormPassenger, value: string) => {
    const updated = [...passengers];
    updated[index] = { ...updated[index], [field]: value };
    setPassengers(updated);
    if (index === 0 && profileSelected) setProfileSelected(false);

    const errorKey = `${index}-${field}`;
    if (validationErrors[errorKey]) {
      const copy = { ...validationErrors };
      delete copy[errorKey];
      setValidationErrors(copy);
    }
  };

  const validate = (): boolean => {
    const errors: Record<string, string> = {};
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

    passengers.forEach((passenger, index) => {
      if (!passenger.givenName.trim()) errors[`${index}-givenName`] = 'Given name is required';
      if (!passenger.familyName.trim()) errors[`${index}-familyName`] = 'Family name is required';
      if (!passenger.dateOfBirth || !dateRegex.test(passenger.dateOfBirth)) errors[`${index}-dateOfBirth`] = 'Use YYYY-MM-DD format';
      if (!passenger.title.trim()) errors[`${index}-title`] = 'Title is required';
      if (!/^\S+@\S+\.\S+$/.test(passenger.email.trim())) errors[`${index}-email`] = 'Enter a valid email address';
      if (!/^\+\d{1,4}$/.test(passenger.phoneCountryCode.trim())) errors[`${index}-phoneCountryCode`] = 'Enter a valid country code';
      if (!/^\d{4,20}$/.test(passenger.phoneNumber.trim())) errors[`${index}-phoneNumber`] = 'Enter a valid phone number';
      if (passenger.nationality.trim() && passenger.nationality.trim().length !== 2) errors[`${index}-nationality`] = 'Nationality must be a 2-letter country code';
      if (passenger.issuingCountry.trim() && passenger.issuingCountry.trim().length !== 2) errors[`${index}-issuingCountry`] = 'Issuing Country must be a 2-letter country code';
    });

    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const buildSources = (): CheckoutPassengerRequest[] => passengers.map((passenger, index) => ({
    offerPassengerId: passenger.offerPassengerId || `passenger-${index + 1}`,
    type: passenger.type,
    source: profileSelected && index === 0 && profile?.profileId
      ? {
          type: 'traveler_profile' as const,
          travelerProfileId: profile.profileId,
          expectedProfileRevision: profile.revision,
        }
      : {
          type: 'inline' as const,
          givenName: passenger.givenName.trim(),
          familyName: passenger.familyName.trim(),
          dateOfBirth: passenger.dateOfBirth,
          gender: passenger.gender,
          nationality: passenger.nationality.trim().toUpperCase() || undefined,
          documentType: passenger.documentType.trim() || null,
          passportNumber: passenger.passportNumber.trim() || null,
          passportExpiry: passenger.passportExpiry || null,
          issuingCountry: passenger.issuingCountry.trim().toUpperCase() || null,
          email: passenger.email.trim(),
          phoneCountryCode: passenger.phoneCountryCode.trim(),
          phoneNumber: passenger.phoneNumber.trim(),
          title: passenger.title.trim(),
        },
  }));

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!validate()) {
      setError('Please correct the validation errors below.');
      return;
    }

    setLoading(true);
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
    const traceId = globalThis.crypto?.randomUUID?.() ?? `checkout-${Date.now()}`;
    const correlationId = globalThis.crypto?.randomUUID?.() ?? `booking-${Date.now()}`;
    const sources = buildSources();

    try {
      const readinessResponse = await fetch(`${apiUrl}/api/bookings/intents/readiness`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          'x-trace-id': traceId,
          'x-correlation-id': correlationId,
        },
        cache: 'no-store',
        body: JSON.stringify({
          flightOfferId: offerId,
          passengers: sources.map((passenger) => ({
            offerPassengerId: passenger.offerPassengerId,
            passengerType: passenger.type,
            source: passenger.source,
          })),
        }),
      });
      const readiness = (await readinessResponse.json().catch(() => null)) as BookingReadinessResponse | { code?: string } | null;
      if (!readinessResponse.ok) {
        throw new Error(safeErrorMessage(readinessResponse.status, readiness && 'code' in readiness ? readiness.code : null));
      }
      if (!readiness || !('ready' in readiness) || !readiness.ready) {
        throw new Error('The server needs more passenger details before this booking can continue.');
      }

      const createResponse = await fetch(`${apiUrl}/api/bookings/intents`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          'x-trace-id': traceId,
          'x-correlation-id': correlationId,
        },
        cache: 'no-store',
        body: JSON.stringify({
          flightOfferId: offerId,
          readinessScope: readiness.scope,
          passengers: sources,
        }),
      });
      const createBody = await createResponse.json().catch(() => null) as { code?: string; intentId?: string } | null;
      if (!createResponse.ok || !createBody?.intentId) {
        if (createResponse.status === 409 && createBody?.code === 'PROFILE_CHANGED') {
          setProfileSelected(false);
          setProfileStale(true);
          setPassengers((prev) => {
            const updated = [...prev];
            if (updated[0]) {
              updated[0] = {
                ...updated[0],
                givenName: '',
                familyName: '',
                dateOfBirth: '',
                gender: 'male',
                title: 'Mr',
                email: '',
                phoneCountryCode: '+1',
                phoneNumber: '',
                nationality: '',
                documentType: '',
                passportNumber: '',
                passportExpiry: '',
                issuingCountry: '',
              };
            }
            return updated;
          });
        }
        throw new Error(safeErrorMessage(createResponse.status, createBody?.code));
      }

      router.push(`/checkout/${createBody.intentId}/ancillaries`);
    } catch (submissionError: unknown) {
      setError(submissionError instanceof Error ? submissionError.message : 'We could not continue this booking.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-8">
      {error && (
        <div role="alert" className="card bg-bg-cancelled text-text-cancelled p-4">
          <p className="font-semibold text-text-cancelled">Submission Error</p>
          <p className="text-sm mt-1">{error}</p>
        </div>
      )}

      {passengers.map((passenger, index) => (
        <div key={passenger.offerPassengerId || index} className="card space-y-6">
          <div className="flex justify-between items-center border-b border-card-border pb-4">
            <h3 className="text-lg font-bold text-text-primary">Passenger {index + 1} ({passenger.type})</h3>
            {index === 0 && passenger.type === 'ADULT' && profile?.profileId && !profileStale && (
              <button type="button" onClick={handleUseProfile} className="btn-secondary py-1 text-xs">
                Use my traveler profile details
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <label className="block text-sm font-medium text-text-secondary">Title
              <select value={passenger.title} onChange={(event) => handleFieldChange(index, 'title', event.target.value)} className="form-input w-full mt-1">
                <option value="Mr">Mr</option><option value="Mrs">Mrs</option><option value="Ms">Ms</option><option value="Miss">Miss</option><option value="Mx">Mx</option>
              </select>
            </label>
            <label className="block text-sm font-medium text-text-secondary">Given Name *<input value={passenger.givenName} onChange={(event) => handleFieldChange(index, 'givenName', event.target.value)} className="form-input w-full mt-1" /></label>
            <label className="block text-sm font-medium text-text-secondary">Family Name *<input value={passenger.familyName} onChange={(event) => handleFieldChange(index, 'familyName', event.target.value)} className="form-input w-full mt-1" /></label>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <label className="block text-sm font-medium text-text-secondary">Date of Birth *<input type="date" value={passenger.dateOfBirth} onChange={(event) => handleFieldChange(index, 'dateOfBirth', event.target.value)} className="form-input w-full mt-1" /></label>
            <label className="block text-sm font-medium text-text-secondary">Gender *<select value={passenger.gender} onChange={(event) => handleFieldChange(index, 'gender', event.target.value)} className="form-input w-full mt-1"><option value="male">Male</option><option value="female">Female</option></select></label>
            <label className="block text-sm font-medium text-text-secondary">Nationality<input maxLength={2} value={passenger.nationality} onChange={(event) => handleFieldChange(index, 'nationality', event.target.value)} className="form-input w-full mt-1 uppercase" /></label>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <label className="block text-sm font-medium text-text-secondary">Email *<input type="email" value={passenger.email} onChange={(event) => handleFieldChange(index, 'email', event.target.value)} className="form-input w-full mt-1" /></label>
            <label className="block text-sm font-medium text-text-secondary">Phone Country Code *<input value={passenger.phoneCountryCode} onChange={(event) => handleFieldChange(index, 'phoneCountryCode', event.target.value)} className="form-input w-full mt-1" /></label>
            <label className="block text-sm font-medium text-text-secondary">Phone Number *<input value={passenger.phoneNumber} onChange={(event) => handleFieldChange(index, 'phoneNumber', event.target.value)} className="form-input w-full mt-1" /></label>
          </div>

          <div className="border-t border-card-border pt-6 space-y-6">
            <h4 className="font-semibold text-text-primary">Travel Document (if required)</h4>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
              <label className="block text-sm font-medium text-text-secondary">Document Type<input value={passenger.documentType} onChange={(event) => handleFieldChange(index, 'documentType', event.target.value)} className="form-input w-full mt-1" /></label>
              <label className="block text-sm font-medium text-text-secondary">Passport Number<input value={passenger.passportNumber} onChange={(event) => handleFieldChange(index, 'passportNumber', event.target.value)} className="form-input w-full mt-1" /></label>
              <label className="block text-sm font-medium text-text-secondary">Passport Expiry<input type="date" value={passenger.passportExpiry} onChange={(event) => handleFieldChange(index, 'passportExpiry', event.target.value)} className="form-input w-full mt-1" /></label>
              <label className="block text-sm font-medium text-text-secondary">Issuing Country<input maxLength={2} value={passenger.issuingCountry} onChange={(event) => handleFieldChange(index, 'issuingCountry', event.target.value)} className="form-input w-full mt-1 uppercase" /></label>
            </div>
          </div>
        </div>
      ))}

      <div className="flex justify-end">
        <button type="submit" disabled={loading} className="btn-primary px-8 py-3">
          {loading ? 'Checking readiness...' : 'Continue to Ancillaries'}
        </button>
      </div>
    </form>
  );
}
