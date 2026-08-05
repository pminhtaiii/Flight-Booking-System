'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface PassengerFormClientProps {
  flight: {
    id: string;
    adults: number;
    children: number;
    infants: number;
  };
  prefill: {
    hasProfile: boolean;
    passenger?: {
      givenName?: string | null;
      familyName?: string | null;
      dateOfBirth?: string | null;
      gender?: string | null;
      nationality?: string | null;
      passportNumber?: string | null;
      passportExpiry?: string | null;
    } | null;
  };
  isInternational: boolean;
  accessToken: string;
  offerId: string;
}

interface FormPassenger {
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

export function PassengerFormClient({
  flight,
  prefill,
  isInternational,
  accessToken,
  offerId,
}: PassengerFormClientProps) {
  const router = useRouter();

  // Construct initial passenger array
  const initialPassengers: FormPassenger[] = [];
  for (let i = 0; i < flight.adults; i++) {
    initialPassengers.push({
      type: 'ADULT',
      givenName: '',
      familyName: '',
      dateOfBirth: '',
      gender: 'male',
      nationality: '',
      passportNumber: '',
      passportExpiry: '',
    });
  }
  for (let i = 0; i < (flight.children || 0); i++) {
    initialPassengers.push({
      type: 'CHILD',
      givenName: '',
      familyName: '',
      dateOfBirth: '',
      gender: 'male',
      nationality: '',
      passportNumber: '',
      passportExpiry: '',
    });
  }
  for (let i = 0; i < (flight.infants || 0); i++) {
    initialPassengers.push({
      type: 'INFANT',
      givenName: '',
      familyName: '',
      dateOfBirth: '',
      gender: 'male',
      nationality: '',
      passportNumber: '',
      passportExpiry: '',
    });
  }

  const [passengers, setPassengers] = useState<FormPassenger[]>(initialPassengers);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});

  const handleUsePrefill = () => {
    if (!prefill.passenger) return;
    const p = prefill.passenger;
    const updated = [...passengers];
    updated[0] = {
      ...updated[0],
      givenName: p.givenName || '',
      familyName: p.familyName || '',
      dateOfBirth: p.dateOfBirth ? p.dateOfBirth.slice(0, 10) : '',
      gender: p.gender || 'male',
      nationality: p.nationality || '',
      passportNumber: p.passportNumber || '',
      passportExpiry: p.passportExpiry ? p.passportExpiry.slice(0, 10) : '',
      useProfile: true,
    };
    setPassengers(updated);
  };

  const handleFieldChange = (index: number, field: keyof FormPassenger, value: string) => {
    const updated = [...passengers];
    updated[index] = {
      ...updated[index],
      [field]: value,
    };
    setPassengers(updated);

    // Clear validation error when field is updated
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

    passengers.forEach((p, index) => {

      if (!p.givenName.trim()) {
        errors[`${index}-givenName`] = 'Given name is required';
      }
      if (!p.familyName.trim()) {
        errors[`${index}-familyName`] = 'Family name is required';
      }
      if (!p.dateOfBirth) {
        errors[`${index}-dateOfBirth`] = 'Date of birth is required';
      } else if (!dateRegex.test(p.dateOfBirth)) {
        errors[`${index}-dateOfBirth`] = 'Use YYYY-MM-DD format';
      }

      if (isInternational) {
        if (!p.nationality.trim()) {
          errors[`${index}-nationality`] = 'Nationality is required';
        } else if (!/^[A-Za-z]{2}$/.test(p.nationality)) {
          errors[`${index}-nationality`] = 'Must be a 2-character code';
        }

        if (!p.passportNumber.trim()) {
          errors[`${index}-passportNumber`] = 'Passport number is required';
        }

        if (!p.passportExpiry) {
          errors[`${index}-passportExpiry`] = 'Passport expiry is required';
        } else if (!dateRegex.test(p.passportExpiry)) {
          errors[`${index}-passportExpiry`] = 'Use YYYY-MM-DD format';
        }
      }
    });

    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!validate()) {
      setError('Please correct the validation errors below.');
      return;
    }

    setLoading(true);

    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

    interface SubmitPassenger {
      type: 'ADULT' | 'CHILD' | 'INFANT';
      givenName: string;
      familyName: string;
      dateOfBirth: string;
      gender: string;
      useProfile?: boolean;
      nationality?: string;
      passportNumber?: string;
      passportExpiry?: string;
    }

    // Format body
    const formattedPassengers = passengers.map((p) => {
      const item: SubmitPassenger = {
        type: p.type,
        givenName: p.givenName.trim(),
        familyName: p.familyName.trim(),
        dateOfBirth: p.dateOfBirth,
        gender: p.gender,
      };

      if (p.useProfile) {
        item.useProfile = true;
      }

      if (isInternational) {
        item.nationality = p.nationality.toUpperCase().trim();
        item.passportNumber = p.passportNumber.trim();
        item.passportExpiry = p.passportExpiry;
      } else {
        // Optionals for domestic
        if (p.nationality.trim()) {
          item.nationality = p.nationality.toUpperCase().trim();
        }
        if (p.passportNumber.trim()) {
          item.passportNumber = p.passportNumber.trim();
        }
        if (p.passportExpiry) {
          item.passportExpiry = p.passportExpiry;
        }
      }

      return item;
    });

    try {
      const response = await fetch(`${apiUrl}/api/bookings/intent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          flightOfferId: offerId,
          passengers: formattedPassengers,
        }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.message || 'Failed to create booking intent.');
      }

      const data = await response.json();
      router.push(`/checkout/${data.intentId}/ancillaries`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'An error occurred during submission.';
      setError(message);
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
        <div key={index} className="card space-y-6">
          <div className="flex justify-between items-center border-b border-card-border pb-4">
            <h3 className="text-lg font-bold text-text-primary">
              Passenger {index + 1} ({passenger.type})
            </h3>
            {index === 0 && passenger.type === 'ADULT' && prefill.hasProfile && (
              <button
                type="button"
                onClick={handleUsePrefill}
                className="btn-secondary py-1 text-xs"
              >
                Use my traveler profile details
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">
                Given Name *
              </label>
              <input
                type="text"
                value={passenger.givenName}
                onChange={(e) => handleFieldChange(index, 'givenName', e.target.value)}
                className="form-input w-full"
              />
              {validationErrors[`${index}-givenName`] && (
                <p role="alert" className="text-xs text-text-cancelled mt-1">
                  {validationErrors[`${index}-givenName`]}
                </p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">
                Family Name *
              </label>
              <input
                type="text"
                value={passenger.familyName}
                onChange={(e) => handleFieldChange(index, 'familyName', e.target.value)}
                className="form-input w-full"
              />
              {validationErrors[`${index}-familyName`] && (
                <p role="alert" className="text-xs text-text-cancelled mt-1">
                  {validationErrors[`${index}-familyName`]}
                </p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">
                Date of Birth *
              </label>
              <input
                type="date"
                value={passenger.dateOfBirth}
                onChange={(e) => handleFieldChange(index, 'dateOfBirth', e.target.value)}
                className="form-input w-full"
              />
              {validationErrors[`${index}-dateOfBirth`] && (
                <p role="alert" className="text-xs text-text-cancelled mt-1">
                  {validationErrors[`${index}-dateOfBirth`]}
                </p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">
                Gender *
              </label>
              <select
                value={passenger.gender}
                onChange={(e) => handleFieldChange(index, 'gender', e.target.value)}
                className="form-input w-full"
              >
                <option value="male">Male</option>
                <option value="female">Female</option>
              </select>
            </div>
          </div>

          {/* Conditional passport fields */}
          <div className="border-t border-card-border pt-6 space-y-6">
            <h4 className="font-semibold text-text-primary">
              Passport Details {isInternational ? '*' : '(Optional)'}
            </h4>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1">
                  Nationality {isInternational && '*'}
                </label>
                <input
                  type="text"
                  maxLength={2}
                  placeholder="e.g. US"
                  value={passenger.nationality}
                  onChange={(e) => handleFieldChange(index, 'nationality', e.target.value)}
                  className="form-input w-full uppercase"
                />
                {validationErrors[`${index}-nationality`] && (
                  <p role="alert" className="text-xs text-text-cancelled mt-1">
                    {validationErrors[`${index}-nationality`]}
                  </p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1">
                  Passport Number {isInternational && '*'}
                </label>
                <input
                  type="text"
                  placeholder="Passport number"
                  value={passenger.passportNumber}
                  onChange={(e) => handleFieldChange(index, 'passportNumber', e.target.value)}
                  className="form-input w-full"
                />
                {validationErrors[`${index}-passportNumber`] && (
                  <p role="alert" className="text-xs text-text-cancelled mt-1">
                    {validationErrors[`${index}-passportNumber`]}
                  </p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1">
                  Passport Expiry {isInternational && '*'}
                </label>
                <input
                  type="date"
                  value={passenger.passportExpiry}
                  onChange={(e) => handleFieldChange(index, 'passportExpiry', e.target.value)}
                  className="form-input w-full"
                />
                {validationErrors[`${index}-passportExpiry`] && (
                  <p role="alert" className="text-xs text-text-cancelled mt-1">
                    {validationErrors[`${index}-passportExpiry`]}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      ))}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={loading}
          className="btn-primary px-8 py-3"
        >
          {loading ? 'Submitting...' : 'Continue to Ancillaries'}
        </button>
      </div>
    </form>
  );
}
