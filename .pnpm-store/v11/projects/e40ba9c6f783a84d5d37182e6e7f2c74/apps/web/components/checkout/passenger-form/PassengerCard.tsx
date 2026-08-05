import type { FormPassenger, PassengerField } from './types';

type Props = {
  passenger: FormPassenger;
  index: number;
  hasProfile: boolean;
  isInternational: boolean;
  validationErrors: Record<string, string>;
  onUsePrefill: () => void;
  onFieldChange: (index: number, field: PassengerField, value: string) => void;
};

function FieldError({ message }: { message?: string }) {
  return message ? <p role="alert" className="text-xs text-text-cancelled mt-1">{message}</p> : null;
}

export function PassengerCard({ passenger, index, hasProfile, isInternational, validationErrors, onUsePrefill, onFieldChange }: Props) {
  const errorFor = (field: PassengerField) => validationErrors[`${index}-${field}`];
  return (
    <div className="card space-y-6">
      <div className="flex justify-between items-center border-b border-card-border pb-4">
        <h3 className="text-lg font-bold text-text-primary">Passenger {index + 1} ({passenger.type})</h3>
        {index === 0 && passenger.type === 'ADULT' && hasProfile && <button type="button" onClick={onUsePrefill} className="btn-secondary py-1 text-xs">Use my traveler profile details</button>}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div><label className="block text-sm font-medium text-text-secondary mb-1">Given Name *</label><input type="text" value={passenger.givenName} onChange={(event) => onFieldChange(index, 'givenName', event.target.value)} className="form-input w-full" /><FieldError message={errorFor('givenName')} /></div>
        <div><label className="block text-sm font-medium text-text-secondary mb-1">Family Name *</label><input type="text" value={passenger.familyName} onChange={(event) => onFieldChange(index, 'familyName', event.target.value)} className="form-input w-full" /><FieldError message={errorFor('familyName')} /></div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div><label className="block text-sm font-medium text-text-secondary mb-1">Date of Birth *</label><input type="date" value={passenger.dateOfBirth} onChange={(event) => onFieldChange(index, 'dateOfBirth', event.target.value)} className="form-input w-full" /><FieldError message={errorFor('dateOfBirth')} /></div>
        <div><label className="block text-sm font-medium text-text-secondary mb-1">Gender *</label><select value={passenger.gender} onChange={(event) => onFieldChange(index, 'gender', event.target.value)} className="form-input w-full"><option value="male">Male</option><option value="female">Female</option></select></div>
      </div>
      <div className="border-t border-card-border pt-6 space-y-6">
        <h4 className="font-semibold text-text-primary">Passport Details {isInternational ? '*' : '(Optional)'}</h4>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div><label className="block text-sm font-medium text-text-secondary mb-1">Nationality {isInternational && '*'}</label><input type="text" maxLength={2} placeholder="e.g. US" value={passenger.nationality} onChange={(event) => onFieldChange(index, 'nationality', event.target.value)} className="form-input w-full uppercase" /><FieldError message={errorFor('nationality')} /></div>
          <div><label className="block text-sm font-medium text-text-secondary mb-1">Passport Number {isInternational && '*'}</label><input type="text" placeholder="Passport number" value={passenger.passportNumber} onChange={(event) => onFieldChange(index, 'passportNumber', event.target.value)} className="form-input w-full" /><FieldError message={errorFor('passportNumber')} /></div>
          <div><label className="block text-sm font-medium text-text-secondary mb-1">Passport Expiry {isInternational && '*'}</label><input type="date" value={passenger.passportExpiry} onChange={(event) => onFieldChange(index, 'passportExpiry', event.target.value)} className="form-input w-full" /><FieldError message={errorFor('passportExpiry')} /></div>
        </div>
      </div>
    </div>
  );
}
