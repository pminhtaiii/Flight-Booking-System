'use client';

import { FormEvent, useMemo, useState } from 'react';
import type { HourWindow, PriceSensitivity } from '@shared/types';
import styles from '@/app/prototype/profile/profile-prototype.module.css';
import {
  ProfileRequestError,
  type TravelerProfileResponse,
  type UpdateProfilePayload,
} from '@/lib/profile-contract';
import { fetchBrowserProfile, updateBrowserProfile } from '@/lib/profile-browser';

type ProfileSection = 'identity' | 'contact' | 'travelDocument' | 'preferences';
type SaveState = 'idle' | 'saving' | 'saved' | 'conflict' | 'error';
type SelectOption = { value: string; label: string };

type ProfileDraft = {
  identity: {
    givenName: string;
    middleName: string;
    familyName: string;
    dateOfBirth: string;
    gender: string;
    title: string;
  };
  contact: {
    email: string;
    phoneCountryCode: string;
    phoneNumber: string;
  };
  travelDocument: {
    documentType: string;
    passportNumber: string;
    passportExpiry: string;
    issuingCountry: string;
    nationality: string;
  };
  preferences: {
    seatPreference: string;
    classPreference: string;
    preferredAirlines: string;
    blacklistedAirlines: string;
    preferredDepartureStart: string;
    preferredDepartureEnd: string;
    preferredArrivalStart: string;
    preferredArrivalEnd: string;
    maxStops: string;
    priceSensitivity: string;
    requiresCheckedBaggage: string;
  };
};

const sectionLabels: Record<ProfileSection, string> = {
  identity: 'Identity',
  contact: 'Contact details',
  travelDocument: 'Travel document',
  preferences: 'Travel preferences',
};

const sectionDescriptions: Record<ProfileSection, string> = {
  identity: 'Use your name exactly as it appears on your travel document.',
  contact: 'We only use these details for booking updates and support.',
  travelDocument: 'Stored securely and only used when a booking requires it.',
  preferences: 'Optional defaults that make future searches faster.',
};

const titleOptions: SelectOption[] = [
  { value: '', label: 'Select a title' },
  { value: 'mr', label: 'Mr' },
  { value: 'ms', label: 'Ms' },
  { value: 'mrs', label: 'Mrs' },
  { value: 'mx', label: 'Mx' },
];

const genderOptions: SelectOption[] = [
  { value: '', label: 'Select a gender' },
  { value: 'female', label: 'Female' },
  { value: 'male', label: 'Male' },
  { value: 'non-binary', label: 'Non-binary' },
  { value: 'prefer-not-to-say', label: 'Prefer not to say' },
];

const documentOptions: SelectOption[] = [
  { value: '', label: 'Select a document' },
  { value: 'passport', label: 'Passport' },
  { value: 'national-id', label: 'National ID' },
];

const countryOptions: SelectOption[] = [
  { value: '', label: 'Select a country' },
  { value: 'VN', label: 'Vietnam' },
  { value: 'SG', label: 'Singapore' },
  { value: 'JP', label: 'Japan' },
  { value: 'US', label: 'United States' },
  { value: 'GB', label: 'United Kingdom' },
];

const phoneCountryOptions: SelectOption[] = [
  { value: '+84', label: 'VN +84' },
  { value: '+65', label: 'SG +65' },
  { value: '+81', label: 'JP +81' },
  { value: '+1', label: 'US +1' },
  { value: '+44', label: 'GB +44' },
];

const seatOptions: SelectOption[] = [
  { value: '', label: 'No preference' },
  { value: 'window', label: 'Window' },
  { value: 'aisle', label: 'Aisle' },
];

const classOptions: SelectOption[] = [
  { value: '', label: 'No preference' },
  { value: 'economy', label: 'Economy' },
  { value: 'premium-economy', label: 'Premium economy' },
  { value: 'business', label: 'Business' },
];

const maxStopsOptions: SelectOption[] = [
  { value: '', label: 'Any' },
  { value: '0', label: 'Direct only' },
  { value: '1', label: 'Max 1 stop' },
  { value: '2', label: 'Max 2 stops' },
];

const priceSensitivityOptions: SelectOption[] = [
  { value: '', label: 'No preference' },
  { value: 'BUDGET', label: 'Budget-conscious' },
  { value: 'MODERATE', label: 'Moderate' },
  { value: 'FLEXIBLE', label: 'Flexible' },
];

const baggageOptions: SelectOption[] = [
  { value: '', label: 'No preference' },
  { value: 'true', label: 'Checked bag required' },
  { value: 'false', label: 'Carry-on only / Not required' },
];

const hourOptions: SelectOption[] = [
  { value: '', label: 'No time preference' },
  ...Array.from({ length: 24 }, (_, i) => ({
    value: String(i),
    label: `${String(i).padStart(2, '0')}:00`,
  })),
];

function valueOrEmpty(value: string | null | undefined): string {
  return value ?? '';
}

function parseWindowToDraft(
  window?: HourWindow | null,
): { start: string; end: string } {
  if (!window || typeof window.start !== 'number' || typeof window.end !== 'number') {
    return { start: '', end: '' };
  }
  return { start: String(window.start), end: String(window.end) };
}

function parseWindowDraft(startStr: string, endStr: string): HourWindow | null {
  if (!startStr.trim() || !endStr.trim()) {
    return null;
  }
  const start = Number(startStr);
  const end = Number(endStr);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return null;
  }
  return { start, end };
}

function profileToDraft(profile: TravelerProfileResponse): ProfileDraft {
  const departureWindow = parseWindowToDraft(profile.preferences?.preferredDepartureWindow);
  const arrivalWindow = parseWindowToDraft(profile.preferences?.preferredArrivalWindow);

  return {
    identity: {
      givenName: valueOrEmpty(profile.identity?.givenName),
      middleName: valueOrEmpty(profile.identity?.middleName),
      familyName: valueOrEmpty(profile.identity?.familyName),
      dateOfBirth: valueOrEmpty(profile.identity?.dateOfBirth),
      gender: valueOrEmpty(profile.identity?.gender),
      title: valueOrEmpty(profile.identity?.title),
    },
    contact: {
      email: valueOrEmpty(profile.contact?.email),
      phoneCountryCode: valueOrEmpty(profile.contact?.phoneCountryCode),
      phoneNumber: valueOrEmpty(profile.contact?.phoneNumber),
    },
    travelDocument: {
      documentType: valueOrEmpty(profile.travelDocument?.documentType),
      passportNumber: valueOrEmpty(profile.travelDocument?.passportNumber),
      passportExpiry: valueOrEmpty(profile.travelDocument?.passportExpiry),
      issuingCountry: valueOrEmpty(profile.travelDocument?.issuingCountry),
      nationality: valueOrEmpty(profile.travelDocument?.nationality),
    },
    preferences: {
      seatPreference: valueOrEmpty(profile.preferences?.seatPreference),
      classPreference: valueOrEmpty(profile.preferences?.classPreference),
      preferredAirlines: profile.preferences?.preferredAirlines?.join(', ') ?? '',
      blacklistedAirlines: profile.preferences?.blacklistedAirlines?.join(', ') ?? '',
      preferredDepartureStart: departureWindow.start,
      preferredDepartureEnd: departureWindow.end,
      preferredArrivalStart: arrivalWindow.start,
      preferredArrivalEnd: arrivalWindow.end,
      maxStops:
        profile.preferences?.maxStops != null ? String(profile.preferences.maxStops) : '',
      priceSensitivity: profile.preferences?.priceSensitivity ?? '',
      requiresCheckedBaggage:
        profile.preferences?.requiresCheckedBaggage === true
          ? 'true'
          : profile.preferences?.requiresCheckedBaggage === false
            ? 'false'
            : '',
    },
  };
}

function parseAirlineCodes(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(',')
        .map((code) => code.trim().toUpperCase())
        .filter((code) => /^[A-Z0-9]{2,3}$/.test(code)),
    ),
  );
}

function draftToPayload(draft: ProfileDraft, revision: number): UpdateProfilePayload {
  const documentValues = Object.values(draft.travelDocument);
  const hasTravelDocument = documentValues.some((value) => value.trim().length > 0);

  return {
    expectedRevision: revision,
    identity: {
      givenName: draft.identity.givenName.trim(),
      middleName: draft.identity.middleName.trim() || null,
      familyName: draft.identity.familyName.trim(),
      dateOfBirth: draft.identity.dateOfBirth,
      gender: draft.identity.gender,
      title: draft.identity.title,
    },
    contact: {
      email: draft.contact.email.trim(),
      phoneCountryCode: draft.contact.phoneCountryCode,
      phoneNumber: draft.contact.phoneNumber.trim(),
    },
    travelDocument: hasTravelDocument
      ? {
          documentType: draft.travelDocument.documentType,
          passportNumber: draft.travelDocument.passportNumber.trim(),
          passportExpiry: draft.travelDocument.passportExpiry,
          issuingCountry: draft.travelDocument.issuingCountry,
          nationality: draft.travelDocument.nationality,
        }
      : null,
    preferences: {
      seatPreference: draft.preferences.seatPreference || null,
      classPreference: draft.preferences.classPreference || null,
      preferredAirlines: parseAirlineCodes(draft.preferences.preferredAirlines),
      blacklistedAirlines: parseAirlineCodes(draft.preferences.blacklistedAirlines),
      preferredDepartureWindow: parseWindowDraft(
        draft.preferences.preferredDepartureStart,
        draft.preferences.preferredDepartureEnd,
      ),
      preferredArrivalWindow: parseWindowDraft(
        draft.preferences.preferredArrivalStart,
        draft.preferences.preferredArrivalEnd,
      ),
      maxStops: draft.preferences.maxStops !== '' ? Number(draft.preferences.maxStops) : null,
      priceSensitivity: draft.preferences.priceSensitivity
        ? (draft.preferences.priceSensitivity as PriceSensitivity)
        : null,
      requiresCheckedBaggage:
        draft.preferences.requiresCheckedBaggage === 'true'
          ? true
          : draft.preferences.requiresCheckedBaggage === 'false'
            ? false
            : null,
    },
  };
}

function getMaskedPassport(passportNumber: string): string {
  if (!passportNumber) {
    return 'Not added';
  }

  return `•••• ${passportNumber.slice(-4)}`;
}

function getSectionStatus(values: string[], optional = false): 'complete' | 'attention' {
  if (optional) {
    return 'complete';
  }

  return values.every((value) => value.trim().length > 0) ? 'complete' : 'attention';
}

function getStatusLabel(status: 'complete' | 'attention', optional = false): string {
  if (optional) {
    return 'Optional';
  }

  return status === 'complete' ? 'Complete' : 'Needs attention';
}

export function TravelerProfileForm({
  initialProfile,
  returnTarget = '/',
}: {
  initialProfile: TravelerProfileResponse;
  returnTarget?: string;
}): JSX.Element {
  const [profile, setProfile] = useState<TravelerProfileResponse>(initialProfile);
  const [draft, setDraft] = useState<ProfileDraft>(() => profileToDraft(initialProfile));
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [showPassport, setShowPassport] = useState(false);

  const sectionStatuses = useMemo<Record<ProfileSection, 'complete' | 'attention'>>(
    () => ({
      identity: getSectionStatus([
        draft.identity.givenName,
        draft.identity.familyName,
        draft.identity.dateOfBirth,
        draft.identity.gender,
        draft.identity.title,
      ]),
      contact: getSectionStatus(Object.values(draft.contact)),
      travelDocument: getSectionStatus(
        Object.values(draft.travelDocument),
        Object.values(draft.travelDocument).every((value) => value.trim().length === 0),
      ),
      preferences: getSectionStatus(Object.values(draft.preferences), true),
    }),
    [draft],
  );

  const completion = useMemo<number>(() => {
    const requiredValues = [
      draft.identity.givenName,
      draft.identity.familyName,
      draft.identity.dateOfBirth,
      draft.identity.gender,
      draft.identity.title,
      ...Object.values(draft.contact),
    ];
    const filled = requiredValues.filter((value) => value.trim().length > 0).length;
    return Math.round((filled / requiredValues.length) * 100);
  }, [draft]);

  function updateField(section: ProfileSection, field: string, value: string): void {
    setDraft((current) => ({
      ...current,
      [section]: {
        ...current[section],
        [field]: value,
      },
    }));
    setSaveState('idle');
    setErrorMessage(null);
    setValidationErrors((current) => {
      const next = { ...current };
      delete next[`${section}.${field}`];
      return next;
    });
  }

  function validateDraft(): Record<string, string> {
    const errors: Record<string, string> = {};
    const requiredFields: Array<[string, string]> = [
      ['identity.givenName', draft.identity.givenName],
      ['identity.familyName', draft.identity.familyName],
      ['identity.dateOfBirth', draft.identity.dateOfBirth],
      ['identity.gender', draft.identity.gender],
      ['identity.title', draft.identity.title],
      ['contact.email', draft.contact.email],
      ['contact.phoneCountryCode', draft.contact.phoneCountryCode],
      ['contact.phoneNumber', draft.contact.phoneNumber],
    ];

    requiredFields.forEach(([field, value]) => {
      if (!value.trim()) {
        errors[field] = 'This field is required.';
      }
    });

    const documentValues = Object.values(draft.travelDocument);
    if (documentValues.some((value) => value.trim().length > 0)) {
      const documentFields: Array<[string, string]> = [
        ['travelDocument.documentType', draft.travelDocument.documentType],
        ['travelDocument.passportNumber', draft.travelDocument.passportNumber],
        ['travelDocument.passportExpiry', draft.travelDocument.passportExpiry],
        ['travelDocument.issuingCountry', draft.travelDocument.issuingCountry],
        ['travelDocument.nationality', draft.travelDocument.nationality],
      ];

      documentFields.forEach(([field, value]) => {
        if (!value.trim()) {
          errors[field] = 'Complete the travel document or clear the section.';
        }
      });
    }

    if (draft.contact.email.trim() && !/^\S+@\S+\.\S+$/.test(draft.contact.email.trim())) {
      errors['contact.email'] = 'Enter a valid email address.';
    }

    const validateAirlineTokens = (value: string): boolean => {
      const tokens = value
        .split(',')
        .map((token) => token.trim())
        .filter((token) => token.length > 0);
      return tokens.every((token) => /^[A-Z0-9]{2,3}$/.test(token.toUpperCase()));
    };

    if (!validateAirlineTokens(draft.preferences.preferredAirlines)) {
      errors['preferences.preferredAirlines'] =
        'Airline codes must be 2-3 alphanumeric characters (e.g. VN, SQ).';
    }

    if (!validateAirlineTokens(draft.preferences.blacklistedAirlines)) {
      errors['preferences.blacklistedAirlines'] =
        'Airline codes must be 2-3 alphanumeric characters (e.g. VN, SQ).';
    }

    return errors;
  }

  async function reloadProfile(): Promise<void> {
    setSaveState('saving');
    setErrorMessage(null);

    try {
      const latestProfile = await fetchBrowserProfile();
      setProfile(latestProfile);
      setDraft(profileToDraft(latestProfile));
      setSaveState('idle');
      setShowPassport(false);
    } catch (error: unknown) {
      if (error instanceof ProfileRequestError && (error.status === 401 || error.status === 403)) {
        window.location.assign('/login?message=session_expired');
        return;
      }
      setSaveState('error');
      setErrorMessage('We could not reload the latest profile. Please try again.');
    }
  }

  async function handleSave(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const errors = validateDraft();

    if (Object.keys(errors).length > 0) {
      setValidationErrors(errors);
      setSaveState('error');
      setErrorMessage('Complete the highlighted fields before saving.');
      return;
    }

    setSaveState('saving');
    setErrorMessage(null);

    try {
      const updatedProfile = await updateBrowserProfile(draftToPayload(draft, profile.revision));
      setProfile(updatedProfile);
      setDraft(profileToDraft(updatedProfile));
      setSaveState('saved');
      setValidationErrors({});
      setShowPassport(false);
    } catch (error: unknown) {
      if (error instanceof ProfileRequestError && (error.status === 401 || error.status === 403)) {
        window.location.assign('/login?message=session_expired');
        return;
      }

      if (error instanceof ProfileRequestError && error.status === 409) {
        setSaveState('conflict');
        setErrorMessage(
          'This profile changed in another tab. Reload the latest version before saving again.',
        );
        return;
      }

      setSaveState('error');
      setErrorMessage(
        error instanceof ProfileRequestError
          ? error.message
          : 'We could not save your profile. Please try again.',
      );
    }
  }

  function handleReset(): void {
    setDraft(profileToDraft(profile));
    setSaveState('idle');
    setErrorMessage(null);
    setValidationErrors({});
    setShowPassport(false);
  }

  function renderTextField(
    section: ProfileSection,
    field: string,
    label: string,
    value: string,
    type: 'text' | 'email' | 'date' | 'tel' = 'text',
    hint?: string,
  ): JSX.Element {
    const error = validationErrors[`${section}.${field}`];

    return (
      <label className={styles.field} htmlFor={`${section}-${field}`}>
        <span className={styles.fieldLabel}>{label}</span>
        <input
          aria-describedby={
            error ? `${section}-${field}-error` : hint ? `${section}-${field}-hint` : undefined
          }
          aria-invalid={error ? true : undefined}
          className={styles.input}
          id={`${section}-${field}`}
          onChange={(event) => updateField(section, field, event.target.value)}
          type={type}
          value={value}
        />
        {error ? (
          <span className={styles.fieldError} id={`${section}-${field}-error`}>
            {error}
          </span>
        ) : null}
        {!error && hint ? (
          <span className={styles.fieldHint} id={`${section}-${field}-hint`}>
            {hint}
          </span>
        ) : null}
      </label>
    );
  }

  function renderSelectField(
    section: ProfileSection,
    field: string,
    label: string,
    value: string,
    options: SelectOption[],
  ): JSX.Element {
    const error = validationErrors[`${section}.${field}`];

    return (
      <label className={styles.field} htmlFor={`${section}-${field}`}>
        <span className={styles.fieldLabel}>{label}</span>
        <select
          aria-describedby={error ? `${section}-${field}-error` : undefined}
          aria-invalid={error ? true : undefined}
          className={styles.input}
          id={`${section}-${field}`}
          onChange={(event) => updateField(section, field, event.target.value)}
          value={value}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {error ? (
          <span className={styles.fieldError} id={`${section}-${field}-error`}>
            {error}
          </span>
        ) : null}
      </label>
    );
  }

  function renderSectionHeader(section: ProfileSection, optional = false): JSX.Element {
    const status = sectionStatuses[section];
    const statusClass = optional
      ? styles.statusComplete
      : status === 'complete'
        ? styles.statusComplete
        : styles.statusAttention;

    return (
      <div className={styles.sectionHeader}>
        <div>
          <div className={styles.sectionTitleRow}>
            <h2>{sectionLabels[section]}</h2>
            <span className={`${styles.status} ${statusClass}`}>
              {getStatusLabel(status, optional)}
            </span>
          </div>
          <p>{sectionDescriptions[section]}</p>
        </div>
      </div>
    );
  }

  const saveLabel =
    saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : 'Save profile';

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <div className={styles.workspaceBar}>
          <nav className={styles.breadcrumb} aria-label="Workspace breadcrumb">
            <span>Workspace</span>
            <span className={styles.breadcrumbSlash} aria-hidden="true">
              /
            </span>
            <strong>Traveler profile</strong>
          </nav>
          <div className={styles.contextActions} aria-label="Profile context">
            {returnTarget !== '/' ? (
              <a className={styles.backLink} href={returnTarget}>
                Back to previous workspace
              </a>
            ) : null}
            <span>Readiness workspace</span>
            <span>Owner-scoped</span>
          </div>
        </div>

        <section className={styles.hero}>
          <div>
            <p className={styles.eyebrow}>Traveler profile</p>
            <h1>Keep every detail ready for takeoff.</h1>
            <p className={styles.heroDescription}>
              Review your identity, contact, document, and travel preferences in one calm, secure
              place.
            </p>
          </div>
          <div className={styles.completionCard} aria-label={`${completion}% profile completion`}>
            <div className={styles.completionHeader}>
              <span>Profile completion</span>
              <strong>{completion}%</strong>
            </div>
            <div className={styles.progressTrack}>
              <div className={styles.progressFill} style={{ width: `${completion}%` }} />
            </div>
            <p>
              {completion === 100
                ? 'Everything is ready.'
                : 'Complete the required details before an international booking.'}
            </p>
          </div>
        </section>

        <section className={styles.signalStrip} aria-label="Profile health summary">
          <div className={styles.signalItem}>
            <span className={styles.signalLabel}>Profile health</span>
            <strong className={styles.signalValue}>{completion}% ready</strong>
            <span className={styles.signalGood}>{completion === 100 ? 'Ready' : 'On track'}</span>
          </div>
          <div className={styles.signalItem}>
            <span className={styles.signalLabel}>Revision</span>
            <strong className={styles.signalValue}>
              {String(profile.revision).padStart(2, '0')}
            </strong>
            <span className={styles.signalNeutral}>
              {saveState === 'saved' ? 'Synced' : 'Owner-scoped'}
            </span>
          </div>
          <div className={styles.signalItem}>
            <span className={styles.signalLabel}>Privacy posture</span>
            <strong className={styles.signalValue}>Private</strong>
            <span className={styles.signalGood}>Protected</span>
          </div>
        </section>

        <div className={styles.privacyNotice} role="note">
          <span className={styles.privacyIcon} aria-hidden="true">
            ✓
          </span>
          <div>
            <strong>Your information stays private.</strong>
            <span>
              Only your authenticated account can read or update this profile. Sensitive travel
              document fields are protected by the API.
            </span>
          </div>
        </div>

        {saveState === 'saved' ? (
          <div className={styles.successAlert} role="status">
            {returnTarget !== '/' ? (
              <div className={styles.successAlertContent}>
                <span>Your traveler profile is saved securely.</span>
                <a className={styles.returnResumeLink} href={returnTarget}>
                  Return and continue booking &rarr;
                </a>
              </div>
            ) : (
              'Your traveler profile is saved securely.'
            )}
          </div>
        ) : null}
        {errorMessage ? (
          <div
            className={saveState === 'conflict' ? styles.conflictAlert : styles.errorAlert}
            role="alert"
          >
            <strong>
              {saveState === 'conflict' ? 'Profile revision conflict' : 'Profile needs attention'}
            </strong>
            <span>{errorMessage}</span>
            {saveState === 'conflict' ? (
              <button className="btn-secondary" onClick={reloadProfile} type="button">
                Refresh and reload latest
              </button>
            ) : null}
          </div>
        ) : null}

        <form className={styles.form} onSubmit={handleSave}>
          <section className={styles.sectionCard}>
            {renderSectionHeader('identity')}
            <div className={styles.fieldGrid}>
              {renderSelectField('identity', 'title', 'Title', draft.identity.title, titleOptions)}
              {renderTextField('identity', 'givenName', 'Given name', draft.identity.givenName)}
              {renderTextField(
                'identity',
                'middleName',
                'Middle name',
                draft.identity.middleName,
                'text',
                'Optional',
              )}
              {renderTextField('identity', 'familyName', 'Family name', draft.identity.familyName)}
              {renderTextField(
                'identity',
                'dateOfBirth',
                'Date of birth',
                draft.identity.dateOfBirth,
                'date',
              )}
              {renderSelectField(
                'identity',
                'gender',
                'Gender',
                draft.identity.gender,
                genderOptions,
              )}
            </div>
          </section>

          <section className={styles.sectionCard}>
            {renderSectionHeader('contact')}
            <div className={styles.fieldGrid}>
              {renderTextField('contact', 'email', 'Email address', draft.contact.email, 'email')}
              <div className={`${styles.field} ${styles.phoneField}`}>
                <span className={styles.fieldLabel}>Phone number</span>
                <div className={styles.phoneControl}>
                  <label className={styles.phoneCountry} htmlFor="contact-phoneCountryCode">
                    <span className={styles.srOnly}>Phone country code</span>
                    <select
                      aria-describedby={
                        validationErrors['contact.phoneCountryCode']
                          ? 'contact-phoneCountryCode-error'
                          : undefined
                      }
                      aria-invalid={validationErrors['contact.phoneCountryCode'] ? true : undefined}
                      aria-label="Phone country code"
                      className={styles.input}
                      id="contact-phoneCountryCode"
                      onChange={(event) =>
                        updateField('contact', 'phoneCountryCode', event.target.value)
                      }
                      value={draft.contact.phoneCountryCode}
                    >
                      {phoneCountryOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={styles.phoneNumber} htmlFor="contact-phoneNumber">
                    <span className={styles.srOnly}>Phone number</span>
                    <input
                      aria-describedby={
                        validationErrors['contact.phoneNumber']
                          ? 'contact-phoneNumber-error'
                          : 'contact-phoneNumber-hint'
                      }
                      aria-invalid={validationErrors['contact.phoneNumber'] ? true : undefined}
                      aria-label="Phone number"
                      className={styles.input}
                      id="contact-phoneNumber"
                      onChange={(event) =>
                        updateField('contact', 'phoneNumber', event.target.value)
                      }
                      type="tel"
                      value={draft.contact.phoneNumber}
                    />
                  </label>
                </div>
                {validationErrors['contact.phoneCountryCode'] ? (
                  <span className={styles.fieldError} id="contact-phoneCountryCode-error">
                    {validationErrors['contact.phoneCountryCode']}
                  </span>
                ) : null}
                {validationErrors['contact.phoneNumber'] ? (
                  <span className={styles.fieldError} id="contact-phoneNumber-error">
                    {validationErrors['contact.phoneNumber']}
                  </span>
                ) : (
                  <span className={styles.fieldHint} id="contact-phoneNumber-hint">
                    Required for booking updates
                  </span>
                )}
              </div>
            </div>
          </section>

          <section className={`${styles.sectionCard} ${styles.documentSection}`}>
            {renderSectionHeader(
              'travelDocument',
              Object.values(draft.travelDocument).every((value) => value.trim().length === 0),
            )}
            <div className={styles.documentSummary}>
              <div>
                <span>Saved document</span>
                <strong>
                  {draft.travelDocument.documentType === 'passport'
                    ? 'Passport'
                    : 'Travel document'}
                </strong>
              </div>
              <div>
                <span>Number</span>
                <strong>{getMaskedPassport(draft.travelDocument.passportNumber)}</strong>
              </div>
              <div>
                <span>Issuing country</span>
                <strong>{draft.travelDocument.issuingCountry || 'Not added'}</strong>
              </div>
              <span className={styles.secureLabel}>Protected field</span>
            </div>
            <div className={styles.fieldGrid}>
              {renderSelectField(
                'travelDocument',
                'documentType',
                'Document type',
                draft.travelDocument.documentType,
                documentOptions,
              )}
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="travelDocument-passportNumber">
                  Passport number
                </label>
                <div className={styles.passwordControl}>
                  <input
                    aria-describedby={
                      validationErrors['travelDocument.passportNumber']
                        ? 'travelDocument-passportNumber-error'
                        : 'travelDocument-passportNumber-hint'
                    }
                    aria-invalid={
                      validationErrors['travelDocument.passportNumber'] ? true : undefined
                    }
                    className={styles.input}
                    id="travelDocument-passportNumber"
                    onChange={(event) =>
                      updateField('travelDocument', 'passportNumber', event.target.value)
                    }
                    type={showPassport ? 'text' : 'password'}
                    value={draft.travelDocument.passportNumber}
                  />
                  <button
                    aria-label={showPassport ? 'Hide passport number' : 'Show passport number'}
                    className={styles.showButton}
                    onClick={() => setShowPassport((current) => !current)}
                    type="button"
                  >
                    {showPassport ? 'Hide' : 'Show'}
                  </button>
                </div>
                {validationErrors['travelDocument.passportNumber'] ? (
                  <span className={styles.fieldError} id="travelDocument-passportNumber-error">
                    {validationErrors['travelDocument.passportNumber']}
                  </span>
                ) : (
                  <span className={styles.fieldHint} id="travelDocument-passportNumber-hint">
                    Visible only while you are editing this secure field.
                  </span>
                )}
              </div>
              {renderTextField(
                'travelDocument',
                'passportExpiry',
                'Passport expiry',
                draft.travelDocument.passportExpiry,
                'date',
              )}
              {renderSelectField(
                'travelDocument',
                'issuingCountry',
                'Issuing country',
                draft.travelDocument.issuingCountry,
                countryOptions,
              )}
              {renderSelectField(
                'travelDocument',
                'nationality',
                'Nationality',
                draft.travelDocument.nationality,
                countryOptions,
              )}
            </div>
            <div className={styles.documentCallout} role="note">
              <strong>International trip?</strong>
              <span>
                Passport validity is checked again at booking time. Completing this section does not
                guarantee booking readiness.
              </span>
            </div>
          </section>

          <section className={styles.sectionCard}>
            {renderSectionHeader('preferences', true)}
            <div className={styles.fieldGrid}>
              {renderSelectField(
                'preferences',
                'seatPreference',
                'Seat preference',
                draft.preferences.seatPreference,
                seatOptions,
              )}
              {renderSelectField(
                'preferences',
                'classPreference',
                'Cabin preference',
                draft.preferences.classPreference,
                classOptions,
              )}
              {renderSelectField(
                'preferences',
                'maxStops',
                'Max stops',
                draft.preferences.maxStops,
                maxStopsOptions,
              )}
              {renderSelectField(
                'preferences',
                'priceSensitivity',
                'Price sensitivity',
                draft.preferences.priceSensitivity,
                priceSensitivityOptions,
              )}
              {renderSelectField(
                'preferences',
                'requiresCheckedBaggage',
                'Baggage preference',
                draft.preferences.requiresCheckedBaggage,
                baggageOptions,
              )}
              {renderTextField(
                'preferences',
                'preferredAirlines',
                'Preferred airlines',
                draft.preferences.preferredAirlines,
                'text',
                'Comma-delimited airline codes, such as VN, SQ',
              )}
              {renderTextField(
                'preferences',
                'blacklistedAirlines',
                'Blacklisted airlines',
                draft.preferences.blacklistedAirlines,
                'text',
                'Comma-delimited airline codes, such as AA, 9W',
              )}
              {renderSelectField(
                'preferences',
                'preferredDepartureStart',
                'Preferred departure start',
                draft.preferences.preferredDepartureStart,
                hourOptions,
              )}
              {renderSelectField(
                'preferences',
                'preferredDepartureEnd',
                'Preferred departure end',
                draft.preferences.preferredDepartureEnd,
                hourOptions,
              )}
              {renderSelectField(
                'preferences',
                'preferredArrivalStart',
                'Preferred arrival start',
                draft.preferences.preferredArrivalStart,
                hourOptions,
              )}
              {renderSelectField(
                'preferences',
                'preferredArrivalEnd',
                'Preferred arrival end',
                draft.preferences.preferredArrivalEnd,
                hourOptions,
              )}
            </div>
          </section>

          <div className={styles.actions}>
            <div>
              <strong>Revision {profile.revision}</strong>
              <span>
                {profile.updatedAt
                  ? `Last updated ${new Date(profile.updatedAt).toLocaleString()}`
                  : 'Not saved yet'}
              </span>
            </div>
            <div className={styles.actionButtons}>
              <button
                className="btn-secondary"
                disabled={saveState === 'saving'}
                onClick={handleReset}
                type="button"
              >
                Discard changes
              </button>
              <button className="btn-primary" disabled={saveState === 'saving'} type="submit">
                {saveLabel}
              </button>
            </div>
          </div>
        </form>

        <p className={styles.footerNote}>
          Changes are saved to your private traveler profile and can be reused during booking.
        </p>
      </div>
    </main>
  );
}
